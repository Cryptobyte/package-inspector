# Example output

Real, unedited output from Package Inspector (some JSON bodies are trimmed where
noted, to keep this document readable). Every tool returns one text block
containing a human-readable summary followed by the full structured JSON.

---

## `inspect_package`

**Call:** `{ "name": "left-pad", "version": "1.3.0" }`

```
left-pad@1.3.0 (latest)
String left pad
⚠️ DEPRECATED: use String.prototype.padStart()
License: WTFPL · Maintainers: 3 · ships its own TypeScript types
Published: 2018-04-09T01:10:45.796Z (8.3 years ago) · 15 versions total
Weekly downloads: 1,357,788
Dependencies: 0 runtime, 0 peer
Repository: https://github.com/stevemao/left-pad
```
```json
{
  "name": "left-pad",
  "requestedVersion": "1.3.0",
  "resolvedVersion": "1.3.0",
  "latestVersion": "1.3.0",
  "description": "String left pad",
  "license": "WTFPL",
  "author": "azer",
  "maintainerCount": 3,
  "maintainers": ["sebmck", "stevemao", "westlac"],
  "homepage": "https://github.com/stevemao/left-pad#readme",
  "repository": "https://github.com/stevemao/left-pad",
  "distTags": { "latest": "1.3.0" },
  "deprecated": {
    "isDeprecated": true,
    "message": "use String.prototype.padStart()",
    "packageDeprecated": true
  },
  "publishedAt": "2018-04-09T01:10:45.796Z",
  "publishedRelative": "8.3 years ago",
  "latestPublishedAt": "2018-04-09T01:10:45.796Z",
  "firstPublishedAt": "2014-03-14T09:09:20.762Z",
  "totalVersions": 15,
  "engines": null,
  "types": { "shipsOwnTypes": true, "typesPackage": null, "typesPackageExists": null },
  "weeklyDownloads": 1357788,
  "keywords": ["leftpad", "left", "pad", "padding", "string", "repeat"],
  "dependencyCounts": {
    "dependencies": 0,
    "devDependencies": 3,
    "peerDependencies": 0,
    "optionalDependencies": 0
  },
  "hasInstallScript": false,
  "unpackedSizeBytes": 9752,
  "fileCount": 10,
  "tarball": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"
}
```

---

## `check_vulnerabilities`

**Call:** `{ "name": "lodash", "version": "4.17.15" }`

```
⚠️ lodash@4.17.15 — 6 known vulnerabilities, highest severity: high
Recommended fix: upgrade to 4.18.0 (clears every advisory listed below).

🟠 GHSA-35jh-r3h4-6jhm (CVE-2021-23337) [high CVSS 7.2]
   Command Injection in lodash → fixed in 4.17.21
🟠 GHSA-p6mc-m468-83gw (CVE-2020-8203) [high CVSS 7.4]
   Prototype Pollution in lodash → fixed in 4.17.19
🟠 GHSA-r5fr-rjxr-66jc (CVE-2021-23337) [high CVSS 8.1]
   lodash vulnerable to Code Injection via `_.template` imports key names → fixed in 4.18.0
🟡 GHSA-29mw-wpgm-hmr9 (CVE-2020-28500) [medium CVSS 5.3]
   Regular Expression Denial of Service (ReDoS) in lodash → fixed in 4.17.21
🟡 GHSA-f23m-r3pf-42rh (CVE-2025-13465) [medium CVSS 6.5]
   lodash vulnerable to Prototype Pollution via array path bypass in `_.unset` and `_.omit` → fixed in 4.18.0
🟡 GHSA-xxjr-mmjv-4gpg (CVE-2025-13465) [medium CVSS 6.5]
   Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit` functions → fixed in 4.17.23
