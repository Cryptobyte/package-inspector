#!/usr/bin/env node
/**
 * Publishes a version of this MCP server to its MCP Commons listing.
 *
 *   POST https://mcpcommons.com/api/v1/tools/{slug}/versions
 *
 * Notes on the API this targets (https://mcpcommons.com/api):
 *   - `version`, `repo` and `tools` are required. Every other field is optional
 *     and, when sent, updates the listing exactly as the creator form does.
 *   - `tools` is the declared tool surface the review checks the code against,
 *     so it is collected from the running server by collect-tools.mjs rather
 *     than maintained by hand. Omitting it is rejected outright.
 *   - Versions are immutable. Re-publishing one returns 409 `version_exists`.
 *     That is treated here as an idempotent no-op so re-running a release job
 *     does not fail the build.
 *   - Rate limit is 10 requests per hour on this endpoint, so this script does
 *     not retry aggressively.
 *
 * Reads configuration from the environment so nothing sensitive is ever passed
 * on argv (argv is visible to other processes; env is not).
 *
 * Required : MCPC_API_KEY, MCPC_SLUG, MCPC_VERSION, MCPC_REPO, MCPC_REF
 * Optional : MCPC_TOOLS_FILE (default "tools.json"; collected automatically if
 *            absent), MCPC_LANGUAGE (default "typescript"), MCPC_TRANSPORT
 *            (default "stdio"), MCPC_EGRESS (JSON array), MCPC_DRY_RUN
 *            ("true"), MCPC_API_BASE (default "https://mcpcommons.com/api/v1")
 */

const API_BASE = process.env.MCPC_API_BASE ?? 'https://mcpcommons.com/api/v1';
const TIMEOUT_MS = 30_000;

/** GitHub Actions workflow-command annotations; harmless when run locally. */
const annotate = {
  notice: (message) => console.log(`::notice::${message}`),
  warn: (message) => console.log(`::warning::${message}`),
  error: (message) => console.log(`::error::${message}`),
};

function fail(message, details) {
  annotate.error(message);
  if (details) console.error(details);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') fail(`Missing required environment variable ${name}.`);
  return value.trim();
}

/** Appends a markdown block to the Actions run summary, if we are in Actions. */
async function summarize(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${markdown}\n`);
}

function parseEgress(raw) {
  if (!raw || raw.trim() === '') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`MCPC_EGRESS is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(parsed) || parsed.some((host) => typeof host !== 'string')) {
    fail('MCPC_EGRESS must be a JSON array of hostname strings.');
  }
  return parsed;
}

/** `v1.2.3` -> `1.2.3`; the API wants a bare version, the ref keeps its tag. */
function versionFromTag(tag) {
  return tag.replace(/^v/, '');
}

/**
 * Resolves the tool-surface file, collecting it if it is not already there.
 *
 * Deliberately self-sufficient rather than depending on a prior workflow step.
 * The job checks out the release tag for these scripts while the workflow YAML
 * comes from the triggering ref, so the two can be from different commits — a
 * newer script driven by an older workflow would otherwise fail on a variable
 * the old workflow never learned to set. Defaulting and self-collecting means
 * this script works no matter which workflow version invokes it.
 */
async function resolveToolsFile() {
  const path = process.env.MCPC_TOOLS_FILE?.trim() || 'tools.json';
  const { existsSync } = await import('node:fs');
  if (existsSync(path)) return path;

  console.log(`No tool surface at ${path}; collecting it from the built server.`);
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const collector = fileURLToPath(new URL('collect-tools.mjs', import.meta.url));

  const result = spawnSync(process.execPath, [collector, path], { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(
      'Could not collect the tool surface, which the API requires.',
      'Check that the project is built (npm run build) and that the manifest entrypoint boots.',
    );
  }
  return path;
}

/**
 * Loads the tool surface collected from the running server. Required by the
 * API, and validated here so a malformed file fails before a request is spent
 * against the 10-per-hour limit.
 */
async function loadTools(path) {
  const { readFile } = await import('node:fs/promises');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    fail(`Could not read the tool surface at ${path}: ${err?.message ?? err}`, 'Run collect-tools.mjs first.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${path} is not valid JSON.`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail(`${path} must be a non-empty array of tools. Publishing an empty tool surface is rejected by the API.`);
  }
  const malformed = parsed.filter(
    (tool) => typeof tool?.name !== 'string' || typeof tool?.description !== 'string' || tool.name === '' || tool.description === '',
  );
  if (malformed.length > 0) {
    fail(`Every entry in ${path} needs a non-empty name and description; ${malformed.length} do not.`);
  }

  return parsed.map((tool) => ({ name: tool.name, description: tool.description }));
}

const apiKey = required('MCPC_API_KEY');
const slug = required('MCPC_SLUG');
const ref = required('MCPC_REF');
const version = versionFromTag(process.env.MCPC_VERSION?.trim() || ref);
const repo = required('MCPC_REPO');

const tools = await loadTools(await resolveToolsFile());

const body = {
  version,
  repo,
  ref,
  language: process.env.MCPC_LANGUAGE?.trim() || 'typescript',
  transport: process.env.MCPC_TRANSPORT?.trim() || 'stdio',
  tools,
};

const egress = parseEgress(process.env.MCPC_EGRESS);
if (egress) body.egress_allowlist = egress;

if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  fail(`MCPC_REPO must look like "owner/repo", got "${repo}".`);
}

