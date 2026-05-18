#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';

const server = new McpServer({
  name: 'sourcemap-retrace-mcp',
  version: '0.1.0',
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

const transport = new StdioServerTransport();
await server.connect(transport);
