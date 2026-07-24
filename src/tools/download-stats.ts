import { z } from 'zod';
import { getDownloadPoint, type DownloadPeriod } from '../lib/npm.js';
import { optional } from '../lib/errors.js';
import { formatPercent, humanCount, lines, momentumFrom, percentChange, type Momentum } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, type JsonSchemaObject } from './types.js';

const PERIODS = ['last-day', 'last-week', 'last-month', 'last-year'] as const;

const input = z.object({
  name: z.string().min(1).max(214),
  period: z.enum(PERIODS).optional().default('last-month')
});

export type DownloadStatsInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: packageNameSchema,
    period: {
      type: 'string',
      enum: [...PERIODS],
      default: 'last-month',
      description: 'Window for the headline download count. Defaults to "last-month".'
    }
  },
  required: ['name'],
  additionalProperties: false
};

export interface DateWindow {
  start: string;
  end: string;
}

export interface TrendWindows {
  currentWeek: DateWindow;
  previousWeek: DateWindow;
  currentMonth: DateWindow;
  previousMonth: DateWindow;
}

const MS_PER_DAY = 86_400_000;

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export function computeTrendWindows(now: Date = new Date()): TrendWindows {
  const anchor = shiftDays(new Date(`${toIso(now)}T00:00:00.000Z`), -1);

  const currentWeekEnd = anchor;
  const currentWeekStart = shiftDays(currentWeekEnd, -6);
  const previousWeekEnd = shiftDays(currentWeekStart, -1);
  const previousWeekStart = shiftDays(previousWeekEnd, -6);

  const currentMonthEnd = anchor;
  const currentMonthStart = shiftDays(currentMonthEnd, -29);
  const previousMonthEnd = shiftDays(currentMonthStart, -1);
  const previousMonthStart = shiftDays(previousMonthEnd, -29);

  return {
    currentWeek: { start: toIso(currentWeekStart), end: toIso(currentWeekEnd) },
    previousWeek: { start: toIso(previousWeekStart), end: toIso(previousWeekEnd) },
    currentMonth: { start: toIso(currentMonthStart), end: toIso(currentMonthEnd) },
    previousMonth: { start: toIso(previousMonthStart), end: toIso(previousMonthEnd) }
  };
}

export interface TrendComparison {
  current: number | null;
  previous: number | null;
  changePercent: number | null;
  momentum: Momentum;
  window: { current: DateWindow; previous: DateWindow };
}

export interface DownloadStatsResult {
  name: string;
  period: DownloadPeriod;
  downloads: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  weekOverWeek: TrendComparison;
  monthOverMonth: TrendComparison;
  overallMomentum: Momentum;
  averagePerDay: number | null;
  notes: string[];
}

function describeMomentum(momentum: Momentum): string {
  switch (momentum) {
    case 'growing': return '📈 growing';
    case 'declining': return '📉 declining';
    case 'stable': return '➡️ stable';
    case 'unknown': return '❓ unknown';
  }
}

export function combineMomentum(weekly: Momentum, monthly: Momentum): Momentum {
  if (weekly === monthly) return weekly;
  if (monthly === 'unknown') return weekly;
  if (weekly === 'unknown') return monthly;
  
  return monthly;
}

function buildSummary(result: DownloadStatsResult): string {
  if (result.downloads === null) {
    return `No download data is available for ${result.name}. The package may be brand new, unpublished, or private.`;
  }

  return lines(
    `${result.name}: ${humanCount(result.downloads)} downloads in the ${result.period.replace('last-', 'last ')} — ${describeMomentum(
      result.overallMomentum,
    )}`,
    result.averagePerDay !== null ? `Averaging ${humanCount(result.averagePerDay)} downloads/day.` : null,
    '',
    `Week over week: ${humanCount(result.weekOverWeek.previous)} → ${humanCount(result.weekOverWeek.current)} (${formatPercent(
      result.weekOverWeek.changePercent,
    )}) ${describeMomentum(result.weekOverWeek.momentum)}`,
    `Month over month: ${humanCount(result.monthOverMonth.previous)} → ${humanCount(
      result.monthOverMonth.current,
    )} (${formatPercent(result.monthOverMonth.changePercent)}) ${describeMomentum(result.monthOverMonth.momentum)}`,
    '',
    'Note: npm download counts include CI systems and mirrors, so they measure automated traffic as much as human adoption.'
  );
}

function compare(
  current: number | null,
  previous: number | null,
  window: { current: DateWindow; previous: DateWindow },
): TrendComparison {
  const changePercent = current !== null && previous !== null ? percentChange(previous, current) : null;

  return { current, previous, changePercent, momentum: momentumFrom(changePercent), window };
}

const PERIOD_DAYS: Record<DownloadPeriod, number> = {
  'last-day': 1,
  'last-week': 7,
  'last-month': 30,
  'last-year': 365
};

export async function downloadStats(args: DownloadStatsInput): Promise<DownloadStatsResult> {
  const windows = computeTrendWindows();

  const [point, currentWeek, previousWeek, currentMonth, previousMonth] = await Promise.all([
    optional('npm downloads', () => getDownloadPoint(args.name, args.period)),
    optional('npm downloads', () => getDownloadPoint(args.name, `${windows.currentWeek.start}:${windows.currentWeek.end}`)),
    optional('npm downloads', () => getDownloadPoint(args.name, `${windows.previousWeek.start}:${windows.previousWeek.end}`)),
    optional('npm downloads', () => getDownloadPoint(args.name, `${windows.currentMonth.start}:${windows.currentMonth.end}`)),
    optional('npm downloads', () =>
      getDownloadPoint(args.name, `${windows.previousMonth.start}:${windows.previousMonth.end}`)
    )
  ]);

  const weekOverWeek = compare(currentWeek.value?.downloads ?? null, previousWeek.value?.downloads ?? null, {
    current: windows.currentWeek,
    previous: windows.previousWeek,
  });

  const monthOverMonth = compare(currentMonth.value?.downloads ?? null, previousMonth.value?.downloads ?? null, {
    current: windows.currentMonth,
    previous: windows.previousMonth,
  });

  const downloads = point.value?.downloads ?? null;
  const notes = [point.note, currentWeek.note, previousWeek.note, currentMonth.note, previousMonth.note].filter((note): note is string => note !== null);

  return {
    name: args.name,
    period: args.period,
    downloads,
    periodStart: point.value?.start ?? null,
    periodEnd: point.value?.end ?? null,
    weekOverWeek,
    monthOverMonth,
    overallMomentum: combineMomentum(weekOverWeek.momentum, monthOverMonth.momentum),
    averagePerDay: downloads === null ? null : Math.round(downloads / PERIOD_DAYS[args.period]),
    notes: [...new Set(notes)]
  };
}

export const downloadStatsTool = defineTool({
  name: 'download_stats',
  title: 'Download counts and trend',
  description:
    'Get npm download counts for a package plus momentum: last week vs the prior week, and last 30 days vs the prior ' +
    '30 days, each labelled growing / stable / declining. Use this to gauge real-world adoption, to tell whether a ' +
    'library is gaining or losing traction, or to compare two candidate packages by usage. Note that npm counts ' +
    'include CI and mirror traffic.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await downloadStats(args);

    return toolText(buildSummary(result), result, result.notes);
  }
});