const endpoint = `${API_BASE}/tools/${encodeURIComponent(slug)}/versions`;

console.log(`Publishing ${slug} version ${version} (ref ${ref}) to MCP Commons`);
console.log(`  endpoint : POST ${endpoint}`);
console.log(`  tools    : ${tools.length} (${tools.map((t) => t.name).join(', ')})`);
console.log(`  body     : ${JSON.stringify({ ...body, tools: `[${tools.length} tools]` }, null, 2)}`);

if (process.env.MCPC_DRY_RUN === 'true') {
  annotate.notice(`Dry run: would publish ${slug}@${version}. No request sent.`);
  await summarize(
    [
      `### MCP Commons — dry run`,
      ``,
      `No request was sent. The request that *would* be sent:`,
      ``,
      '```json',
      JSON.stringify(body, null, 2),
      '```',
    ].join('\n'),
  );
  process.exit(0);
}

/** Reads the body as JSON when possible, falling back to raw text. */
async function readBody(response) {
  const text = await response.text();
  if (text.trim() === '') return { json: null, text: '' };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

async function post() {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': `${repo}/publish-listing (+https://github.com/${repo})`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

let response;
try {
  response = await post();
} catch (err) {
  const reason = err?.name === 'TimeoutError' ? `no response within ${TIMEOUT_MS}ms` : (err?.message ?? String(err));
  fail(`Could not reach the MCP Commons API: ${reason}`);
}

// One bounded retry, and only when the API asks for a short wait. The endpoint
// allows 10 requests per hour, so a long Retry-After means giving up is correct.
if (response.status === 429) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) {
    annotate.warn(`Rate limited; retrying once in ${retryAfter}s.`);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    response = await post();
  }
}

const { json, text } = await readBody(response);
const errorCode = json?.error;
const apiMessage = json?.message ?? text;

if (response.status === 202) {
  annotate.notice(`Queued ${slug}@${version} for review on MCP Commons.`);
  await summarize(
    [
      `### MCP Commons — \`${slug}@${version}\` queued for review`,
      ``,
      `| | |`,
      `| --- | --- |`,
      `| Version | \`${version}\` |`,
      `| Ref | \`${ref}\` |`,
      `| Repo | \`${repo}\` |`,
      `| Transport | \`${body.transport}\` |`,
      `| Language | \`${body.language}\` |`,
      `| Egress allowlist | ${egress ? egress.map((h) => `\`${h}\``).join(', ') : '_not sent_'} |`,
      `| Tools declared | ${tools.length} |`,
      ``,
      `<details><summary>Declared tool surface (collected from the running server)</summary>`,
      ``,
      ...tools.map((tool) => `- \`${tool.name}\``),
      ``,
      `</details>`,
      ``,
      `Review is automated; flagged submissions are held for a human.`,
      `Track it at https://mcpcommons.com/listing/${slug}`,
    ].join('\n'),
  );
  process.exit(0);
}

// Immutable versions: a re-run of the same release is a no-op, not a failure.
if (response.status === 409 && errorCode === 'version_exists') {
  annotate.notice(`Version ${version} is already published on MCP Commons; nothing to do.`);
  await summarize(`### MCP Commons\n\n\`${slug}@${version}\` was already published. Versions are immutable, so this run was a no-op.`);
  process.exit(0);
}

/** Actionable guidance for the documented failure codes. */
const REMEDIES = {
  unauthorized: 'The MCPC_API_KEY secret is missing or empty. Mint a key at https://mcpcommons.com/keys and add it as a repository secret.',
  invalid_key: 'The API key is unknown or revoked. Mint a fresh one at https://mcpcommons.com/keys and update the MCPC_API_KEY secret.',
  github_not_connected: 'Connect your GitHub account to MCP Commons in the dashboard, then re-run this job.',
  no_such_listing: `No listing with slug "${slug}" exists on your account. Check the slug, or create the listing first.`,
  version_exists: `Version ${version} already exists and versions are immutable. Tag a new version.`,
  invalid_body: 'The request body failed validation; the offending field is named above.',
  rate_limited: 'Rate limit hit (10 version publishes per hour). Wait and re-run this job.',
  payouts_required: 'A paid listing needs Stripe payouts connected in the dashboard.',
  payment_method_required: 'A hosted listing needs a payment method on file.',
};

const remedy = REMEDIES[errorCode];
const field = json?.field ? ` (field: ${json.field})` : '';

fail(
  `MCP Commons rejected the publish: HTTP ${response.status}${errorCode ? ` ${errorCode}` : ''} — ${apiMessage}${field}`,
  [remedy, text && text !== apiMessage ? `Raw response: ${text}` : null].filter(Boolean).join('\n'),
);
