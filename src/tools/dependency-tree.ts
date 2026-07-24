import { z } from 'zod';
import { getAbbreviatedPackument, getPackument, getVersionManifest, resolveVersion } from '../lib/npm.js';
import { classifyNonRegistrySpec, maxSatisfying } from '../lib/semver.js';
import { DEFAULT_CONCURRENCY, mapLimit } from '../lib/concurrency.js';
import { humanCount, lines, plural } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const DEFAULT_MAX_NODES = 500;

const input = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional(),
  depth: z.number().int().min(1).max(8).optional().default(3),
  dev: z.boolean().optional().default(false),
  maxNodes: z.number().int().min(10).max(2000).optional().default(DEFAULT_MAX_NODES)
});

export type DependencyTreeInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: packageNameSchema,
    version: versionSchema,
    depth: {
      type: 'integer',
      minimum: 1,
      maximum: 8,
      default: 3,
      description: 'How many levels deep to resolve. Defaults to 3. Higher values are much slower.'
    },
    dev: {
      type: 'boolean',
      default: false,
      description:
        "Include the root package's devDependencies. Transitive dev dependencies are never installed, so they are " +
        'never expanded. Defaults to false.'
    },
    maxNodes: {
      type: 'integer',
      minimum: 10,
      maximum: 2000,
      default: DEFAULT_MAX_NODES,
      description: 'Safety cap on total nodes resolved. Defaults to 500; the result flags when it is hit.'
    }
  },
  required: ['name'],
  additionalProperties: false
};

export type EdgeKind = 'prod' | 'dev' | 'peer' | 'optional';

export interface TreeNode {
  name: string;
  range: string;
  version: string | null;
  kind: EdgeKind;
  depth: number;
  dependencies: TreeNode[];
  deduped?: boolean;
  circular?: boolean;
  truncated?: boolean;
  unresolvedReason?: string;
}

export interface HeavySubtree {
  name: string;
  version: string | null;
  uniqueDependencies: number;
  exclusiveDependencies: number;
}

export interface DependencyTreeResult {
  root: { name: string; version: string; requestedVersion: string };
  options: { depth: number; dev: boolean; maxNodes: number };
  stats: {
    directDependencies: number;
    directDevDependencies: number;
    directPeerDependencies: number;
    totalUniqueDependencies: number;
    totalUniquePackages: number;
    totalNodes: number;
    maxDepthReached: number;
    conflictingPackages: Array<{ name: string; versions: string[] }>;
    unresolvedEdges: number;
    packagesWithInstallScripts: string[];
  };

  heaviestSubtrees: HeavySubtree[];
  truncated: boolean;
  truncationReason: string | null;
  tree: TreeNode;
}

interface WalkState {
  expanded: Set<string>;
  seen: Set<string>;
  byName: Map<string, Set<string>>;
  installScripts: Set<string>;
  nodes: number;
  unresolved: number;
  maxDepthReached: number;
  truncated: boolean;
  truncationReason: string | null;
}

interface Edge {
  name: string;
  range: string;
  kind: EdgeKind;
}

export function collectEdges(
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    optionalDependencies?: Record<string, string>;
  },
  options: { includeDev: boolean; includePeer: boolean }
): Edge[] {
  const edges: Edge[] = [];
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));

  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    edges.push({ name, range, kind: optionalNames.has(name) ? 'optional' : 'prod' });
  }

  for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (!edges.some((edge) => edge.name === name)) edges.push({ name, range, kind: 'optional' });
  }

  if (options.includeDev) {
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      edges.push({ name, range, kind: 'dev' });
    }
  }

  if (options.includePeer) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional === true) continue;

      if (!edges.some((edge) => edge.name === name)) {
        edges.push({ name, range, kind: 'peer' });
      }
    }
  }

  return edges;
}

function unresolvableReason(range: string): string | null {
  const spec = classifyNonRegistrySpec(range);

  if (!spec) return null;
  switch (spec.kind) {
    case 'alias':
      return `npm alias of ${spec.aliasOf?.name}@${spec.aliasOf?.range} (not expanded)`;

    case 'git':
      return 'git dependency (not published to the registry)';

    case 'url':
      return 'tarball URL dependency';

    case 'file':
      return 'local file dependency';

    case 'workspace':
      return 'workspace protocol dependency';

    case 'link':
      return 'linked local dependency';

    case 'tag':
      return `dist-tag or non-semver range "${range}"`;
  }
}

