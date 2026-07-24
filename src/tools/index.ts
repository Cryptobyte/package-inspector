import { analyzeSupplyChainTool } from './analyze-supply-chain.js';
import { auditDependenciesTool } from './audit-dependencies.js';
import { checkVulnerabilitiesTool } from './check-vulnerabilities.js';
import { compareVersionsTool } from './compare-versions.js';
import { dependencyTreeTool } from './dependency-tree.js';
import { downloadStatsTool } from './download-stats.js';
import { inspectPackageTool } from './inspect-package.js';
import { listVersionsTool } from './list-versions.js';
import { packageSizeTool } from './package-size.js';
import { searchPackagesTool } from './search-packages.js';
import type { RegisteredTool } from './types.js';

export const TOOLS: readonly RegisteredTool[] = [
  inspectPackageTool,
  auditDependenciesTool,
  listVersionsTool,
  dependencyTreeTool,
  checkVulnerabilitiesTool,
  packageSizeTool,
  compareVersionsTool,
  analyzeSupplyChainTool,
  searchPackagesTool,
  downloadStatsTool
];

export const TOOLS_BY_NAME: ReadonlyMap<string, RegisteredTool> = new Map(TOOLS.map((tool) => [tool.name, tool]));
