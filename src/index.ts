#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({
  name: 'sourcemap-retrace-mcp',
  version: '0.2.0',
});

server.tool(
  'retrace_stack',
  'Decode a minified production stack trace back to original TypeScript source files, lines, and columns.',
  {
    stackTrace: z.string().describe('The raw minified error stack trace (multi-line string)'),
    sourcemapDir: z
      .string()
      .describe('Directory containing .map files (or the dist directory where .js.map files live)'),
  },
  async ({ stackTrace, sourcemapDir }) => {
    const { retraceStack } = await import('./retrace.js');
    const text = await retraceStack(stackTrace, sourcemapDir);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'retrieve_code_context',
  'Show the original source code lines surrounding a mapped error location.',
  {
    originalFile: z.string().describe('Absolute path to the original TypeScript source file'),
    line: z.number().int().min(1).describe('1-based line number in the original source'),
    column: z.number().int().min(0).default(0).describe('0-based column number'),
    contextLines: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe('Number of lines to show before and after the target line'),
  },
  async ({ originalFile, line, column, contextLines }) => {
    const { retrieveCodeContext } = await import('./retrace.js');
    const text = await retrieveCodeContext(originalFile, line, column, contextLines);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'audit_sourcemap_match',
  'Validate that .map files in a dist directory align with their compiled .js counterparts.',
  {
    distDir: z
      .string()
      .describe('Path to the dist/build directory containing .js and .js.map files'),
  },
  async ({ distDir }) => {
    const { auditSourcemapMatch } = await import('./retrace.js');
    const text = await auditSourcemapMatch(distDir);
    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'verify_debug_id_integrity',
  'Validate that a minified production bundle matches its source map using embedded Debug IDs.',
  {
    jsPath: z.string().describe('Absolute path to the compiled JS file'),
    mapPath: z.string().describe('Absolute path to the .map file'),
  },
  async ({ jsPath, mapPath }) => {
    const { verifyDebugIdIntegrity } = await import('./retrace.js');
    const result = await verifyDebugIdIntegrity(jsPath, mapPath);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'normalize_bundler_paths',
  'Resolve dynamic bundle references (like webpack://, ng://, or Vite /@fs/ paths) to raw files.',
  {
    rawPath: z.string().describe('The raw source path reference from the source map'),
    projectRoot: z.string().optional().describe('Root directory of the project'),
    sourceRoot: z.string().optional().describe('Source root configuration from the source map'),
  },
  async ({ rawPath, projectRoot, sourceRoot }) => {
    const { normalizeBundlerPath } = await import('./retrace.js');
    const normalized = normalizeBundlerPath(rawPath, projectRoot, sourceRoot);
    const fs = await import('fs');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              raw_path: rawPath,
              normalized_path: normalized,
              file_exists: fs.existsSync(normalized),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'ingest_telemetry_payload',
  'Directly ingest Sentry, Bugsnag, or Datadog crash dumps and return fully retraced stack frames.',
  {
    payload: z.string().describe('The raw JSON string of the crash telemetry event'),
    sourcemapDir: z.string().describe('Directory containing corresponding .map files'),
    inAppOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe('Only return frames marked as part of the application source code'),
  },
  async ({ payload, sourcemapDir, inAppOnly }) => {
    const { ingestTelemetryPayload } = await import('./retrace.js');
    const result = await ingestTelemetryPayload(payload, sourcemapDir, inAppOnly);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'surface_async_causality',
  'Detect and trace across async boundaries (e.g. await, processTicksAndMicrotasks) to locate scheduling origins.',
  {
    stackTrace: z.string().describe('The minified stack trace with async boundary markers'),
    sourcemapDir: z.string().describe('Directory containing corresponding .map files'),
  },
  async ({ stackTrace, sourcemapDir }) => {
    const { surfaceAsyncCausality } = await import('./retrace.js');
    const result = await surfaceAsyncCausality(stackTrace, sourcemapDir);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
