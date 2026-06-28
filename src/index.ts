#!/usr/bin/env node
/**
 * ParamGuard — command-line entry point.
 *
 * Parses arguments with Commander, resolves them into a strict
 * {@link ScanOptions}, runs the {@link Scanner}, and renders an ESLint-style,
 * colour-coded report to the terminal. The process exit code reflects whether
 * any tracked parameter was dropped.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';
import {
  bold,
  cyan,
  dim,
  gray,
  green,
  isColorSupported,
  red,
  underline,
  yellow,
} from 'colorette';

import { Scanner, extractParams } from './scanner.js';
import {
  DEFAULT_TRACKED_PARAMS,
  SEVERITY_EXIT_CODE,
  type RouteReport,
  type ScanOptions,
  type ScanResult,
  type Severity,
} from './types.js';

/** Raw option shape produced by Commander before resolution. */
interface RawCliOptions {
  readonly url: string;
  readonly params?: string;
  readonly maxLinks: number;
  readonly timeout: number;
  readonly settle: number;
  readonly headless: boolean;
  readonly sameHost: boolean;
  readonly userAgent?: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly noColor?: boolean;
}

const PROGRAM_NAME = 'paramguard';
const PROGRAM_VERSION = '1.0.0';

/**
 * Parse a CLI argument as a positive integer, throwing Commander's typed error
 * so the framework prints a clean usage message.
 */
function parsePositiveInt(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      `${fieldName} must be a non-negative integer (received "${value}").`,
    );
  }
  return parsed;
}

/** Split a comma-separated parameter list into a clean, de-duplicated array. */
function parseParamList(value: string): readonly string[] {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(items));
}

/** Build and configure the Commander program. */
function buildProgram(): Command {
  const program = new Command();

  program
    .name(PROGRAM_NAME)
    .description(
      'Detect when UTM tracking parameters silently vanish across redirects and in-page navigations.',
    )
    .version(PROGRAM_VERSION, '-v, --version', 'Print the ParamGuard version.')
    .requiredOption(
      '-u, --url <url>',
      'Seed URL to validate (must include the tracking parameters you expect to survive).',
    )
    .option(
      '-p, --params <list>',
      'Comma-separated tracking parameters to monitor.',
      (value) => parseParamList(value),
    )
    .option(
      '-m, --max-links <n>',
      'Maximum number of internal links to follow from the seed page.',
      (value) => parsePositiveInt(value, '--max-links'),
      20,
    )
    .option(
      '-t, --timeout <ms>',
      'Per-navigation timeout in milliseconds.',
      (value) => parsePositiveInt(value, '--timeout'),
      30_000,
    )
    .option(
      '-s, --settle <ms>',
      'Extra time to wait for JavaScript-driven redirects to fire, in milliseconds.',
      (value) => parsePositiveInt(value, '--settle'),
      1_500,
    )
    .option('--no-headless', 'Run the browser with a visible window.')
    .option(
      '--no-same-host',
      'Follow internal links to other hosts as well (off by default).',
    )
    .option('--user-agent <ua>', 'Override the browser User-Agent string.')
    .option('--json', 'Emit the full machine-readable report as JSON.', false)
    .option('--quiet', 'Suppress informational output; print findings only.', false)
    .option('--no-color', 'Disable ANSI colour in the output.');

  program.addHelpText(
    'after',
    `
Examples:
  $ ${PROGRAM_NAME} --url "https://example.com/?utm_source=facebook&utm_medium=cpc"
  $ ${PROGRAM_NAME} -u "https://shop.example.com/?utm_campaign=summer" --max-links 50
  $ ${PROGRAM_NAME} -u "https://example.com/?utm_source=x" --params utm_source,gclid --json
`,
  );

  return program;
}

/** Resolve raw Commander options into a fully-defaulted {@link ScanOptions}. */
function resolveOptions(raw: RawCliOptions): ScanOptions {
  const trackedParams =
    raw.params !== undefined && raw.params.length > 0
      ? parseParamList(raw.params)
      : DEFAULT_TRACKED_PARAMS;

  return {
    url: raw.url,
    trackedParams,
    maxLinks: raw.maxLinks,
    timeout: raw.timeout,
    settleTime: raw.settle,
    headless: raw.headless,
    sameHostOnly: raw.sameHost,
    ...(raw.userAgent !== undefined ? { userAgent: raw.userAgent } : {}),
    quiet: raw.quiet,
  };
}

