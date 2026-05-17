# 🗺️ sourcemap-retrace-mcp

[![npm](https://img.shields.io/npm/v/sourcemap-retrace-mcp)](https://www.npmjs.com/package/sourcemap-retrace-mcp)
[![CI](https://github.com/vola-trebla/sourcemap-retrace-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/sourcemap-retrace-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Your app crashed in production. The stack trace is useless. Your AI agent has no idea where the bug is.**

MCP server that decodes minified production stack traces back to original TypeScript source files, lines, and columns — using source maps. Before your agent spends 20 minutes guessing at obfuscated code.

---

## 🤔 The problem

Your monitoring tool sends you this:

```
TypeError: Cannot read properties of undefined (reading 'userId')
    at e.<anonymous> (main.a3f2c1.js:1:47821)
    at h (vendor.d4e5f6.js:1:12045)
    at processQueue (main.a3f2c1.js:1:89234)
```

You ask your agent to debug it. The agent reads `main.a3f2c1.js`. It's 40,000 characters of minified JavaScript. It has no idea what `e.<anonymous>` at column 47821 means.

`sourcemap-retrace-mcp` maps that back to:

```
    at validateSession (src/auth/session.ts:142:8)
    at handleRequest (src/api/middleware.ts:67:3)
```

Now the agent knows exactly where to look.

---

## 🛠️ Tools

### `retrace_stack`

Decode a minified stack trace back to original TypeScript source locations. Pass the raw stack trace and the directory containing your `.js.map` files.

```
Retrace Results
  Frames mapped: 3  |  Unmapped: 1

TypeError: Cannot read properties of undefined (reading 'userId')
    at validateSession (src/auth/session.ts:142:8)
    at handleRequest (src/api/middleware.ts:67:3)
    at processQueue (src/queue/processor.ts:28:12)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)
```

### `retrieve_code_context`

Show the original source lines surrounding a mapped error location — with line numbers and a column pointer.

```
Code Context
  File: src/auth/session.ts
  Target: line 142, column 8

  139 │   const session = await getSession(token);
  140 │   if (!session) throw new AuthError("invalid token");
  141 │
> 142 │   return session.userId;
        │         ^
  143 │ }
  144 │
  145 │ export async function refreshSession(token: string) {
```

### `audit_sourcemap_match`

Validate that `.map` files in your dist directory are present and point to source files that actually exist on disk. Catches stale or missing maps before deployment.

```
Sourcemap Audit
  Directory: dist/
  Files checked: 4
  OK: 3  |  Missing maps: 0  |  Broken sources: 1

  ✓ main.a3f2c1.js — 47 source(s) mapped
  ✓ vendor.d4e5f6.js — 312 source(s) mapped
  ✓ worker.b1c2d3.js — 8 source(s) mapped
  ⚠ legacy.e7f8a9.js — 2 source(s) not found on disk:
      ../src/utils/deprecated.ts
      ../src/utils/compat.ts
```

---

## ⚡ Setup

```json
{
  "mcpServers": {
    "sourcemap-retrace": {
      "command": "npx",
      "args": ["-y", "sourcemap-retrace-mcp"]
    }
  }
}
```

---

## 🚀 Usage

> "I have a production error. Here's the stack trace: [paste]. My dist files are in /path/to/dist. Retrace it, show me the code around the error, and tell me what's wrong."

The agent runs `retrace_stack`, then `retrieve_code_context` on the mapped location, and can finally read the actual TypeScript that crashed.

Works great alongside:

- [env-secret-exposure-analyzer-mcp](https://www.npmjs.com/package/env-secret-exposure-analyzer-mcp) — scan for secrets before deploying
- [release-readiness-triage-mcp](https://www.npmjs.com/package/release-readiness-triage-mcp) — CI health check before release

---

## 📦 Links

- **npm:** [npmjs.com/package/sourcemap-retrace-mcp](https://www.npmjs.com/package/sourcemap-retrace-mcp)
- **GitHub:** [github.com/vola-trebla/sourcemap-retrace-mcp](https://github.com/vola-trebla/sourcemap-retrace-mcp)

## License

MIT
