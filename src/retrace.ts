import * as fs from 'fs';
import * as path from 'path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

// Handles both formats:
//   at FunctionName (file.js:line:col)
//   at file.js:line:col
const FRAME_RE = /^\s+at\s+(?:(.*?)\s+\((.+?\.m?js):(\d+):(\d+)\)|(.+?\.m?js):(\d+):(\d+))\s*$/;

const mapCache = new Map<string, TraceMap | null>();

function loadMap(mapPath: string): TraceMap | null {
  try {
    return new TraceMap(fs.readFileSync(mapPath, 'utf-8'));
  } catch {
    return null;
  }
}

function findMap(jsRef: string, sourcemapDir: string): TraceMap | null {
  const basename = path.basename(jsRef);
  const cacheKey = `${sourcemapDir}::${basename}`;
  if (mapCache.has(cacheKey)) return mapCache.get(cacheKey) ?? null;

  const candidates = [
    path.join(sourcemapDir, basename + '.map'),
    path.join(sourcemapDir, basename.replace(/\.js$/, '.js.map')),
    jsRef + '.map',
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

  const lines = stackTrace.split('\n');
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
        const displayName = pos.name ?? fnName ?? '<anonymous>';
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
  return [summary, ...output].join('\n');
}

export function normalizeBundlerPath(
  rawPath: string,
  projectRoot?: string,
  sourceRoot?: string,
): string {
  let cleaned = rawPath;

  // 1. Strip protocol prefixes (e.g. webpack://, ng://, deno://, etc.)
  const protocolMatch = /^([a-z0-9+-.]+):\/\/(.*)$/i.exec(cleaned);
  if (protocolMatch) {
    const protocol = protocolMatch[1];
    const rest = protocolMatch[2];
    cleaned = rest;
    if (protocol.toLowerCase() === 'webpack') {
      if (cleaned.startsWith('/')) {
        cleaned = cleaned.slice(1);
      } else {
        const parts = cleaned.split('/');
        if (parts.length > 1) {
          if (parts[1] === '.') {
            cleaned = parts.slice(2).join('/');
          } else {
            cleaned = parts.slice(1).join('/');
          }
        }
      }
    }
  }

  // 2. Strip Vite-specific prefix /@fs/
  if (cleaned.startsWith('/@fs/')) {
    cleaned = cleaned.slice(4); // Keep the leading slash to make it an absolute path
  }

  // 3. Resolve relative traversals using sourceRoot or projectRoot
  if (sourceRoot) {
    cleaned = path.join(sourceRoot, cleaned);
  }

  if (projectRoot && !path.isAbsolute(cleaned)) {
    cleaned = path.resolve(projectRoot, cleaned);
  }

  return path.normalize(cleaned);
}

export async function retrieveCodeContext(
  originalFile: string,
  line: number,
  column: number,
  contextLines: number,
  projectRoot?: string,
  sourceRoot?: string,
): Promise<string> {
  const normalizedFile = normalizeBundlerPath(
    originalFile,
    projectRoot || process.cwd(),
    sourceRoot,
  );
  if (!fs.existsSync(normalizedFile)) {
    return `Error: file not found: ${originalFile} (normalized: ${normalizedFile})`;
  }

  const allLines = fs.readFileSync(normalizedFile, 'utf-8').split('\n');
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
    const marker = i === targetIdx ? '>' : ' ';
    body.push(`${marker} ${lineNum} │ ${allLines[i]}`);
    if (i === targetIdx && column > 0) {
      const indent = ' '.repeat(8 + column);
      body.push(`        │ ${indent}^`);
    }
  }

  return [...header, ...body].join('\n');
}