/** A no-op colouriser used when colour output is disabled. */
const identity = (value: string): string => value;

/** Bundle of colour functions, switchable for `--no-color`. */
interface Palette {
  readonly red: (s: string) => string;
  readonly yellow: (s: string) => string;
  readonly green: (s: string) => string;
  readonly cyan: (s: string) => string;
  readonly gray: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly bold: (s: string) => string;
  readonly underline: (s: string) => string;
}

function makePalette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      red: identity,
      yellow: identity,
      green: identity,
      cyan: identity,
      gray: identity,
      dim: identity,
      bold: identity,
      underline: identity,
    };
  }
  return { red, yellow, green, cyan, gray, dim, bold, underline };
}

/** Map a severity to its label and colouriser. */
function severityBadge(
  severity: Severity,
  palette: Palette,
): { label: string; colour: (s: string) => string } {
  switch (severity) {
    case 'critical':
      return { label: 'CRITICAL', colour: palette.red };
    case 'warning':
      return { label: 'WARNING', colour: palette.yellow };
    case 'ok':
      return { label: 'OK', colour: palette.green };
  }
}

/** Render the ESLint-style block for a single route report. */
function formatRoute(report: RouteReport, palette: Palette): string {
  const lines: string[] = [];
  const badge = severityBadge(report.severity, palette);

  const title = report.linkText !== undefined && report.linkText.length > 0
    ? `${report.entryUrl}  ${palette.dim(`(“${report.linkText}”)`)}`
    : report.entryUrl;

  lines.push(palette.underline(title));

  if (report.error !== undefined) {
    lines.push(
      `  ${badge.colour(badge.label.padEnd(8))} ${palette.gray('navigation')}  ${report.error}`,
    );
    return lines.join('\n');
  }

  if (report.expectedParams.length === 0) {
    lines.push(
      `  ${palette.yellow('WARNING'.padEnd(8))} ${palette.gray('params    ')}  No tracked parameters were present on the entry URL.`,
    );
    return lines.join('\n');
  }

  if (report.severity === 'ok') {
    lines.push(
      `  ${palette.green('OK'.padEnd(8))} ${palette.gray('params    ')}  All ${report.expectedParams.length} tracked parameter(s) survived to ${palette.cyan(report.finalUrl)}`,
    );
    return lines.join('\n');
  }

  // Critical: one line per dropped parameter, ESLint-rule style.
  for (const drop of report.dropPoints) {
    const ruleId = palette.gray(`utm/${drop.param}`);
    lines.push(
      `  ${palette.red('CRITICAL'.padEnd(8))} UTM parameter ${palette.bold(drop.param)} dropped at ${palette.cyan(drop.toUrl)}  ${ruleId}`,
    );
    lines.push(
      `           ${palette.dim(`via ${drop.kind} (hop #${drop.hopIndex})  ${drop.fromUrl} → ${drop.toUrl}`)}`,
    );
  }

  // Any parameters missing from the final URL that we could not pin to a
  // specific hop (e.g. absent from the very first committed response).
  const unlocated = report.missingParams.filter(
    (param) => !report.dropPoints.some((drop) => drop.param === param),
  );
  for (const param of unlocated) {
    lines.push(
      `  ${palette.red('CRITICAL'.padEnd(8))} UTM parameter ${palette.bold(param)} missing from final URL ${palette.cyan(report.finalUrl)}  ${palette.gray(`utm/${param}`)}`,
    );
  }

  return lines.join('\n');
}

/** Render the full human-readable report. */
function formatReport(result: ScanResult, palette: Palette): string {
  const blocks: string[] = [];
  const { summary } = result;

  blocks.push('');
  blocks.push(
    palette.bold(
      `ParamGuard — scanning ${palette.cyan(result.options.url)}`,
    ),
  );
  blocks.push(
    palette.dim(
      `Watching: ${result.options.trackedParams.join(', ')}  •  Links followed: ${result.linkReports.length}/${result.options.maxLinks}`,
    ),
  );
  blocks.push('');

  const allReports: readonly RouteReport[] = [
    result.seedReport,
    ...result.linkReports,
  ];

  // Surface failing routes first, then warnings, then passing routes.
  const order: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const sorted = [...allReports].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );

  for (const report of sorted) {
    if (result.options.quiet && report.severity === 'ok') {
      continue;
    }
    blocks.push(formatRoute(report, palette));
    blocks.push('');
  }

  const problemCount = summary.critical + summary.warnings;
  const summaryColour =
    summary.critical > 0
      ? palette.red
      : summary.warnings > 0
        ? palette.yellow
        : palette.green;

  const mark =
    summary.critical > 0 ? '✖' : summary.warnings > 0 ? '⚠' : '✔';

  blocks.push(
    summaryColour(
      palette.bold(
        `${mark} ${problemCount} problem(s) across ${summary.totalRoutes} route(s)  —  ${summary.critical} critical, ${summary.warnings} warning, ${summary.passed} ok`,
      ),
    ),
  );
  blocks.push(palette.dim(`Completed in ${result.durationMs} ms.`));
  blocks.push('');

  return blocks.join('\n');
}

