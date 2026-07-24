# Package Inspector

**An MCP server that gives your AI assistant deep, trustworthy insight into npm packages.**

Package Inspector is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI coding assistant answer real questions about npm dependencies: what a package is, who maintains it, what it pulls in, whether it has known CVEs, how much it weighs, whether it looks like a supply-chain risk, and whether anyone actually uses it. It reads from public registry and advisory APIs, cross-references the signals, and returns both a plain-language verdict and structured JSON — so the assistant can answer immediately or reason further. It needs no API keys, no account, and no configuration.

[![MCP Commons](https://mcpcommons.com/badge/package-inspector.svg)](https://mcpcommons.com/listing/package-inspector)

Developed for demo on [MCP Commons](https://mcpcommons.com) an MCP marketplace for free and paid MCP servers. See [Deploy Scripts](/.github/) for an auto deploy script example.

---

## Tools

| Tool | What it does |
| --- | --- |
| **`audit_dependencies`** | Audits a whole project from its package.json or package-lock.json: vulnerabilities, deprecations, install scripts and licence problems across every dependency, with a prioritised fix list. |
| **`inspect_package`** | Full overview: description, resolved version, license, maintainers, repository, dist-tags, deprecation, publish date, Node engines, TypeScript types, weekly downloads. |
| **`list_versions`** | Recent versions newest-first with publish dates, latest/deprecated markers, and release-cadence stats (median gap, releases in the last 90 days). |
| **`dependency_tree`** | Resolves the install graph to a given depth with unique-dependency counts, max depth, version conflicts, install-script detection, and the heaviest sub-trees. |
| **`check_vulnerabilities`** | Known CVEs/GHSAs for an exact version from OSV, each with CVSS severity, affected ranges and fixed versions, plus the smallest upgrade that clears everything. |
| **`package_size`** | On-disk install footprint, derived from registry metadata with no third-party service, plus browser bundle cost (minified, min+gzip, tree-shakeability, 3G/4G download times). |
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

This server is **not published to npm** and is run from source.

> [!WARNING]
> Do **not** run `npx -y package-inspector`. The name `package-inspector` is already
> taken on the public npm registry by an unrelated third-party CLI, so that command
> downloads and executes someone else's code — not this server. It is not an MCP
> server, so it prints usage text and exits, and your client reports
> "Server transport closed unexpectedly". Always use an absolute path to your own
> build, as shown below.

```bash
git clone https://github.com/Cryptobyte/package-inspector.git
cd package-inspector
npm install
npm run build
node dist/index.js
```

The server speaks MCP over stdio, so running it directly just waits for a client on stdin — that is expected. Point an MCP client at it using one of the configs below.

---

## Client configuration

Every example below uses an absolute path to `dist/index.js`. Replace
`/absolute/path/to/package-inspector` with wherever you cloned the repo, and make
sure you have run `npm run build` first — the path must point at the compiled
`dist/index.js`, not at `src/`.

### Claude Desktop

Add to `claude_desktop_config.json` (**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`, **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`):

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

Restart Claude Desktop afterwards (quit fully — closing the window is not enough).

### Claude Code

```bash
claude mcp add package-inspector -- node /absolute/path/to/package-inspector/dist/index.js
```

Or add it to `.mcp.json` in your project root to share it with your team:

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

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

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

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "package-inspector": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/package-inspector/dist/index.js"]
    }
  }
}
```

### Verifying it works without a client

If a client reports the server disconnecting, check the build directly — this
should print an `initialize` response and a list of ten tools:

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node dist/index.js
```

If you see usage text about `repl`, `dl`, `exec` and `cl` commands, you are
running the unrelated npm package rather than this server — see the warning above.

---

## What it talks to

Package Inspector makes outbound HTTPS requests to **exactly four hosts, and nothing else**:

| Host | Used for |
| --- | --- |
| `registry.npmjs.org` | Package metadata, version manifests, search, provenance attestations, install-size data |
| `api.npmjs.org` | Download counts |
| `api.osv.dev` | Vulnerability advisories (OSV, which aggregates GHSA + CVE + npm advisories) |
| `bundlephobia.com` | Bundle size (minified, min+gzip) |

