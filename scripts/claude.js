// register claude — drop a connector entry into Claude Desktop's
// config file so the app picks up the local mikser server.
//
// Claude Desktop launches MCP servers as stdio subprocesses, so we
// register supergateway as the launcher — it bridges Claude's stdio
// to mikser's streamable-HTTP endpoint. The mikser server must be
// running for Claude to find anything.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const DEFAULT_URL = 'http://localhost:3001/mcp'

function configPath() {
    const home = homedir()
    switch (platform()) {
        case 'darwin': return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        case 'win32':  return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        case 'linux':  return join(home, '.config', 'Claude', 'claude_desktop_config.json')
        default:       throw new Error(`register-mcp: unsupported platform "${platform()}"`)
    }
}

function parseArgs(args) {
    const opts = {}
    for (const a of args) {
        if (a === '--unregister')     opts.unregister = true
        else if (a === '--dry-run')   opts.dryRun = true
        else if (a === '--force')     opts.force = true
        else if (a.startsWith('--url=')) opts.url = a.slice(6)
        else if (a === '--url')       opts._expectUrl = true
        else if (opts._expectUrl)     { opts.url = a; opts._expectUrl = false }
    }
    return opts
}

function readProjectName() {
    const pkgPath = resolve(process.cwd(), 'package.json')
    if (!existsSync(pkgPath)) {
        throw new Error(`No package.json in ${process.cwd()} — run this from inside a mikser project directory.`)
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (!pkg.name) throw new Error('package.json has no "name" field — set one before registering.')
    return pkg.name
}

export async function runClaude(args) {
    const opts = parseArgs(args)
    const name = readProjectName()
    const url  = opts.url ?? DEFAULT_URL

    const entry = {
        command: 'npx',
        args: ['-y', 'supergateway', '--streamableHttp', url],
    }

    const path = configPath()
    let config = {}
    let existed = false

    if (existsSync(path)) {
        existed = true
        try {
            config = JSON.parse(readFileSync(path, 'utf8'))
        } catch (err) {
            process.stderr.write(`! Existing Claude Desktop config at\n    ${path}\nis not valid JSON. Refusing to overwrite — fix it manually first.\n  Error: ${err.message}\n`)
            process.exit(1)
        }
    }

    config.mcpServers = config.mcpServers || {}

    // Unregister branch.
    if (opts.unregister) {
        if (!(name in config.mcpServers)) {
            process.stdout.write(`✓ "${name}" is not registered. Nothing to do.\n`)
            return
        }
        if (opts.dryRun) {
            process.stdout.write(`[dry-run] Would remove "${name}" from ${path}\n`)
            return
        }
        delete config.mcpServers[name]
        writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
        process.stdout.write(`✓ Removed "${name}" from ${path}\n  Restart Claude Desktop to apply.\n`)
        return
    }

    // Idempotent — bail if already matching.
    const existing = config.mcpServers[name]
    if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
        process.stdout.write(`✓ "${name}" is already registered with the matching config.\n  Nothing to change. (Use --force to re-write anyway.)\n`)
        return
    }
    if (existing && !opts.force) {
        process.stderr.write(`! "${name}" is already registered but with a different config:\n    ${JSON.stringify(existing)}\n  Wanted:\n    ${JSON.stringify(entry)}\n  Re-run with --force to overwrite.\n`)
        process.exit(1)
    }
    if (opts.dryRun) {
        process.stdout.write(`[dry-run] Would ${existing ? 'overwrite' : 'add'} "${name}" in ${path}:\n${JSON.stringify(entry, null, 2)}\n`)
        return
    }

    config.mcpServers[name] = entry
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n')

    process.stdout.write(
`✓ Registered "${name}" in
    ${path}
  ${existed ? '(merged into existing config)' : '(created new config file)'}

Next steps:
  1. Make sure mikser is running and reachable at ${url}
  2. Restart Claude Desktop (fully quit, then reopen)
  3. The mikser tools should appear in Claude's tool list

To remove: npx mikser-io-mcp register claude --unregister
`)
}
