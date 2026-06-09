// register chatgpt — print copy-paste instructions for adding mikser
// to ChatGPT Desktop as a custom MCP connector.
//
// ChatGPT does NOT use a local config file. Connectors live in the
// user's OpenAI account, configured through the UI. OpenAI's servers
// connect to the MCP endpoint directly, so localhost won't work — a
// publicly-reachable HTTPS URL is mandatory.
//
// This script can't drop a file. The most it can do is render the
// exact name / description / URL the user pastes into the UI.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

function parseArgs(args) {
    const opts = {}
    for (const a of args) {
        if (a.startsWith('--url=')) opts.url = a.slice(6)
        else if (a === '--url')     opts._expectUrl = true
        else if (opts._expectUrl)   { opts.url = a; opts._expectUrl = false }
    }
    return opts
}

function readProjectMeta() {
    const pkgPath = resolve(process.cwd(), 'package.json')
    if (!existsSync(pkgPath)) {
        throw new Error(`No package.json in ${process.cwd()} — run this from inside a mikser project directory.`)
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg.name) throw new Error('package.json has no "name" field — set one before registering.')
    return {
        name: pkg.name,
        description: pkg.description ?? `MCP connector for ${pkg.name}.`,
    }
}

export async function runChatGPT(args) {
    const opts = parseArgs(args)

    if (!opts.url) {
        process.stderr.write(
`! ChatGPT needs a publicly-reachable HTTPS URL.

OpenAI's servers connect to your MCP endpoint directly — there's no stdio
bridge, no localhost. You'll need to expose mikser via a tunnel first:

  ngrok http 3001
  # or:
  cloudflared tunnel --url http://localhost:3001

Then re-run with the public URL:

  npx mikser-io-mcp register chatgpt --url https://YOUR-TUNNEL.example/mcp

ChatGPT's Developer mode + custom MCP connectors are currently in BETA
and require a Plus / Pro / Business / Enterprise / Edu account. See
https://help.openai.com/en/articles/12584461 for the current state.
`
        )
        process.exit(1)
    }

    const { name, description } = readProjectMeta()

    process.stdout.write(
`✓ Connector details for "${name}"

ChatGPT doesn't have a local config file — connectors are added through
the UI. Copy the three fields below.

Open ChatGPT (Desktop or web) and navigate to:
  Settings → Connectors → Advanced → Developer mode (toggle ON)
  Click + Create

Paste these into the form:

  Name:            ${name}
  Description:     ${description}
  MCP Server URL:  ${opts.url}
  Authentication:  None     (or your scheme of choice for production)

Click Create. Then to use it:

  1. Start a NEW chat (saved connectors are off-by-default per chat)
  2. Open the composer's Developer Mode tool picker
  3. Enable "${name}"
  4. Try: "Use mikser_query_entities to show me everything in this catalog"

Notes:
  - Mikser must be running and the URL must be reachable from
    OpenAI's servers (not just your machine).
  - Connectors do NOT auto-enable per chat — toggle on for each new
    conversation.
  - Developer mode + arbitrary custom MCP connectors are BETA. Plus /
    Pro / Business / Enterprise / Edu only; Free tier excluded.
  - "ChatGPT Apps" is the GA but read-only variant of MCP integration;
    this script targets the full read+write Developer mode beta.

Reference:
  https://help.openai.com/en/articles/12584461
  https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
`
    )
}
