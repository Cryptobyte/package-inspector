import { z } from 'zod';
import { getBulkDownloads, searchRegistry } from '../lib/npm.js';
import { optional } from '../lib/errors.js';
import { humanCount, lines, truncate } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, type JsonSchemaObject } from './types.js';

const input = z.object({
  query: z.string().min(1).max(250),
  limit: z.number().int().min(1).max(25).optional().default(10)
});

export type SearchPackagesInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 250,
      description:
        'Search text. Supports npm search qualifiers such as "keywords:cli", "author:sindresorhus", "is:unstable".'
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 25,
      default: 10,
      description: 'Number of results to return. Defaults to 10.'
    }
  },
  required: ['query'],
  additionalProperties: false
};

export interface SearchHit {
  rank: number;
  name: string;
  version: string;
  description: string | null;
  keywords: string[];
  publisher: string | null;
  lastPublishedAt: string | null;
  weeklyDownloads: number | null;
  links: { npm: string | null; homepage: string | null; repository: string | null };
  scores: { final: number; quality: number; popularity: number; maintenance: number };
}

export interface SearchPackagesResult {
  query: string;
  totalMatches: number;
  returned: number;
  results: SearchHit[];
  notes: string[];
}

function round(value: number | undefined): number {
  return typeof value === 'number' ? Number(value.toFixed(3)) : 0;
}

function buildSummary(result: SearchPackagesResult): string {
  if (result.results.length === 0) {
    return `No npm packages matched "${result.query}". Try broader terms or a different spelling.`;
  }

  const rows = result.results
    .map((hit) => {
      const downloads = hit.weeklyDownloads === null ? 'downloads unknown' : `${humanCount(hit.weeklyDownloads)}/week`;

      return lines(
        `${hit.rank}. ${hit.name}@${hit.version} — ${downloads}`,
        `   ${hit.description ?? 'No description.'}`,
        `   quality ${hit.scores.quality} · popularity ${hit.scores.popularity} · maintenance ${hit.scores.maintenance}` +
          (hit.lastPublishedAt ? ` · last publish ${hit.lastPublishedAt.slice(0, 10)}` : '')
      );
    })
    .join('\n');

  return lines(
    `${humanCount(result.totalMatches)} packages match "${result.query}"; showing the top ${result.returned}.`,
    '',
    rows
  );
}

export async function searchPackages(args: SearchPackagesInput): Promise<SearchPackagesResult> {
  const { total, objects } = await searchRegistry(args.query, args.limit);

  const names = objects.map((object) => object.package.name);
  const downloads = await optional('npm downloads', () => getBulkDownloads(names, 'last-week'));
  const results: SearchHit[] = objects.map((object, index) => ({
    rank: index + 1,
    name: object.package.name,
    version: object.package.version,
    description: truncate(object.package.description, 180),
    keywords: object.package.keywords ?? [],
    publisher: object.package.publisher?.username ?? null,
    lastPublishedAt: object.package.date ?? null,
    weeklyDownloads: downloads.value?.get(object.package.name) ?? null,
    links: {
      npm: object.package.links?.npm ?? null,
      homepage: object.package.links?.homepage ?? null,
      repository: object.package.links?.repository ?? null
    },
    scores: {
      final: round(object.score?.final),
      quality: round(object.score?.detail?.quality),
      popularity: round(object.score?.detail?.popularity),
      maintenance: round(object.score?.detail?.maintenance)
    }
  }));

  return {
    query: args.query,
    totalMatches: total,
    returned: results.length,
    results,
    notes: downloads.note ? [downloads.note] : []
  };
}

export const searchPackagesTool = defineTool({
  name: 'search_packages',
  title: 'Search npm packages',
  description:
    'Search the npm registry and return ranked results with name, description, latest version, weekly downloads, and ' +
    "npm's own quality/popularity/maintenance scores. Use this when the user describes what they need rather than " +
    'naming a package ("a library for parsing CSV"), when you need to find alternatives to compare, or when a package ' +
    'name might be misspelled. Supports npm search qualifiers like "keywords:cli" and "author:name".',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await searchPackages(args);
    
    return toolText(buildSummary(result), result, result.notes);
  }
});