```

JSON (advisory list trimmed to the first entry here — the real response contains all six):

```json
{
  "name": "lodash",
  "requestedVersion": "4.17.15",
  "resolvedVersion": "4.17.15",
  "latestVersion": "4.18.1",
  "verdict": "6 known vulnerabilities, highest severity: high",
  "clean": false,
  "totalAdvisories": 6,
  "highestSeverity": "high",
  "severityCounts": { "critical": 0, "high": 3, "medium": 3, "low": 0, "unknown": 0 },
  "advisories": [
    {
      "id": "GHSA-35jh-r3h4-6jhm",
      "aliases": ["CVE-2021-23337", "CVE-2026-4800", "GHSA-r5fr-rjxr-66jc"],
      "cve": "CVE-2021-23337",
      "summary": "Command Injection in lodash",
      "details": "`lodash` versions prior to 4.17.21 are vulnerable to Command Injection via the template function.",
      "severity": "high",
      "cvssScore": 7.2,
      "cvssVector": "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H",
      "cwes": ["CWE-77", "CWE-94"],
      "published": "2021-05-06T16:05:51Z",
      "modified": "2026-07-08T18:29:36.682352320Z",
      "affectedRanges": [{ "range": "<4.17.21", "introduced": null, "fixed": "4.17.21" }],
      "fixedVersions": ["4.17.21"],
      "references": [
        "https://nvd.nist.gov/vuln/detail/CVE-2021-23337",
        "https://github.com/lodash/lodash/commit/3469357cff396a26c363f8c1b5a91dde28ba4b1c"
      ]
    }
  ],
  "safeUpgradeVersions": ["4.18.1", "4.18.0"],
  "recommendedUpgrade": "4.18.0",
  "source": "https://osv.dev"
}
```

Note `recommendedUpgrade`: the tool cross-references every advisory's fixed
versions against the package's real release list, then recommends the **lowest**
published version that clears all of them — the least disruptive upgrade, not
just "go to latest".

---

## `analyze_supply_chain`

**Call:** `{ "name": "left-pad" }`

```
🟠 left-pad@1.3.0 — supply-chain risk: MEDIUM (score 34)
Usable with awareness. Worth a look: Version is deprecated; No release in over two years.

1,357,788 weekly downloads · 3 maintainer(s) · published 8.3 years ago by stevemao · license WTFPL

Findings:
🔴 Version is deprecated (+20)
   The maintainers marked this version deprecated: "use String.prototype.padStart()"
🟠 No release in over two years (+10)
   This version was published 3028 days ago and nothing newer has shipped. Security fixes are unlikely to arrive.
ℹ️ No build provenance (+4)
   No SLSA provenance attestation was published, so the tarball cannot be traced to a specific
   source commit and CI run. This is still the norm on npm — a weak signal, not a finding.
