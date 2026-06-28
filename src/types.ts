/**
 * ParamGuard — shared type definitions.
 *
 * Every public surface of the scanner is typed here so the CLI layer and the
 * scanning engine share a single, strict contract. Nothing in this file has a
 * runtime cost beyond the two small `const` lookups at the bottom.
 */

/**
 * The canonical set of UTM keys ParamGuard watches by default.
 *
 * These are the five parameters defined by Google's Urchin Tracking Module
 * convention and respected by virtually every analytics and ad platform.
 */
export const DEFAULT_TRACKED_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

/**
 * Severity levels used when reporting a finding, ordered from most to least
 * urgent. `ok` is emitted for routes that preserved every tracked parameter.
 */
export type Severity = 'critical' | 'warning' | 'ok';

/**
 * Options accepted by {@link Scanner}. Every field except `url` has a sane
 * default applied by the CLI layer, so partial option objects are common in
 * tests but the scanner itself always receives a fully-resolved object.
 */
export interface ScanOptions {
  /** The seed URL to validate. Must carry at least one tracked parameter. */
  readonly url: string;
  /** Tracking parameter names to monitor. Defaults to {@link DEFAULT_TRACKED_PARAMS}. */
  readonly trackedParams: readonly string[];
  /** Maximum number of internal links to follow from the seed page. */
  readonly maxLinks: number;
  /** Per-navigation timeout in milliseconds. */
  readonly timeout: number;
  /** Whether to run the browser headless. */
  readonly headless: boolean;
  /** Restrict crawling to the seed URL's registrable host when `true`. */
  readonly sameHostOnly: boolean;
  /** Custom User-Agent string, or `undefined` to use Playwright's default. */
  readonly userAgent?: string;
  /** Milliseconds to wait for JavaScript-driven navigation to settle. */
  readonly settleTime: number;
  /** Suppress all non-essential logging when `true`. */
  readonly quiet: boolean;
}

/**
 * A single hop in a navigation chain. Server redirects (3xx), client-side
 * meta-refresh, History API pushes and full JS navigations are all normalised
 * into this shape so the diffing logic never has to special-case the source.
 */
export interface RedirectHop {
  /** Zero-based index of this hop within its chain. */
  readonly index: number;
  /** The fully-qualified URL observed at this hop. */
  readonly url: string;
  /** HTTP status code for this hop, or `null` for client-side transitions. */
  readonly status: number | null;
  /** How this hop was reached. */
  readonly kind: 'server-redirect' | 'client-navigation' | 'initial';
  /** The tracked parameters still present at this hop. */
  readonly presentParams: Readonly<Record<string, string>>;
  /** The tracked parameters that were present upstream but are now gone. */
  readonly droppedParams: readonly string[];
}

/**
 * The result of validating one navigation route: from the seed URL (or a
 * discovered internal link) through every redirect to its terminal URL.
 */
export interface RouteReport {
  /** The link/URL that initiated this route. */
  readonly entryUrl: string;
  /** The terminal URL after all redirects and client navigations resolved. */
  readonly finalUrl: string;
  /** Human-readable anchor text, when the route originated from an `<a>`. */
  readonly linkText?: string;
  /** The ordered chain of hops, including the initial and final hops. */
  readonly chain: readonly RedirectHop[];
  /** Tracked parameters expected at the start of the route. */
  readonly expectedParams: readonly string[];
  /** Tracked parameters missing from {@link finalUrl}. */
  readonly missingParams: readonly string[];
  /** The hop at which each missing parameter first disappeared. */
  readonly dropPoints: readonly ParamDropPoint[];
  /** Severity derived from {@link missingParams}. */
  readonly severity: Severity;
  /** Populated when the route could not be evaluated (navigation failure). */
  readonly error?: string;
}

/** Pinpoints exactly where a single parameter vanished. */
export interface ParamDropPoint {
  /** The parameter name that was dropped. */
  readonly param: string;
  /** The URL immediately before the parameter disappeared. */
  readonly fromUrl: string;
  /** The URL at which the parameter was first observed missing. */
  readonly toUrl: string;
  /** The hop index at which the drop occurred. */
  readonly hopIndex: number;
  /** The transition kind that caused the drop. */
  readonly kind: RedirectHop['kind'];
}

/** The complete output of a scan run, ready for formatting or serialisation. */
export interface ScanResult {
  /** The resolved options the scan ran with. */
  readonly options: ScanOptions;
  /** The report for the seed URL itself. */
  readonly seedReport: RouteReport;
  /** One report per internal link that was followed. */
  readonly linkReports: readonly RouteReport[];
  /** Aggregate counts across every evaluated route. */
  readonly summary: ScanSummary;
  /** ISO-8601 timestamp marking when the scan started. */
  readonly startedAt: string;
  /** Wall-clock duration of the scan in milliseconds. */
  readonly durationMs: number;
}

/** Roll-up statistics for a full scan. */
export interface ScanSummary {
  /** Total routes evaluated (seed + links). */
  readonly totalRoutes: number;
  /** Routes that preserved every tracked parameter. */
  readonly passed: number;
  /** Routes that dropped at least one parameter. */
  readonly critical: number;
  /** Routes that produced a non-fatal warning (e.g. partial drop, nav error). */
  readonly warnings: number;
}

/** A discovered internal link prior to evaluation. */
export interface DiscoveredLink {
  /** The absolute, normalised href. */
  readonly href: string;
  /** Trimmed anchor text, or the empty string when none was present. */
  readonly text: string;
}

/** Maps a {@link Severity} to its terminal exit-code contribution. */
export const SEVERITY_EXIT_CODE: Readonly<Record<Severity, number>> = {
  critical: 1,
  warning: 0,
  ok: 0,
} as const;