async function resolveEdge(edge: Edge): Promise<{ version: string | null; reason?: string }> {
  const reason = unresolvableReason(edge.range);

  if (reason !== null) {
    const spec = classifyNonRegistrySpec(edge.range);

    if (spec?.kind === 'tag') {
      const abbreviated = await getAbbreviatedPackument(edge.name).catch(() => null);
      const tagged = abbreviated?.distTags[edge.range];

      if (tagged) {
        return { version: tagged };
      }
    }

    return { version: null, reason };
  }

  const abbreviated = await getAbbreviatedPackument(edge.name).catch(() => null);
  if (!abbreviated) {
    return { version: null, reason: 'package not found on the registry' };
  }

  const resolved = maxSatisfying(Object.keys(abbreviated.versions), edge.range);
  if (!resolved) {
    return { 
      version: null, 
      reason: `no published version satisfies "${edge.range}"` 
    };
  }

  return { version: resolved };
}

async function walk(
  edges: readonly Edge[],
  depth: number,
  maxDepth: number,
  ancestors: ReadonlySet<string>,
  state: WalkState,
  maxNodes: number,
): Promise<TreeNode[]> {
  if (edges.length === 0) return [];

  return mapLimit(edges, DEFAULT_CONCURRENCY, async (edge): Promise<TreeNode> => {
    if (state.nodes >= maxNodes) {
      state.truncated = true;
      state.truncationReason = `Node cap of ${maxNodes} reached; some branches were not expanded.`;

      return { 
        name: edge.name, 
        range: edge.range, 
        version: null, 
        kind: edge.kind, 
        depth, 
        dependencies: [], 
        truncated: true 
      };
    }

    state.nodes += 1;
    state.maxDepthReached = Math.max(state.maxDepthReached, depth);

    const { version, reason } = await resolveEdge(edge);
    const node: TreeNode = {
      name: edge.name,
      range: edge.range,
      version,
      kind: edge.kind,
      depth,
      dependencies: [],
    };

    if (version === null) {
      state.unresolved += 1;

      if (reason) {
        node.unresolvedReason = reason;
      }

      return node;
    }

    const key = `${edge.name}@${version}`;
    state.seen.add(key);
    const versions = state.byName.get(edge.name) ?? new Set<string>();
    versions.add(version);
    state.byName.set(edge.name, versions);

    if (ancestors.has(key)) {
      node.circular = true;
      return node;
    }

    if (depth >= maxDepth) {
      const abbreviated = await getAbbreviatedPackument(edge.name).catch(() => null);
      const entry = abbreviated?.versions[version];
      if (entry?.hasInstallScript) {
        state.installScripts.add(key);
      }

      const childCount = Object.keys(entry?.dependencies ?? {}).length;
      if (childCount > 0) {
        node.truncated = true;
      }

      return node;
    }

    const abbreviated = await getAbbreviatedPackument(edge.name).catch(() => null);
    const entry = abbreviated?.versions[version];
    if (!entry) return node;

    if (entry.hasInstallScript) {
      state.installScripts.add(key);
    }

    if (state.expanded.has(key)) {
      const childCount = Object.keys(entry.dependencies ?? {}).length;

      if (childCount > 0) {
        node.deduped = true;
      }

      return node;
    }

    state.expanded.add(key);

    const childEdges = collectEdges(entry, { 
      includeDev: false, 
      includePeer: false 
    });

    node.dependencies = await walk(
      childEdges,
      depth + 1,
      maxDepth,
      new Set([...ancestors, key]),
      state,
      maxNodes
    );

    return node;
  });
}

function collectSubtreeKeys(node: TreeNode, into: Set<string>): void {
  for (const child of node.dependencies) {
    if (child.version) {
      into.add(`${child.name}@${child.version}`);
    }

    collectSubtreeKeys(child, into);
  }
}