```
```json
{
  "riskLevel": "medium",
  "riskScore": 34,
  "verdict": "Usable with awareness. Worth a look: Version is deprecated; No release in over two years.",
  "signals": [
    {
      "id": "deprecated",
      "severity": "high",
      "weight": 20,
      "title": "Version is deprecated",
      "detail": "The maintainers marked this version deprecated: \"use String.prototype.padStart()\""
    },
    {
      "id": "stale",
      "severity": "medium",
      "weight": 10,
      "title": "No release in over two years",
      "detail": "This version was published 3028 days ago and nothing newer has shipped. Security fixes are unlikely to arrive."
    }
  ],
  "mitigations": [],
  "facts": {
    "weeklyDownloads": 1357788,
    "maintainerCount": 3,
    "maintainers": ["sebmck", "stevemao", "westlac"],
    "lastPublisher": "stevemao",
    "publishedAt": "2018-04-09T01:10:45.796Z",
    "daysSincePublish": 3028,
    "packageAgeDays": 4515,
    "totalVersions": 15,
    "license": "WTFPL",
    "repository": "https://github.com/stevemao/left-pad",
    "deprecated": "use String.prototype.padStart()",
    "installScripts": {},
    "allScriptNames": ["test", "bench"],
    "provenance": {
      "present": false,
      "hasProvenance": false,
      "hasPublishAttestation": false,
      "predicateTypes": []
    },
    "integrity": { "hasIntegrity": true, "hasRegistrySignature": true },
    "typosquatMatches": [],
    "knownVulnerabilities": { "count": 0, "highestSeverity": null }
  }
}
```

Every finding carries its own weight and a reason, so the score is never a black
box — you can disagree with any single line and recompute in your head.

### How the risk score works

| Signal | Weight | Notes |
| --- | ---: | --- |
| Runs install/preinstall/postinstall scripts | +25 | The script body is quoted in the finding |
| Possible typosquat of a popular package | +30 / +18 | Only when adoption is low; see below |
| Known vulnerabilities | +25 … +5 | Scaled by highest severity |
| Version is deprecated | +20 | |
| No license declared | +15 | |
| No maintainers listed | +15 | |
| Brand-new package (< 30 days old) | +12 | |
| Non-standard license (`UNLICENSED`, `SEE LICENSE IN …`) | +12 | |
| Single maintainer (bus factor 1) | +12 / +5 | +5 when the package has ≥ 100k weekly downloads |
| No release in over two years | +10 | |
| No source repository declared | +8 | |
| Almost no adoption (< 100 downloads/week) | +8 | |
| Unrecognised license identifier | +6 | |
| Copyleft license (GPL/AGPL/LGPL) | +5 | Legitimate, but flagged for commercial use |
| No build provenance | +4 | Weak signal — most of npm lacks it |
| No registry signature | +3 | |
| Signed build provenance present | **−10** | A mitigation |

**Thresholds:** score ≥ 50 → `high`, ≥ 20 → `medium`, otherwise `low`. The score floors at zero.

**On typosquatting:** edit distance alone is far too noisy — `vuex` is one edit
from `vue`, and `preact` is close to `react`. The check therefore combines name
similarity with adoption: a package within one or two edits of a very popular
name *and* with low download volume is flagged at +30; the same similarity on a
package with 100k+ weekly downloads is reported as an informational note worth
0 points. Short target names use a tighter distance ceiling for the same reason.
Separator swaps (`lo-dash`), digit lookalikes (`re4ct`), doubled characters
(`expresss`) and scope impersonation (`@react/core`) are detected as distinct
techniques rather than by distance alone.

---

## `dependency_tree`

**Call:** `{ "name": "chalk", "version": "4.1.2", "depth": 3 }`

```
chalk@4.1.2 pulls in 5 unique packages (5 name@version pairs) within 3 levels.
Direct: 2 runtime · Tree nodes walked: 5 · Max depth reached: 3

Heaviest direct dependencies:
  ansi-styles@4.3.0 → 3 deps (3 exclusive)
  supports-color@7.2.0 → 2 deps (2 exclusive)
```
```json
{
  "root": { "name": "chalk", "version": "4.1.2", "requestedVersion": "4.1.2" },
  "options": { "depth": 3, "dev": false, "maxNodes": 500 },
  "stats": {
    "directDependencies": 2,
    "directDevDependencies": 9,
    "directPeerDependencies": 0,
    "totalUniqueDependencies": 5,
    "totalUniquePackages": 5,
    "totalNodes": 5,
    "maxDepthReached": 3,
    "conflictingPackages": [],
    "unresolvedEdges": 0,
    "packagesWithInstallScripts": []
  },
  "heaviestSubtrees": [
    { "name": "ansi-styles", "version": "4.3.0", "uniqueDependencies": 3, "exclusiveDependencies": 3 },
    { "name": "supports-color", "version": "7.2.0", "uniqueDependencies": 2, "exclusiveDependencies": 2 }
  ],
  "truncated": false,
  "truncationReason": null,
  "tree": {
    "name": "chalk",
    "range": "4.1.2",
    "version": "4.1.2",
    "kind": "prod",
    "depth": 0,
    "dependencies": [
      {
        "name": "ansi-styles",
        "range": "^4.1.0",
        "version": "4.3.0",
        "kind": "prod",
        "depth": 1,
        "dependencies": [
          {
            "name": "color-convert",
            "range": "^2.0.1",
            "version": "2.0.1",
            "kind": "prod",
            "depth": 2,
            "dependencies": [
              { "name": "color-name", "range": "~1.1.4", "version": "1.1.4", "kind": "prod", "depth": 3, "dependencies": [] }
            ]
          }
        ]
      },
      {
        "name": "supports-color",
        "range": "^7.1.0",
        "version": "7.2.0",
        "kind": "prod",
        "depth": 1,
        "dependencies": [
          { "name": "has-flag", "range": "^4.0.0", "version": "4.0.0", "kind": "prod", "depth": 2, "dependencies": [] }
        ]
      }
    ]
  }
}
```

A larger example — `express@4.18.2` at depth 2 — produces:

```
express@4.18.2 pulls in 47 unique packages (48 name@version pairs) within 2 levels.
Direct: 31 runtime · Tree nodes walked: 82 · Max depth reached: 2
⚠️ 1 package(s) appear at multiple versions: ms (2.0.0, 2.1.3)