function collectJsFiles(dir: string, _root: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full, _root));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js.map')) {
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
    const mapPath = jsPath + '.map';

    if (!fs.existsSync(mapPath)) {
      rows.push(`  ✗ ${relPath} — no .map file`);
      missingMaps++;
      continue;
    }

    let parsed: { sources?: string[] } | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as { sources?: string[] };
    } catch {
      rows.push(`  ✗ ${relPath} — .map file is invalid JSON`);
      brokenSources++;
      continue;
    }

    const sources = parsed.sources ?? [];
    const mapDir = path.dirname(mapPath);
    const missing = sources.filter((s) => {
      if (!s || s.startsWith('webpack://') || s.startsWith('node_modules/')) return false;
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

  return lines.join('\n');
}

function getJsDebugId(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    const bytesToRead = Math.min(size, 4096);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, size - bytesToRead));
    fs.closeSync(fd);
    const content = buffer.toString('utf-8');
    const match = /(?:\/\/|#)\s*debugId\s*=\s*([0-9a-fA-F-]+)/i.exec(content);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function getMapDebugId(mapPath: string): string | null {
  try {
    const content = fs.readFileSync(mapPath, 'utf-8');
    const parsed = JSON.parse(content) as { debugId?: string };
    return parsed.debugId ? String(parsed.debugId).toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function verifyDebugIdIntegrity(
  jsPath: string,
  mapPath: string,
): Promise<{
  js_debug_id: string | null;
  map_debug_id: string | null;
  ids_match: boolean;
  verdict: 'VALID' | 'STALE' | 'NO_DEBUG_ID';
}> {
  if (!fs.existsSync(jsPath)) {
    throw new Error(`JS file not found: ${jsPath}`);
  }
  if (!fs.existsSync(mapPath)) {
    throw new Error(`Map file not found: ${mapPath}`);
  }

  const jsId = getJsDebugId(jsPath);
  const mapId = getMapDebugId(mapPath);

  if (!jsId || !mapId) {
    return {
      js_debug_id: jsId,
      map_debug_id: mapId,
      ids_match: false,
      verdict: 'NO_DEBUG_ID',
    };
  }

  const match = jsId === mapId;
  return {
    js_debug_id: jsId,
    map_debug_id: mapId,
    ids_match: match,
    verdict: match ? 'VALID' : 'STALE',
  };
}

export interface TelemetryFrame {
  file: string;
  line: number;
  column: number;
  functionName: string | null;
  inApp: boolean;
}

export interface RetracedTelemetryFrame {
  original_file: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  in_app: boolean;
  source_line: string | null;
}

export interface IngestResult {
  platform_detected: 'sentry' | 'bugsnag' | 'datadog' | 'unknown';
  frames_found: number;
  retraced_frames: RetracedTelemetryFrame[];
}

export async function ingestTelemetryPayload(
  payloadStr: string,
  sourcemapDir: string,
  inAppOnly = false,
): Promise<IngestResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch (err) {
    throw new Error(`Invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`);
  }

  let platform: 'sentry' | 'bugsnag' | 'datadog' | 'unknown' = 'unknown';
  let extractedFrames: TelemetryFrame[] = [];

  // 1. Detect Sentry
  const exceptionValues = payload.exception?.values || payload.values;
  if (Array.isArray(exceptionValues)) {
    platform = 'sentry';
    for (const value of exceptionValues) {
      const frames = value.stacktrace?.frames;
      if (Array.isArray(frames)) {
        for (const f of frames) {
          if (f.filename && f.lineno !== undefined) {
            extractedFrames.push({
              file: String(f.filename),
              line: Number(f.lineno),
              column: Number(f.colno ?? 0),
              functionName: f.function ? String(f.function) : null,
              inApp: f.in_app !== false,
            });
          }
        }
      }
    }
  } else if (payload.stacktrace?.frames) {
    platform = 'sentry';
    const frames = payload.stacktrace.frames;
    if (Array.isArray(frames)) {
      for (const f of frames) {
        if (f.filename && f.lineno !== undefined) {
          extractedFrames.push({
            file: String(f.filename),
            line: Number(f.lineno),
            column: Number(f.colno ?? 0),
            functionName: f.function ? String(f.function) : null,
            inApp: f.in_app !== false,
          });
        }
      }
    }
  }

  // 2. Detect Bugsnag
  if (platform === 'unknown' && Array.isArray(payload.events)) {
    for (const event of payload.events) {
      const exceptions = event.exceptions;
      if (Array.isArray(exceptions)) {
        platform = 'bugsnag';
        for (const ex of exceptions) {
          const stack = ex.stacktrace;
          if (Array.isArray(stack)) {
            for (const f of stack) {
              if (f.file && f.lineNumber !== undefined) {
                extractedFrames.push({
                  file: String(f.file),
                  line: Number(f.lineNumber),
                  column: Number(f.columnNumber ?? 0),
                  functionName: f.method ? String(f.method) : null,
                  inApp: f.inProject !== false,
                });
              }
            }
          }
        }
      }
    }
  }

  // 3. Detect Datadog / Stack String
  if (platform === 'unknown') {
    const stackStr =
      payload.error?.stack || payload.stack || (typeof payload === 'string' ? payload : null);
    if (typeof stackStr === 'string') {
      platform = 'datadog';
      const lines = stackStr.split('\n');
      for (const line of lines) {
        const match = FRAME_RE.exec(line);
        if (match) {
          const fnName = match[1]?.trim() || null;
          const jsRef = (match[2] ?? match[5])!;
          const lineNum = parseInt(match[3] ?? match[6]!, 10);
          const colNum = parseInt(match[4] ?? match[7]!, 10);
          extractedFrames.push({
            file: jsRef,
            line: lineNum,
            column: colNum,
            functionName: fnName,
            inApp: true,
          });
        }
      }
    }
  }

  if (inAppOnly) {
    extractedFrames = extractedFrames.filter((f) => f.inApp);
  }

  const retracedFrames: RetracedTelemetryFrame[] = [];
  for (const frame of extractedFrames) {
    const traceMap = findMap(frame.file, sourcemapDir);
    if (!traceMap) {
      retracedFrames.push({
        original_file: frame.file,
        line: frame.line,
        column: frame.column,
        name: frame.functionName,
        in_app: frame.inApp,
        source_line: null,
      });
      continue;
    }

    try {
      const pos = originalPositionFor(traceMap, { line: frame.line, column: frame.column });
      if (pos.source !== null) {
        let sourceLine: string | null = null;
        const normalizedFile = normalizeBundlerPath(pos.source, process.cwd());
        if (fs.existsSync(normalizedFile)) {
          try {
            const fileLines = fs.readFileSync(normalizedFile, 'utf-8').split('\n');
            if (pos.line !== null && pos.line > 0 && pos.line <= fileLines.length) {
              sourceLine = fileLines[pos.line - 1].trim();
            }
          } catch {
            // Ignore if source file cannot be read
          }
        }
        retracedFrames.push({
          original_file: pos.source,
          line: pos.line,
          column: pos.column,
          name: pos.name ?? frame.functionName,
          in_app: frame.inApp,
          source_line: sourceLine,
        });
      } else {
        retracedFrames.push({
          original_file: frame.file,
          line: frame.line,
          column: frame.column,
          name: frame.functionName,
          in_app: frame.inApp,
          source_line: null,
        });
      }
    } catch {
      retracedFrames.push({
        original_file: frame.file,
        line: frame.line,
        column: frame.column,
        name: frame.functionName,
        in_app: frame.inApp,
        source_line: null,
      });
    }
  }

  return {
    platform_detected: platform,
    frames_found: extractedFrames.length,
    retraced_frames: retracedFrames,
  };
}

function isAsyncBoundary(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower.includes('async') ||
    lower.includes('await') ||
    lower.includes('promise.then') ||
    lower.includes('processticksandmicrotasks') ||
    lower.includes('nexttick')
  );
}

