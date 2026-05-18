import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { retraceStack, retrieveCodeContext, auditSourcemapMatch } from '../src/retrace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TSC_BIN = path.resolve(__dirname, '../node_modules/.bin/tsc');

let testDir: string;
let srcDir: string;
let distDir: string;
let authTsPath: string;
let authJsPath: string;

// Source file with predictable structure — line numbers matter for tests
const AUTH_SOURCE = [
  `export function validateToken(token: string): string {`,
  `  if (!token) {`,
  `    throw new Error("token required");`,
  `  }`,
  `  return token.toUpperCase();`,
  `}`,
  ``,
  `export function parseUser(data: unknown) {`,
  `  const user = data as { id: string };`,
  `  return user.id;`,
  `}`,
].join('\n');

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemap-retrace-test-'));
  srcDir = path.join(testDir, 'src');
  distDir = path.join(testDir, 'dist');
  fs.mkdirSync(srcDir);

  authTsPath = path.join(srcDir, 'auth.ts');
  authJsPath = path.join(distDir, 'auth.js');

  fs.writeFileSync(authTsPath, AUTH_SOURCE);

  fs.writeFileSync(
    path.join(testDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        outDir: 'dist',
        rootDir: 'src',
        sourceMap: true,
        declaration: false,
      },
      include: ['src'],
    }),
  );

  execSync(`"${TSC_BIN}" --project tsconfig.json`, { cwd: testDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

// Helper: find a real (line, col) in compiled JS where a token appears
function findInCompiled(token: string): { line: number; col: number } {
  const lines = fs.readFileSync(authJsPath, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i].indexOf(token);
    if (col >= 0) return { line: i + 1, col };
  }
  throw new Error(`Token "${token}" not found in compiled output`);
}

describe('retraceStack', () => {
  it('maps a compiled frame back to original TypeScript source', async () => {
    const { line, col } = findInCompiled('validateToken');

    const stackTrace = [
      'Error: token required',
      `    at validateToken (${authJsPath}:${line}:${col})`,
      `    at processQueue (${authJsPath}:${line}:${col + 5})`,
    ].join('\n');

    const result = await retraceStack(stackTrace, distDir);

    expect(result).toContain('auth.ts');
    const match = result.match(/Frames mapped: (\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThan(0);
  });

  it('passes through non-JS frames (node internals, error header) unchanged', async () => {
    const stackTrace = [
      'TypeError: Cannot read properties of undefined',
      '    at Module._compile (node:internal/modules/cjs/loader:1376:14)',
      '    at processTicksAndMicrotasks (node:internal/process/task_queues:105:5)',
    ].join('\n');

    const result = await retraceStack(stackTrace, distDir);
    // node:internal frames don't match JS frame regex — passed through, not counted as unmapped
    expect(result).toContain('Frames mapped: 0');
    expect(result).toContain('node:internal');
  });

  it('handles basename-only references by searching sourcemapDir', async () => {
    const { line, col } = findInCompiled('validateToken');
    // Use just basename, not full path — common in browser stack traces
    const stackTrace = [`Error: x`, `    at f (auth.js:${line}:${col})`].join('\n');

    const result = await retraceStack(stackTrace, distDir);
    expect(result).toContain('auth.ts');
  });

  it('returns error for missing sourcemap directory', async () => {
    const result = await retraceStack('Error\n    at f (main.js:1:1)', '/tmp/no-such-dir-xyz');
    expect(result).toContain('Error: sourcemap directory not found');
  });

  it('leaves frames unchanged when no map file is found', async () => {
    const stackTrace = 'Error\n    at f (unknown-bundle.js:1:100)';
    const result = await retraceStack(stackTrace, distDir);
    expect(result).toContain('unknown-bundle.js:1:100');
    expect(result).toContain('Unmapped: 1');
  });
});

describe('retrieveCodeContext', () => {
  it('shows the target line with surrounding context', async () => {
    // validateToken is on line 1 of auth.ts
    const result = await retrieveCodeContext(authTsPath, 1, 0, 3);
    expect(result).toContain('Code Context');
    expect(result).toContain('auth.ts');
    expect(result).toContain('validateToken');
    expect(result).toContain('> ');
  });

  it('shows column pointer when column > 0', async () => {
    const result = await retrieveCodeContext(authTsPath, 3, 4, 2);
    expect(result).toContain('^');
  });

  it('returns error for missing file', async () => {
    const result = await retrieveCodeContext('/tmp/no-such-file.ts', 1, 0, 3);
    expect(result).toContain('Error: file not found');
  });

  it('returns error for out-of-range line', async () => {
    const result = await retrieveCodeContext(authTsPath, 999, 0, 3);
    expect(result).toContain('Error: line 999 out of range');
  });

  it('clamps context to file boundaries without crashing', async () => {
    // Line 1 with 10 context lines — should not go below line 1
    const result = await retrieveCodeContext(authTsPath, 1, 0, 10);
    expect(result).toContain('validateToken');
    expect(result).not.toContain('Error:');
  });
});

describe('auditSourcemapMatch', () => {
  it('reports OK for a correctly compiled dist directory', async () => {
    const result = await auditSourcemapMatch(distDir);
    expect(result).toContain('Sourcemap Audit');
    expect(result).toContain('auth.js');
    expect(result).toContain('✓');
  });

  it('flags JS files without a .map file', async () => {
    const noMapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-map-'));
    fs.writeFileSync(path.join(noMapDir, 'bundle.js'), 'function f(){}');
    const result = await auditSourcemapMatch(noMapDir);
    expect(result).toContain('✗');
    expect(result).toContain('no .map file');
    fs.rmSync(noMapDir, { recursive: true, force: true });
  });

  it('flags broken source references in map file', async () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-map-'));
    fs.writeFileSync(path.join(brokenDir, 'bundle.js'), 'function f(){}');
    fs.writeFileSync(
      path.join(brokenDir, 'bundle.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../src/does-not-exist.ts'],
        mappings: 'AAAA',
        names: [],
      }),
    );
    const result = await auditSourcemapMatch(brokenDir);
    expect(result).toContain('⚠');
    expect(result).toContain('does-not-exist.ts');
    fs.rmSync(brokenDir, { recursive: true, force: true });
  });

  it('returns error for missing directory', async () => {
    const result = await auditSourcemapMatch('/tmp/no-such-dir-xyz');
    expect(result).toContain('Error: directory not found');
  });

  it('handles empty directory gracefully', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-dist-'));
    const result = await auditSourcemapMatch(emptyDir);
    expect(result).toContain('No .js files found');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