Heaviest direct dependencies:
  send@0.18.0 → 14 deps (2 exclusive)
  body-parser@1.20.1 → 13 deps (4 exclusive)
  finalhandler@1.2.0 → 8 deps (1 exclusive)
  http-errors@2.0.0 → 6 deps (2 exclusive)
  serve-static@1.15.0 → 5 deps (1 exclusive)
```

Note the distinction between **unique dependencies** and **exclusive
dependencies**: `send` brings in 14 packages, but only 2 of them are not already
pulled in by another branch — so removing `send` would only actually remove 2
packages from the install.

Tree nodes carry `deduped`, `circular`, `truncated` and `unresolvedReason` flags
so nothing is silently dropped. Git, `file:`, `workspace:` and `npm:` alias
specifiers are reported with an explanation rather than being skipped.

---

## `compare_versions`

**Call:** `{ "name": "axios", "from": "0.27.2", "to": "1.7.0" }`

```
axios: 0.27.2 → 1.7.0
⚠️ major bump — likely breaking. Major version bumps signal intentional breaking changes — check the changelog.
753 days apart, with 38 releases in between.

Runtime dependencies: 2 → 3 (+1), 2 changes
Added (1):
  + proxy-from-env@^1.1.0
Bumped (1):
  ~ follow-redirects: ^1.14.9 → ^1.15.6

Bundle (min+gzip): 6.9 KB → 13 KB (+5.9 KB, +86.5%)
```

---

## `package_size`

**Call:** `{ "name": "express", "version": "4.18.2" }`

```
express@4.18.2 size report

Install footprint (estimated from registry metadata): ~1.9 MB on disk across 71 packages ·
  lower bound: the registry publishes no size for 17 of 71 packages (mostly pre-2018 publishes)
Bundle (min+gzip): 240 KB · minified: 595 KB · 31 dependencies
Tarball unpacked (this package alone): 209 KB across 16 files
Download time for the bundle: 39.4 s on slow 3G, 2.25 s on 4G
⚠️ Declares side effects — bundlers cannot tree-shake it away.
⚠️ 1 package(s) resolve at multiple versions and are counted once each: ms (2.0.0, 2.1.3)
Heaviest packages on disk: iconv-lite@0.4.24 (328 KB), qs@6.11.0 (224 KB),
  express@4.18.2 (209 KB), mime-db@1.52.0 (201 KB), object-inspect@1.13.4 (101 KB)