export interface AsyncCausalityResult {
  crash_frame: {
    file: string | null;
    line: number | null;
    column: number | null;
    name: string | null;
    source_line: string | null;
  } | null;
  async_boundary_detected: boolean;
  async_origin_frame: {
    file: string | null;
    line: number | null;
    column: number | null;
    name: string | null;
    source_line: string | null;
  } | null;
  boundary_type: 'await' | 'promise_then' | 'nexttick' | 'other' | null;
}

export async function surfaceAsyncCausality(
  stackTrace: string,
  sourcemapDir: string,
): Promise<AsyncCausalityResult> {
  const lines = stackTrace.split('\n');
  const parsedFrames: Array<{
    file: string;
    line: number;
    column: number;
    name: string | null;
    isBoundary: boolean;
    rawLine: string;
  }> = [];

  for (const line of lines) {
    const match = FRAME_RE.exec(line);
    if (match) {
      const fnName = match[1]?.trim() || null;
      const jsRef = (match[2] ?? match[5])!;
      const lineNum = parseInt(match[3] ?? match[6]!, 10);
      const colNum = parseInt(match[4] ?? match[7]!, 10);
      const isBoundary = isAsyncBoundary(line);
      parsedFrames.push({
        file: jsRef,
        line: lineNum,
        column: colNum,
        name: fnName,
        isBoundary,
        rawLine: line,
      });
    } else if (isAsyncBoundary(line)) {
      parsedFrames.push({
        file: '',
        line: 0,
        column: 0,
        name: null,
        isBoundary: true,
        rawLine: line,
      });
    }
  }

  if (parsedFrames.length === 0) {
    return {
      crash_frame: null,
      async_boundary_detected: false,
      async_origin_frame: null,
      boundary_type: null,
    };
  }

  const firstCrashFrameIndex = parsedFrames.findIndex((f) => !f.isBoundary);
  const crashFrameRaw = firstCrashFrameIndex >= 0 ? parsedFrames[firstCrashFrameIndex] : null;

  const asyncBoundaryIndex = parsedFrames.findIndex((f) => f.isBoundary);
  let asyncOriginRaw: (typeof parsedFrames)[0] | null = null;
  let boundaryType: 'await' | 'promise_then' | 'nexttick' | 'other' | null = null;

  if (asyncBoundaryIndex >= 0) {
    const originIndex = parsedFrames.findIndex(
      (f, idx) => idx > asyncBoundaryIndex && !f.isBoundary,
    );
    if (originIndex >= 0) {
      asyncOriginRaw = parsedFrames[originIndex];
    }

    const boundaryLine = parsedFrames[asyncBoundaryIndex].rawLine.toLowerCase();
    if (boundaryLine.includes('promise.then')) {
      boundaryType = 'promise_then';
    } else if (boundaryLine.includes('ticks') || boundaryLine.includes('nexttick')) {
      boundaryType = 'nexttick';
    } else if (boundaryLine.includes('await') || boundaryLine.includes('async')) {
      boundaryType = 'await';
    } else {
      boundaryType = 'other';
    }
  }

  const mapFrame = (rawFrame: (typeof parsedFrames)[0] | null) => {
    if (!rawFrame || !rawFrame.file) return null;
    const traceMap = findMap(rawFrame.file, sourcemapDir);
    if (!traceMap) {
      return {
        file: rawFrame.file,
        line: rawFrame.line,
        column: rawFrame.column,
        name: rawFrame.name,
        source_line: null,
      };
    }

    try {
      const pos = originalPositionFor(traceMap, { line: rawFrame.line, column: rawFrame.column });
      if (pos.source !== null) {
        let sourceLine: string | null = null;
        const normalizedFile = normalizeBundlerPath(pos.source, process.cwd());
        if (fs.existsSync(normalizedFile)) {
          try {
            const fileLines = fs.readFileSync(normalizedFile, 'utf-8').split('\n');
            if (pos.line !== null && pos.line > 0 && pos.line <= fileLines.length) {
              sourceLine = fileLines[pos.line - 1].trim();
            }
          } catch {
            // Ignore if source file cannot be read
          }
        }
        return {
          file: pos.source,
          line: pos.line,
          column: pos.column,
          name: pos.name ?? rawFrame.name,
          source_line: sourceLine,
        };
      }
    } catch {
      // Ignore if positioning failed
    }

    return {
      file: rawFrame.file,
      line: rawFrame.line,
      column: rawFrame.column,
      name: rawFrame.name,
      source_line: null,
    };
  };

  return {
    crash_frame: mapFrame(crashFrameRaw),
    async_boundary_detected: asyncBoundaryIndex >= 0,
    async_origin_frame: mapFrame(asyncOriginRaw),
    boundary_type: boundaryType,
  };
}