export function computeHeaviestSubtrees(root: TreeNode, limit = 5): HeavySubtree[] {
  const perChild = root.dependencies.map((child) => {
    const keys = new Set<string>();

    if (child.version) {
      keys.add(`${child.name}@${child.version}`);
    }

    collectSubtreeKeys(child, keys);

    return { child, keys };
  });

  return perChild
    .map(({ child, keys }) => {
      const others = perChild.filter((entry) => entry.child !== child);
      const exclusive = [...keys].filter((key) => !others.some((entry) => entry.keys.has(key)));

      return {
        name: child.name,
        version: child.version,
        uniqueDependencies: keys.size,
        exclusiveDependencies: exclusive.length
      };
    })
    .sort((a, b) => b.uniqueDependencies - a.uniqueDependencies || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function buildSummary(result: DependencyTreeResult): string {
  const { stats } = result;
  const verdict =
    stats.totalUniquePackages === 0
      ? 'has no runtime dependencies — zero-dependency package.'
      : `pulls in ${plural(stats.totalUniquePackages, 'unique package')} (${plural(
          stats.totalUniqueDependencies,
          'name@version pair',
        )}) within ${plural(result.options.depth, 'level')}.`;

  const heaviest = result.heaviestSubtrees
    .slice(0, 5)
    .map((entry) => `  ${entry.name}@${entry.version ?? '?'} → ${entry.uniqueDependencies} deps (${entry.exclusiveDependencies} exclusive)`)
    .join('\n');

  return lines(
    `${result.root.name}@${result.root.version} ${verdict}`,
    `Direct: ${stats.directDependencies} runtime${result.options.dev ? `, ${stats.directDevDependencies} dev` : ''}${
      stats.directPeerDependencies > 0 ? `, ${stats.directPeerDependencies} peer` : ''
    } · Tree nodes walked: ${humanCount(stats.totalNodes)} · Max depth reached: ${stats.maxDepthReached}`,
    stats.conflictingPackages.length > 0
      ? `⚠️ ${stats.conflictingPackages.length} package(s) appear at multiple versions: ${stats.conflictingPackages
          .slice(0, 5)
          .map((entry) => `${entry.name} (${entry.versions.join(', ')})`)
          .join('; ')}`
      : null,
    stats.packagesWithInstallScripts.length > 0
      ? `⚠️ ${stats.packagesWithInstallScripts.length} package(s) run install scripts: ${stats.packagesWithInstallScripts
          .slice(0, 8)
          .join(', ')}`
      : null,
    stats.unresolvedEdges > 0 ? `${stats.unresolvedEdges} edge(s) could not be resolved from the registry.` : null,
    result.truncated ? `⚠️ ${result.truncationReason}` : null,
    heaviest ? `\nHeaviest direct dependencies:\n${heaviest}` : null
  );
}

export async function dependencyTree(args: DependencyTreeInput): Promise<DependencyTreeResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const manifest = await getVersionManifest(packument.name, resolved.version);

  const rootEdges = collectEdges(manifest, { 
    includeDev: args.dev, 
    includePeer: true 
  });

  const state: WalkState = {
    expanded: new Set(),
    seen: new Set(),
    byName: new Map(),
    installScripts: new Set(),
    nodes: 0,
    unresolved: 0,
    maxDepthReached: 0,
    truncated: false,
    truncationReason: null
  };

  const rootKey = `${packument.name}@${resolved.version}`;
  const children = await walk(rootEdges, 1, args.depth, new Set([rootKey]), state, args.maxNodes);

  const tree: TreeNode = {
    name: packument.name,
    range: resolved.requested,
    version: resolved.version,
    kind: 'prod',
    depth: 0,
    dependencies: children
  };

  const conflictingPackages = [...state.byName.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
    .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));

  const result: DependencyTreeResult = {
    root: { name: packument.name, version: resolved.version, requestedVersion: resolved.requested },
    options: { depth: args.depth, dev: args.dev, maxNodes: args.maxNodes },
    stats: {
      directDependencies: rootEdges.filter((edge) => edge.kind === 'prod' || edge.kind === 'optional').length,
      directDevDependencies: Object.keys(manifest.devDependencies ?? {}).length,
      directPeerDependencies: Object.keys(manifest.peerDependencies ?? {}).length,
      totalUniqueDependencies: state.seen.size,
      totalUniquePackages: state.byName.size,
      totalNodes: state.nodes,
      maxDepthReached: state.maxDepthReached,
      conflictingPackages,
      unresolvedEdges: state.unresolved,
      packagesWithInstallScripts: [...state.installScripts].sort()
    },
    heaviestSubtrees: computeHeaviestSubtrees(tree),
    truncated: state.truncated,
    truncationReason: state.truncationReason,
    tree
  };

  return result;
}

export const dependencyTreeTool = defineTool({
  name: 'dependency_tree',
  title: 'Resolve dependency tree',
  description:
    'Resolve an npm package\'s dependency tree from registry metadata to a given depth, returning the nested tree plus ' +
    'stats: unique dependency count, max depth, packages appearing at conflicting versions, packages that run install ' +
    'scripts, and the heaviest sub-trees. Use this for "how many dependencies does X have", "what does X pull in", ' +
    '"why is my node_modules so big", or to spot bloat before adding a dependency. Cycles are detected and the walk is ' +
    'capped, so results may be flagged as truncated.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await dependencyTree(args);

    return toolText(buildSummary(result), result);
  }
});