```

The install footprint is computed by resolving the production dependency graph
and summing `dist.unpackedSize`, using nothing but `registry.npmjs.org` — no
third-party size service is involved. Validated against a real install:

| | bytes |
| --- | ---: |
| Estimate | 1,999,033 |
| `npm install express@4.18.2`, measured | 2,198,164 |
| Accuracy | **90.9%** |

The 9% shortfall is fully explained by the 17 dependencies published before npm
began recording `unpackedSize` around 2018 (`etag@1.8.1`, `vary@1.1.2`,
`debug@2.6.9`…). That is why the figure is presented as a **lower bound** with
an explicit coverage count rather than as a measurement.

The structured output carries the full picture:

```json
{
  "estimatedInstall": {
    "totalSize": { "bytes": 1999033, "human": "1.9 MB" },
    "selfSize": { "bytes": 214459, "human": "209 KB" },
    "optionalSize": { "bytes": 0, "human": "0 B" },
    "packageCount": 71,
    "uniqueNames": 70,
    "coverage": 0.761,
    "missingSizeCount": 17,
    "missingSizePackages": ["etag@1.8.1", "vary@1.1.2", "debug@2.6.9", "fresh@0.5.2"],
    "conflictingPackages": [{ "name": "ms", "versions": ["2.0.0", "2.1.3"] }],
    "depthReached": 7,
    "truncated": false,
    "method": "Sum of dist.unpackedSize across the resolved production dependency graph.",
    "caveats": [
      "Counts each distinct name@version once, approximating npm hoisting; a real install duplicates a package when dependents need incompatible versions.",
      "Includes optional dependencies, which npm skips when their os/cpu do not match the host. Subtract optionalSize for a platform-agnostic floor.",
      "Cannot see lockfile pins, overrides/resolutions, or bundledDependencies.",
      "Excludes devDependencies, matching a production install.",
      "17 of 71 packages publish no unpackedSize, so the total is a lower bound."
    ],
    "source": "https://registry.npmjs.org"
  }
}
```

---

## `search_packages`

**Call:** `{ "query": "csv parser", "limit": 3 }`

```
57,404 packages match "csv parser"; showing the top 3.

1. fast-csv@5.0.7 — 12,928,747/week
   CSV parser and writer
   quality 1 · popularity 1 · maintenance 1 · last publish 2026-05-06
2. csv-parser@3.2.1 — 3,284,549/week
   Streaming CSV parser that aims for maximum speed as well as compatibility with the csv-spectrum test suite
   quality 1 · popularity 1 · maintenance 1 · last publish 2026-05-07
3. neat-csv@7.0.0 — 140,048/week
   Fast CSV parser
   quality 1 · popularity 1 · maintenance 1 · last publish 2021-10-18
```

---

## `download_stats`

**Call:** `{ "name": "react" }`

```
react: 644,862,076 downloads in the last month — ➡️ stable
Averaging 21,495,403 downloads/day.

Week over week: 145,362,748 → 135,056,225 (-7.1%) ➡️ stable
Month over month: 583,605,358 → 620,485,440 (+6.3%) ➡️ stable

Note: npm download counts include CI systems and mirrors, so they measure
automated traffic as much as human adoption.
```

Windows are anchored to *yesterday*, not today, because npm's download data lags
about a day — otherwise the most recent window would be partially empty and
every package would look like it was declining.

---

## `list_versions`

**Call:** `{ "name": "zod", "limit": 4 }`

```
zod: 875 versions published, often several releases a day (median gap under 12 hours).
Actively maintained: 15 releases in the last 90 days.
Latest: 4.4.3 (3 months ago)

Most recent 4 of 4 returned:
  4.4.3  2026-05-04T07:06:40.819Z  [latest]
  4.4.2  2026-05-01T21:30:03.830Z
  4.4.1  2026-04-29T23:13:08.282Z
  4.4.0  2026-04-29T22:39:44.590Z
```

---

## Error handling

Failures return an MCP error result (`isError: true`) with a message the model
can act on — the process never crashes and never returns a bare stack trace.

```
inspect_package failed (NOT_FOUND): Package "this-package-really-does-not-exist-xyzzy-42"
was not found on the npm registry.
Check the spelling, or use search_packages to find the right name.
```

```
inspect_package failed (NOT_FOUND): Version "9.9.9" of "lodash" does not exist.
Recent versions: 4.18.1, 4.18.0, 4.17.23, 4.17.21, 4.17.20. Dist-tags: latest.
```

```
inspect_package failed (INVALID_INPUT): Invalid arguments for inspect_package: name: Required
Expected properties: name, version.
```

```
inspect_package failed (INVALID_INPUT): "../../etc/passwd" is not a valid npm package name.
Names look like "lodash" or "@scope/name".
```

Note the second example: rather than a bare "not found", the server distinguishes
a missing *package* from a missing *version* and lists the versions that do
exist, so the assistant can retry correctly on the first attempt.
