# Security surface

A compact, self-contained description of everything this server does that
touches the network or handles credentials. It exists so a reviewer can verify
the important claims without reading the whole tree.

Every claim below is checkable with a command you can run against a clone.

---

## Egress: four hosts, one code path

| Host | Purpose |
| --- | --- |
| `registry.npmjs.org` | Package metadata, version manifests, search, provenance attestations, `dist.unpackedSize` for install-size estimation |
| `api.npmjs.org` | Download counts |
| `api.osv.dev` | Vulnerability advisories |
| `bundlephobia.com` | Bundle size (minified, min+gzip) |

There is exactly **one** `fetch()` call in the entire server:

```bash
grep -rn "fetch(" src/
```

It lives in `src/lib/http.ts` and is unconditionally preceded by a host check.
The guard, verbatim:

```ts
function assertAllowedHost(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new ToolError('INTERNAL', `Refusing non-https request to ${url.protocol}//${url.host}`);
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new ToolError(
      'INTERNAL',
      `Refusing request to disallowed host "${url.hostname}". Allowed hosts: ${ALLOWED_HOSTS.join(', ')}`,
    );
  }
}
```

It is called on the first line of `fetchJson`, before any request is
constructed, so a disallowed host throws before a socket is opened. Matching is
an exact `hostname` equality test against a frozen array — not a suffix or
substring match, so `registry.npmjs.org.evil.example` is rejected.

Both properties are asserted by the test suite:

```bash
npm test
```

- *"lists exactly the four documented hosts"* — pins `ALLOWED_HOSTS`
- *"refuses any other host without opening a connection"*
- *"refuses plain http even to an allowed host"*
- *"refuses a lookalike host"*
- *"routes every network call through the single guarded fetch in http.ts"* —
  walks `src/` and fails if a second `fetch()` appears anywhere

---

## Hostnames that appear in the source but are never contacted

Static scanners flag these. None is a fetch target.

| Hostname | Where it appears | Why |
| --- | --- | --- |
| `github.com` | `src/lib/format.ts`, `src/lib/version.ts` | `normalizeRepositoryUrl` rewrites npm's `repository` field into a canonical URL for **display** (`git@github.com:a/b` → `https://github.com/a/b`). It is also this project's `HOMEPAGE`, embedded in the outgoing `User-Agent` string so upstream operators can identify the client. Neither resolves nor fetches anything. |
| `osv.dev` | *(no longer present)* | Advisory attribution now cites `https://api.osv.dev`, the endpoint actually called, so every host-bearing URL in the source is one the allowlist covers. |
| `mcpcommons.com` | `.github/scripts/publish-listing.mjs` only | Release tooling that runs in GitHub Actions. It is **not** part of the server and is never loaded by it. |
| `gitlab.com`, `raw.githubusercontent.com` | `test/` only | Fixtures asserting that non-allowlisted hosts are rejected. |

Repository URLs are normalised for display and returned in JSON so a human or
model can click them. The server never resolves, fetches, or validates them.

### The runtime / CI boundary is enforced, not just asserted

`.github/scripts/publish-listing.mjs` contacts `mcpcommons.com` to publish a
release to the marketplace listing. It runs only in CI. A test walks `src/` and
fails if that host ever appears in runtime code:

```bash
grep -rn "mcpcommons" src/     # must return nothing
```

The shipped surface is `dist/`, built from `src/` alone. `package.json`'s
`files` allowlist is `dist`, `README.md`, `LICENSE` — the `.github/` directory
is never part of a package artifact.

---

## Credentials

**The MCP server uses none.** No API keys, tokens, cookies, or `Authorization`
headers are sent to any of the four hosts. No configuration file, no account, no
environment variables are read at runtime. The only data leaving the machine is
the package name and version being inspected.

**The CI publishing script** reads `MCPC_API_KEY` from a GitHub Actions secret
and sends it as a Bearer token to `mcpcommons.com` over HTTPS. It is passed via
the environment rather than argv (argv is readable by other processes on the
host), and is never logged — the script prints the request body, which does not
contain it. This is release tooling and is separate from the server's own
no-credential design.

---

## Other runtime properties

- **Read-only.** The server never writes files, never executes package code,
  never runs `npm install`, and never downloads or unpacks a tarball. Dependency
  trees and install sizes are computed from registry *metadata*.
- **Input validation.** Package names are validated against npm's naming rules
  before being interpolated into any URL (`assertValidPackageName`), which is
  what makes path traversal through a package name impossible. Version specs are
  similarly constrained. Every tool validates its arguments with a zod schema
  before the handler runs.
- **Bounded.** 10s timeout per request (15s for bundlephobia, which builds on
  demand), at most 6 concurrent requests, a 32 MB response size cap that aborts
  the stream, a 5-minute in-memory TTL cache, and node/depth caps on graph walks.
- **Bot challenges are detected, never solved.** A host answering with a
  Vercel/Cloudflare challenge page is reported as `BLOCKED` and not retried. No
  attempt is made to bypass one.
- **No telemetry.** Nothing is reported anywhere. No analytics, no phone-home,
  no usage tracking, no obfuscated or minified code in `src/`.

---

## Reporting a vulnerability

Open an issue at
<https://github.com/Cryptobyte/package-inspector/issues>, or for something
sensitive, use GitHub's private vulnerability reporting on the repository.
