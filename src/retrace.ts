import * as fs from "fs";
import * as path from "path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

// Handles both formats:
//   at FunctionName (file.js:line:col)
//   at file.js:line:col
const FRAME_RE = /^\s+at\s+(?:(.*?)\s+\((.+?\.m?js):(\d+):(\d+)\)|(.+?\.m?js):(\d+):(\d+))\s*$/;

const mapCache = new Map<string, TraceMap | null>();

function loadMap(mapPath: string): TraceMap | null {
  try {
    return new TraceMap(fs.readFileSync(mapPath, "utf-8"));
  } catch {
    return null;
  }
}

function findMap(jsRef: string, sourcemapDir: string): TraceMap | null {
  const basename = path.basename(jsRef);
  const cacheKey = `${sourcemapDir}::${basename}`;
  if (mapCache.has(cacheKey)) return mapCache.get(cacheKey) ?? null;

  const candidates = [
    path.join(sourcemapDir, basename + ".map"),
    path.join(sourcemapDir, basename.replace(/\.js$/, ".js.map")),
    jsRef + ".map",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const result = loadMap(candidate);
      mapCache.set(cacheKey, result);
      return result;
    }
  }

  mapCache.set(cacheKey, null);
  return null;
}

export async function retraceStack(stackTrace: string, sourcemapDir: string): Promise<string> {
  if (!fs.existsSync(sourcemapDir)) {
    return `Error: sourcemap directory not found: ${sourcemapDir}`;
  }

  const lines = stackTrace.split("\n");
  const output: string[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;

  for (const line of lines) {
    const match = FRAME_RE.exec(line);
    if (!match) {
      output.push(line);
      continue;
    }

    const fnName = match[1]?.trim() || null;
    const jsRef = (match[2] ?? match[5])!;
    const lineNum = parseInt(match[3] ?? match[6]!, 10);
    const colNum = parseInt(match[4] ?? match[7]!, 10);

    const traceMap = findMap(jsRef, sourcemapDir);
    if (!traceMap) {
      output.push(line);
      unmappedCount++;
      continue;
    }

    try {
      const pos = originalPositionFor(traceMap, { line: lineNum, column: colNum });
      if (pos.source !== null) {
        const displayName = pos.name ?? fnName ?? "<anonymous>";
        output.push(`    at ${displayName} (${pos.source}:${pos.line}:${pos.column})`);
        mappedCount++;
      } else {
        output.push(line);
        unmappedCount++;
      }
    } catch {
      output.push(line);
      unmappedCount++;
    }
  }

  const summary = `Retrace Results\n  Frames mapped: ${mappedCount}  |  Unmapped: ${unmappedCount}\n`;
  return [summary, ...output].join("\n");
}

export async function retrieveCodeContext(
  originalFile: string,
  line: number,
  column: number,
  contextLines: number,
): Promise<string> {
  if (!fs.existsSync(originalFile)) {
    return `Error: file not found: ${originalFile}`;
  }

  const allLines = fs.readFileSync(originalFile, "utf-8").split("\n");
  const targetIdx = line - 1;

  if (targetIdx < 0 || targetIdx >= allLines.length) {
    return `Error: line ${line} out of range (file has ${allLines.length} lines)`;
  }

  const start = Math.max(0, targetIdx - contextLines);
  const end = Math.min(allLines.length - 1, targetIdx + contextLines);

  const header = [
    `Code Context`,
    `  File: ${originalFile}`,
    `  Target: line ${line}, column ${column}`,
    ``,
  ];

  const body: string[] = [];
  for (let i = start; i <= end; i++) {
    const lineNum = String(i + 1).padStart(5);
    const marker = i === targetIdx ? ">" : " ";
    body.push(`${marker} ${lineNum} │ ${allLines[i]}`);
    if (i === targetIdx && column > 0) {
      const indent = " ".repeat(8 + column);
      body.push(`        │ ${indent}^`);
    }
  }

  return [...header, ...body].join("\n");
}

function collectJsFiles(dir: string, _root: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full, _root));
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".min.js.map")) {
      results.push(full);
    }
  }
  return results;
}

export async function auditSourcemapMatch(distDir: string): Promise<string> {
  if (!fs.existsSync(distDir)) {
    return `Error: directory not found: ${distDir}`;
  }

  const jsFiles = collectJsFiles(distDir, distDir);

  if (jsFiles.length === 0) {
    return `Sourcemap Audit\n  Directory: ${distDir}\n\n  No .js files found.`;
  }

  const rows: string[] = [];
  let missingMaps = 0;
  let brokenSources = 0;
  let ok = 0;

  for (const jsPath of jsFiles) {
    const relPath = path.relative(distDir, jsPath);
    const mapPath = jsPath + ".map";

    if (!fs.existsSync(mapPath)) {
      rows.push(`  ✗ ${relPath} — no .map file`);
      missingMaps++;
      continue;
    }

    let parsed: { sources?: string[] } | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(mapPath, "utf-8")) as { sources?: string[] };
    } catch {
      rows.push(`  ✗ ${relPath} — .map file is invalid JSON`);
      brokenSources++;
      continue;
    }

    const sources = parsed.sources ?? [];
    const mapDir = path.dirname(mapPath);
    const missing = sources.filter((s) => {
      if (!s || s.startsWith("webpack://") || s.startsWith("node_modules/")) return false;
      const resolved = path.resolve(mapDir, s);
      return !fs.existsSync(resolved);
    });

    if (missing.length > 0) {
      rows.push(`  ⚠ ${relPath} — ${missing.length} source(s) not found on disk:`);
      missing.slice(0, 3).forEach((s) => rows.push(`      ${s}`));
      if (missing.length > 3) rows.push(`      ... and ${missing.length - 3} more`);
      brokenSources++;
    } else {
      rows.push(`  ✓ ${relPath} — ${sources.length} source(s) mapped`);
      ok++;
    }
  }

  const lines = [
    `Sourcemap Audit`,
    `  Directory: ${distDir}`,
    `  Files checked: ${jsFiles.length}`,
    `  OK: ${ok}  |  Missing maps: ${missingMaps}  |  Broken sources: ${brokenSources}`,
    ``,
    ...rows,
  ];

  return lines.join("\n");
}
