# Package Inspector

**An MCP server that gives your AI assistant deep, trustworthy insight into npm packages.**

Package Inspector is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI coding assistant answer real questions about npm dependencies: what a package is, who maintains it, what it pulls in, whether it has known CVEs, how much it weighs, whether it looks like a supply-chain risk, and whether anyone actually uses it. It reads from public registry and advisory APIs, cross-references the signals, and returns both a plain-language verdict and structured JSON — so the assistant can answer immediately or reason further. It needs no API keys, no account, and no configuration.

Developed for demo on [MCP Commons](https://mcpcommons.com) an MCP marketplace for free and paid MCP servers.

---

## Tools

| Tool | What it does |
| --- | --- |
| **`inspect_package`** | Full overview: description, resolved version, license, maintainers, repository, dist-tags, deprecation, publish date, Node engines, TypeScript types, weekly downloads. |
| **`list_versions`** | Recent versions newest-first with publish dates, latest/deprecated markers, and release-cadence stats (median gap, releases in the last 90 days). |
| **`dependency_tree`** | Resolves the install graph to a given depth with unique-dependency counts, max depth, version conflicts, install-script detection, and the heaviest sub-trees. |
| **`check_vulnerabilities`** | Known CVEs/GHSAs for an exact version from OSV, each with CVSS severity, affected ranges and fixed versions, plus the smallest upgrade that clears everything. |
| **`package_size`** | Install footprint (bytes downloaded and on disk) and browser bundle cost (minified, min+gzip, tree-shakeability, 3G/4G download times). |
| **`compare_versions`** | Diffs two versions: dependencies added/removed/bumped, bundle-size delta, time between releases, engine and license changes, breaking-change verdict. |
| **`analyze_supply_chain`** | Weighted, explainable risk report: install scripts, bus factor, provenance, deprecation, license risk, adoption, known vulns, and typosquatting similarity. |
| **`search_packages`** | Registry search with weekly downloads and npm's quality/popularity/maintenance scores attached. |
| **`download_stats`** | Download counts plus week-over-week and month-over-month momentum (growing / stable / declining). |

Every tool returns a short human-readable verdict **and** a pretty-printed JSON object with the full structured data.

---

## Requirements

- **Node.js 20 or newer** (uses the built-in `fetch`).
- **No API keys.** No account, no token, no configuration file. Every data source is a free public endpoint.

---

## Install and run

### Option 1 — npx (recommended)

```bash
npx -y package-inspector
```

### Option 2 — from source

```bash
git clone https://github.com/cryptobyte/package-inspector.git
cd package-inspector
npm install
npm run build
node dist/index.js
```

The server speaks MCP over stdio, so running it directly just waits for a client on stdin — that is expected. Point an MCP client at it using one of the configs below.

---

## Client configuration

### Claude Desktop

Add to `claude_desktop_config.json` (**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`, **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "package-inspector": {
      "command": "npx",
      "args": ["-y", "package-inspector"]
    }
  }
}
```

Restart Claude Desktop afterwards.

### Claude Code

```bash
claude mcp add package-inspector -- npx -y package-inspector
```

Or add it to `.mcp.json` in your project root to share it with your team:

```json
{
  "mcpServers": {
    "package-inspector": {
      "command": "npx",
      "args": ["-y", "package-inspector"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "package-inspector": {
      "command": "npx",
      "args": ["-y", "package-inspector"]
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "package-inspector": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "package-inspector"]
    }
  }
}
```

### Running from a local clone

Replace the `command`/`args` with an absolute path to your build:

```json
{
  "mcpServers": {
    "package-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/package-inspector/dist/index.js"]
    }
  }
}
```

---

## What it talks to

Package Inspector makes outbound HTTPS requests to **exactly five hosts, and nothing else**:

| Host | Used for |
| --- | --- |
| `registry.npmjs.org` | Package metadata, version manifests, search, provenance attestations |
| `api.npmjs.org` | Download counts |
| `api.osv.dev` | Vulnerability advisories (OSV, which aggregates GHSA + CVE + npm advisories) |
| `packagephobia.com` | Install size (bytes downloaded, bytes on disk) |
| `bundlephobia.com` | Bundle size (minified, min+gzip) |

This list is enforced in code, not just documented. Every request in the server goes through a single `fetchJson` function in [`src/lib/http.ts`](src/lib/http.ts) that rejects any host outside the allowlist and refuses plain HTTP — you can verify the whole network surface by reading one file, and the test suite asserts it.

**Privacy and safety properties:**

- **No credentials.** No API keys, tokens, cookies, or auth headers are sent to anyone.
- **No telemetry.** Nothing is reported anywhere. There is no analytics, no phone-home, no usage tracking.
- **Nothing about you is transmitted.** The only data leaving your machine is the package name and version you asked about.
- **Read-only.** The server never writes files, never executes package code, never runs `npm install`, and never downloads a tarball. Dependency trees are resolved from registry *metadata*.
- **No obfuscation.** Plain, readable TypeScript, two runtime dependencies (`@modelcontextprotocol/sdk` and `zod`).
- **Polite.** A descriptive `User-Agent`, a 10-second timeout on every request, at most 6 concurrent requests, and a 5-minute in-memory cache so repeated lookups don't hit upstreams again.

---

## Example prompts

Once connected, try asking your assistant:

- *"Is `left-pad@1.3.0` safe to use?"*
- *"Compare axios 0.27 with 1.7 — what would break?"*
- *"How big is the react dependency tree?"*
- *"Does `lodash@4.17.15` have any known CVEs, and what's the smallest upgrade that fixes them?"*
- *"I need a CSV parser. Find me options and compare them by size and popularity."*
- *"Is `chalk` still actively maintained?"*
- *"Someone added a package called `expresss` to our lockfile. Should I be worried?"*
- *"Which of my dependencies run postinstall scripts?"*
- *"Will adding `moment` bloat my bundle? What about `date-fns`?"*
- *"Is `zod` gaining or losing traction?"*

See [`docs/examples.md`](docs/examples.md) for real, unedited tool output.

---

## Notes on accuracy

Being useful means being honest about limits:

- **Dependency trees are resolved from registry metadata**, picking the highest published version satisfying each range — what a fresh install would choose. A real `npm install` may differ where a lockfile pins older versions, and npm's hoisting/deduplication is not modelled (the tool reports unique packages and unique `name@version` pairs separately).
- **"No known vulnerabilities" means none have been *reported*.** It is not an audit, and OSV coverage is not complete.
- **Supply-chain risk is a heuristic over metadata.** It can flag suspicious signals; it cannot detect malicious code. Every finding is listed with its reason and weight so you can disagree with any individual one.
- **Download counts include CI and mirror traffic**, so they measure automated pulls as much as human adoption.
- **bundlephobia and packagephobia are third-party community services** that build packages on demand. They rate-limit and sometimes have no data; when that happens the tool reports the gap as a note and returns everything else rather than failing.

---

## Development

```bash
npm install
npm run dev        # run from source with tsx
npm run build      # compile to dist/
npm test           # unit tests (node:test, no network required)
npm run typecheck  # type check without emitting
```

The test suite covers the pure helpers — semver parsing and range matching, CVSS scoring, edit distance, byte/date formatting, version diffing, cadence and trend-window arithmetic, risk weighting, input validation, and the host allowlist — and needs no network access.

**Project layout:**

```
src/
  index.ts            Server bootstrap, stdio transport, request handlers
  lib/
    http.ts           The only network boundary: allowlist, timeouts, TTL cache
    npm.ts            Registry, download-count, search and attestation clients
    osv.ts            Vulnerability advisory client
    sizes.ts          packagephobia + bundlephobia clients
    semver.ts         Dependency-free semver parsing and range matching
    cvss.ts           CVSS v3 base score calculation
    format.ts         Byte/date/percentage humanisation
    typosquat.ts      Edit distance and the popular-package list
    concurrency.ts    Bounded-concurrency map
    errors.ts         Error types and graceful degradation helper
    response.ts       Tool result shaping
  tools/              One module per tool, plus the registry
test/                 Unit tests for the pure helpers
```

To add a tool: create a module in `src/tools/` that exports a `defineTool({ ... })` result, then list it in `src/tools/index.ts`. Nothing else needs to change.

---

## License

MIT — see [LICENSE](LICENSE).