/** Process exit code: non-zero if any route was critical. */
function computeExitCode(result: ScanResult): number {
  const allReports: readonly RouteReport[] = [
    result.seedReport,
    ...result.linkReports,
  ];
  let code = 0;
  for (const report of allReports) {
    code = Math.max(code, SEVERITY_EXIT_CODE[report.severity]);
  }
  return code;
}

/** Program main. Returns the desired process exit code. */
async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();

  try {
    program.parse(argv as string[]);
  } catch (error: unknown) {
    // Commander throws for help/version/parse errors; it has already printed.
    if (error instanceof Error && 'exitCode' in error) {
      const exitCode = (error as { exitCode?: number }).exitCode;
      return typeof exitCode === 'number' ? exitCode : 1;
    }
    return 1;
  }

  const raw = program.opts<RawCliOptions>();
  const colourEnabled = raw.noColor !== true && isColorSupported;
  const palette = makePalette(colourEnabled);

  const options = resolveOptions(raw);

  // Validate the seed URL before spinning up a browser.
  const seed = (() => {
    try {
      return new URL(options.url);
    } catch {
      return null;
    }
  })();

  if (seed === null) {
    process.stderr.write(
      `${palette.red('error')} The provided --url is not a valid absolute URL: ${options.url}\n`,
    );
    return 2;
  }

  if (seed.protocol !== 'http:' && seed.protocol !== 'https:') {
    process.stderr.write(
      `${palette.red('error')} Only http(s) URLs are supported (received ${seed.protocol}).\n`,
    );
    return 2;
  }

  const presentOnSeed = extractParams(options.url, options.trackedParams);
  if (Object.keys(presentOnSeed).length === 0) {
    process.stderr.write(
      `${palette.yellow('warning')} The seed URL carries none of the tracked parameters (${options.trackedParams.join(', ')}).\n` +
        `${palette.dim('There is nothing to track for loss. Add UTM parameters to --url or adjust --params.')}\n`,
    );
    return 2;
  }

  if (!options.quiet && !raw.json) {
    process.stderr.write(
      palette.dim(`Launching headless Chromium…\n`),
    );
  }

  let result: ScanResult;
  try {
    const scanner = new Scanner(options);
    result = await scanner.run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${palette.red('error')} Scan failed to complete: ${message}\n`,
    );
    if (message.toLowerCase().includes('executable')) {
      process.stderr.write(
        palette.dim(
          'Playwright browsers may not be installed. Run: npx playwright install chromium\n',
        ),
      );
    }
    return 2;
  }

  if (raw.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(result, palette));
  }

  return computeExitCode(result);
}

// Re-export the library surface so `import { Scanner } from 'paramguard'` works.
export { Scanner, extractParams, diffMissing, parseUrlSafe } from './scanner.js';
export {
  DEFAULT_TRACKED_PARAMS,
  SEVERITY_EXIT_CODE,
  type DiscoveredLink,
  type ParamDropPoint,
  type RedirectHop,
  type RouteReport,
  type ScanOptions,
  type ScanResult,
  type ScanSummary,
  type Severity,
} from './types.js';

/** True when this module is being executed directly as the `paramguard` bin. */
function isRunAsCli(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === invoked;
  } catch {
    return false;
  }
}

if (isRunAsCli()) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${red('fatal')} ${message}\n`);
      process.exitCode = 2;
    });
}
