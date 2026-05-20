import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  verifyDebugIdIntegrity,
  normalizeBundlerPath,
  retrieveCodeContext,
  ingestTelemetryPayload,
  surfaceAsyncCausality,
} from '../src/retrace.js';

let testDir: string;
let jsWithId: string;
let mapWithId: string;
let jsNoId: string;
let mapNoId: string;
let jsMismatchId: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcemap-v2-test-'));

  // 1. Create JS/Map files with Debug IDs
  jsWithId = path.join(testDir, 'bundle-ok.js');
  mapWithId = path.join(testDir, 'bundle-ok.js.map');
  fs.writeFileSync(
    jsWithId,
    `function add(a,b){return a+b}\n//# debugId=12345678-1234-1234-1234-1234567890ab\n`,
  );
  fs.writeFileSync(
    mapWithId,
    JSON.stringify({
      version: 3,
      file: 'bundle-ok.js',
      sources: ['src/math.ts'],
      mappings: 'AAAA',
      debugId: '12345678-1234-1234-1234-1234567890ab',
    }),
  );

  // 2. Create JS/Map files with missing Debug IDs
  jsNoId = path.join(testDir, 'bundle-no-id.js');
  mapNoId = path.join(testDir, 'bundle-no-id.js.map');
  fs.writeFileSync(jsNoId, `function add(a,b){return a+b}\n`);
  fs.writeFileSync(
    mapNoId,
    JSON.stringify({
      version: 3,
      file: 'bundle-no-id.js',
      sources: ['src/math.ts'],
      mappings: 'AAAA',
    }),
  );

  // 3. Create mismatching JS file
  jsMismatchId = path.join(testDir, 'bundle-mismatch.js');
  fs.writeFileSync(
    jsMismatchId,
    `function add(a,b){return a+b}\n//# debugId=87654321-4321-4321-4321-ba0987654321\n`,
  );
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('normalizeBundlerPath', () => {
  it('handles webpack path schemas', () => {
    const raw = 'webpack://my-app/./src/components/Button.tsx';
    const result = normalizeBundlerPath(raw);
    expect(result).toBe('src/components/Button.tsx');
  });

  it('handles webpack path schemas with relative prefix', () => {
    const raw = 'webpack:///src/index.ts';
    const result = normalizeBundlerPath(raw);
    expect(result).toBe('src/index.ts');
  });

  it('handles Vite /@fs/ path prefix', () => {
    const raw = '/@fs/Users/albertdev/project/src/main.ts';
    const result = normalizeBundlerPath(raw);
    expect(result).toBe('/Users/albertdev/project/src/main.ts');
  });

  it('resolves relative paths against projectRoot', () => {
    const raw = 'src/index.ts';
    const root = '/Users/albertdev/project';
    const result = normalizeBundlerPath(raw, root);
    expect(result).toBe('/Users/albertdev/project/src/index.ts');
  });
});

describe('verifyDebugIdIntegrity', () => {
  it('identifies matching Debug IDs as VALID', async () => {
    const res = await verifyDebugIdIntegrity(jsWithId, mapWithId);
    expect(res.ids_match).toBe(true);
    expect(res.verdict).toBe('VALID');
    expect(res.js_debug_id).toBe('12345678-1234-1234-1234-1234567890ab');
    expect(res.map_debug_id).toBe('12345678-1234-1234-1234-1234567890ab');
  });

  it('identifies mismatched Debug IDs as STALE', async () => {
    const res = await verifyDebugIdIntegrity(jsMismatchId, mapWithId);
    expect(res.ids_match).toBe(false);
    expect(res.verdict).toBe('STALE');
  });

  it('identifies missing Debug IDs as NO_DEBUG_ID', async () => {
    const res = await verifyDebugIdIntegrity(jsNoId, mapNoId);
    expect(res.ids_match).toBe(false);
    expect(res.verdict).toBe('NO_DEBUG_ID');
  });
});

describe('ingestTelemetryPayload', () => {
  it('parses Sentry JSON format and maps frames', async () => {
    const payload = JSON.stringify({
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Something went wrong',
            stacktrace: {
              frames: [
                {
                  filename: 'bundle-ok.js',
                  lineno: 1,
                  colno: 10,
                  function: 'add',
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    });

    const result = await ingestTelemetryPayload(payload, testDir);
    expect(result.platform_detected).toBe('sentry');
    expect(result.frames_found).toBe(1);
    expect(result.retraced_frames[0].original_file).toBe('src/math.ts');
  });

  it('parses Bugsnag JSON format and maps frames', async () => {
    const payload = JSON.stringify({
      events: [
        {
          exceptions: [
            {
              errorClass: 'Error',
              message: 'Bugsnag crash',
              stacktrace: [
                {
                  file: 'bundle-ok.js',
                  lineNumber: 1,
                  columnNumber: 10,
                  method: 'add',
                  inProject: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await ingestTelemetryPayload(payload, testDir);
    expect(result.platform_detected).toBe('bugsnag');
    expect(result.frames_found).toBe(1);
    expect(result.retraced_frames[0].original_file).toBe('src/math.ts');
  });

  it('parses Datadog logs format with stack trace string', async () => {
    const payload = JSON.stringify({
      error: {
        stack: `Error: fail\n    at add (bundle-ok.js:1:10)\n`,
      },
    });

    const result = await ingestTelemetryPayload(payload, testDir);
    expect(result.platform_detected).toBe('datadog');
    expect(result.frames_found).toBe(1);
    expect(result.retraced_frames[0].original_file).toBe('src/math.ts');
  });
});

describe('surfaceAsyncCausality', () => {
  it('detects async boundary and points to scheduling origin', async () => {
    const stack = [
      'Error: oops',
      '    at handleCrash (bundle-ok.js:1:10)',
      '    at async processTask (bundle-ok.js:1:10)',
      '    at Promise.then (async)',
      '    at startApp (bundle-ok.js:1:10)',
    ].join('\n');

    const result = await surfaceAsyncCausality(stack, testDir);
    expect(result.async_boundary_detected).toBe(true);
    expect(result.boundary_type).toBe('await');
    expect(result.crash_frame).not.toBeNull();
    expect(result.crash_frame!.file).toBe('src/math.ts');
    expect(result.async_origin_frame).not.toBeNull();
    expect(result.async_origin_frame!.file).toBe('src/math.ts');
  });

  it('handles simple trace without boundary gracefully', async () => {
    const stack = ['Error: oops', '    at handleCrash (bundle-ok.js:1:10)'].join('\n');

    const result = await surfaceAsyncCausality(stack, testDir);
    expect(result.async_boundary_detected).toBe(false);
    expect(result.boundary_type).toBeNull();
    expect(result.crash_frame!.file).toBe('src/math.ts');
    expect(result.async_origin_frame).toBeNull();
  });
});