This list is enforced in code, not just documented. There is exactly **one** `fetch()` call in the entire server, in [`src/lib/http.ts`](src/lib/http.ts), and it is gated by an `assertAllowedHost` check that rejects any host outside the allowlist and refuses plain HTTP. You can verify the whole network surface by reading one file, and the test suite asserts it:

```bash
grep -rn "fetch(" src/     # exactly one hit: src/lib/http.ts
```

### Hostnames that appear in the code but are never contacted

Automated scanners flag a few hostnames in this repo. None is a network destination — they are URL-shaped **strings**, not fetch targets:

| Hostname | Why it appears | Contacted? |
| --- | --- | --- |
| `github.com` | `normalizeRepositoryUrl` in [`src/lib/format.ts`](src/lib/format.ts) rewrites npm's `repository` field into a canonical URL (`git@github.com:a/b` → `https://github.com/a/b`) for display. It is also the project's own `HOMEPAGE`, embedded in the `User-Agent` string, and it shows up in advisory `references` that OSV returns **as data**. | No |
| `gitlab.com` | Appears only in one unit-test assertion for the same URL-normalising function. It occurs nowhere in `src/`. | No |
| `mcpcommons.com` | Release tooling in [`.github/scripts/`](.github/scripts/) that runs in GitHub Actions to publish the marketplace listing. It is not part of the server and is never loaded by it; a test asserts the host never appears under `src/`. | No |

Repository URLs are normalised for display and returned in the JSON so a human or model can click them. The server never resolves, fetches, or validates them, and a request to any of these hosts throws before a socket is opened.

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
- *"Audit my package-lock.json — what should I fix first?"*

See [`docs/examples.md`](docs/examples.md) for real, unedited tool output.

---

## Notes on accuracy

Being useful means being honest about limits:

- **Dependency trees are resolved from registry metadata**, picking the highest published version satisfying each range — what a fresh install would choose. A real `npm install` may differ where a lockfile pins older versions, and npm's hoisting/deduplication is not modelled (the tool reports unique packages and unique `name@version` pairs separately).
- **"No known vulnerabilities" means none have been *reported*.** It is not an audit, and OSV coverage is not complete.
- **Supply-chain risk is a heuristic over metadata.** It can flag suspicious signals; it cannot detect malicious code. Every finding is listed with its reason and weight so you can disagree with any individual one.
- **Download counts include CI and mirror traffic**, so they measure automated pulls as much as human adoption.
- **bundlephobia is a third-party community service** that builds packages on demand. It rate-limits and sometimes has no data; when that happens the tool reports the gap as a note and returns everything else rather than failing.
- **Install size is derived from npm registry metadata**, in the `estimatedInstall` section, so it needs nothing but `registry.npmjs.org`. It resolves the production dependency graph and sums `dist.unpackedSize` for every distinct `name@version`. Measured against a real `npm install express@4.18.2`, the estimate came to **1,999,033 bytes vs 2,198,164 actual — 90.9%**, the shortfall being 17 dependencies published before npm began recording `unpackedSize` in ~2018. It is a **lower bound**, and the output always reports `coverage` so you can see how complete a given sum is. It also cannot see lockfile pins, `overrides`/`resolutions`, or `bundledDependencies`, counts optional dependencies that npm skips on non-matching `os`/`cpu` (reported separately as `optionalSize`), and approximates hoisting by counting each distinct version once — packages resolving at multiple versions are listed under `conflictingPackages`.
- **Bot challenges are detected, not solved.** Some hosts sit behind Vercel or Cloudflare bot protection, which answers automated requests with an HTTP 429 and an HTML challenge page rather than JSON. The server detects that (`x-vercel-mitigated: challenge`, or HTML where JSON was requested), reports it as `BLOCKED`, and does **not** retry — a challenge is deterministic, so retrying would only waste time and keep hammering a host that already declined. No attempt is ever made to solve or bypass one.

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
    sizes.ts          bundlephobia bundle-size client
    install-size.ts   Registry-derived install footprint estimation
    manifest.ts       package.json / package-lock.json parsing
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
