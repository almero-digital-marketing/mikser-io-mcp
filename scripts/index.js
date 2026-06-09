#!/usr/bin/env node
// Bin entry for mikser-io-mcp. Dispatches subcommands.
//
// Usage:
//   npx mikser-io-mcp register claude [--url URL] [--dry-run] [--force] [--unregister]
//   npx mikser-io-mcp register chatgpt --url URL [--dry-run]
//
// Run from inside a mikser project directory — registration scripts
// read ./package.json for the project name (used as the connector
// label).

import { runClaude }  from './claude.js'
import { runChatGPT } from './chatgpt.js'

function usage(code = 0) {
    process.stdout.write(`mikser-io-mcp — register this project with an MCP-speaking client

Usage:
  npx mikser-io-mcp register claude [options]
  npx mikser-io-mcp register chatgpt --url <URL>

Common options:
  --url=<URL>      MCP endpoint URL. Default for claude: http://localhost:3001/mcp.
                   REQUIRED for chatgpt (must be publicly reachable HTTPS).
  --dry-run        Show what would change without writing.

Claude-only options:
  --unregister     Remove this project's entry from Claude Desktop's config.
  --force          Overwrite an existing entry that doesn't match.

Run from inside a mikser project directory — the project's package.json
is read for the connector name.
`)
    process.exit(code)
}

const [, , cmd, host, ...rest] = process.argv

if (!cmd) usage(0)
if (cmd === '-h' || cmd === '--help') usage(0)

if (cmd !== 'register') {
    process.stderr.write(`Unknown command: ${cmd}\n\n`)
    usage(1)
}

if (host === 'claude') {
    await runClaude(rest)
} else if (host === 'chatgpt') {
    await runChatGPT(rest)
} else if (!host) {
    process.stderr.write(`'register' needs a target host: claude | chatgpt\n\n`)
    usage(1)
} else {
    process.stderr.write(`Unknown host: ${host}. Supported: claude, chatgpt.\n\n`)
    usage(1)
}
