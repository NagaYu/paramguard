/**
 * ParamGuard — scanning engine.
 *
 * Drives a headless Chromium instance via Playwright, follows the seed URL and
 * every discovered internal link through their full redirect chains (server
 * 3xx, meta-refresh, and JavaScript-driven navigation alike), and reports any
 * point at which a tracked UTM parameter is silently dropped.
 *
 * The engine is intentionally side-effect free with respect to logging: it
 * returns a fully-populated {@link ScanResult} and leaves all presentation to
 * the CLI layer. Throwing is reserved for unrecoverable setup failures (e.g.
 * the browser cannot launch); per-route navigation failures are captured as
 * data on the corresponding {@link RouteReport}.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Request } from 'playwright';

import {
  type DiscoveredLink,
  type ParamDropPoint,
  type RedirectHop,
  type RouteReport,
  type ScanOptions,
  type ScanResult,
  type ScanSummary,
  type Severity,
} from './types.js';

/**
 * Parse a URL string without throwing. Returns `null` when the input is not a
 * valid absolute URL (anchor-only hrefs, `javascript:` pseudo-URLs, malformed
 * strings, etc.).
 */
export function parseUrlSafe(input: string, base?: string): URL | null {
  try {
    return base !== undefined ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
}

/**
 * Extract the subset of `trackedParams` present in `url`, mapping each found
 * parameter name to its (possibly empty) string value. Unknown or unparseable
 * URLs yield an empty record.
 */
export function extractParams(
  url: string,
  trackedParams: readonly string[],
): Record<string, string> {
  const parsed = parseUrlSafe(url);
  const found: Record<string, string> = {};
  if (parsed === null) {
    return found;
  }
  for (const param of trackedParams) {
    if (parsed.searchParams.has(param)) {
      found[param] = parsed.searchParams.get(param) ?? '';
    }
  }
  return found;
}

/**
 * Compute the names of `expected` parameters that are absent from `url`.
 */
export function diffMissing(
  url: string,
  expected: readonly string[],
): string[] {
  const present = extractParams(url, expected);
  return expected.filter((param) => !(param in present));
}

/**
 * The scanning engine. Construct with a fully-resolved {@link ScanOptions}
 * object and call {@link Scanner.run}. Instances are single-use; the browser is
 * launched lazily on `run()` and always torn down before the promise settles.
 */
export class Scanner {
  private readonly options: ScanOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  public constructor(options: ScanOptions) {
    this.options = options;
  }

  /**
   * Execute the full scan: validate the seed URL, discover internal links, and
   * follow every route. Always releases browser resources, even on failure.
   */
  public async run(): Promise<ScanResult> {
    const startedAt = new Date();
    const startedMs = startedAt.getTime();

    try {
      await this.launch();
      const page = await this.newPage();

      const seedReport = await this.followRoute(page, this.options.url, undefined);

      // Only crawl onward from a seed page that actually loaded; a failed seed
      // navigation leaves the page in a state where DOM queries would throw.
      const discovered =
        seedReport.error === undefined
          ? await this.discoverLinks(page, this.options.url)
          : [];
      const linkReports: RouteReport[] = [];

      for (const link of discovered) {
        const report = await this.followRoute(page, link.href, link.text);
        linkReports.push(report);
      }

      await page.close();

      const summary = this.summarise(seedReport, linkReports);
      const durationMs = new Date().getTime() - startedMs;

      return {
        options: this.options,
        seedReport,
        linkReports,
        summary,
        startedAt: startedAt.toISOString(),
        durationMs,
      };
    } finally {
      await this.teardown();
    }
  }

  /** Launch Chromium and create a context honouring the resolved options. */
  private async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext(
      this.options.userAgent !== undefined
        ? { userAgent: this.options.userAgent }
        : {},
    );
    this.context.setDefaultNavigationTimeout(this.options.timeout);
    this.context.setDefaultTimeout(this.options.timeout);
  }

  /** Create a fresh page within the active context. */
  private async newPage(): Promise<Page> {
    if (this.context === null) {
      throw new Error('Scanner context is not initialised.');
    }
    return this.context.newPage();
  }

  /** Best-effort release of every browser resource. Never throws. */
  private async teardown(): Promise<void> {
    try {
      if (this.context !== null) {
        await this.context.close();
      }
    } catch {
      /* swallow: teardown must not mask the primary result or error */
    } finally {
      this.context = null;
    }

    try {
      if (this.browser !== null) {
        await this.browser.close();
      }
    } catch {
      /* swallow: teardown must not mask the primary result or error */
    } finally {
      this.browser = null;
    }
  }

  /**
   * Navigate to `entryUrl`, follow every redirect and client-side navigation,
   * and produce a {@link RouteReport} describing parameter retention across the
   * resulting chain. Navigation failures are captured as report data rather
   * than thrown.
   */
  private async followRoute(
    page: Page,
    entryUrl: string,
    linkText: string | undefined,
  ): Promise<RouteReport> {
    const expectedParams = Object.keys(
      extractParams(entryUrl, this.options.trackedParams),
    );

    try {
      const response = await page.goto(entryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.timeout,
      });

      await this.settle(page);

      const chain = await this.buildChain(
        entryUrl,
        response?.request() ?? null,
        page.url(),
        expectedParams,
      );

      const finalHop = chain[chain.length - 1];
      const finalUrl = finalHop !== undefined ? finalHop.url : entryUrl;
      const missingParams = diffMissing(finalUrl, expectedParams);
      const dropPoints = this.locateDropPoints(chain, expectedParams);
      const severity = this.classify(missingParams, expectedParams, undefined);

      return {
        entryUrl,
        finalUrl,
        ...(linkText !== undefined ? { linkText } : {}),
        chain,
        expectedParams,
        missingParams,
        dropPoints,
        severity,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        entryUrl,
        finalUrl: entryUrl,
        ...(linkText !== undefined ? { linkText } : {}),
        chain: [],
        expectedParams,
        missingParams: [],
        dropPoints: [],
        severity: this.classify([], expectedParams, message),
        error: message,
      };
    }
  }

  /**
   * Reconstruct the ordered hop chain for a navigation.
   *
   * The server-side redirect sequence is recovered from Playwright's request
   * graph via {@link Request.redirectedFrom}. A trailing client-side hop is
   * appended whenever the page's live URL differs from the last committed
   * server URL — this is how meta-refresh and JS `location` changes surface.
   */
  private async buildChain(
    entryUrl: string,
    finalRequest: Request | null,
    liveUrl: string,
    expectedParams: readonly string[],
  ): Promise<RedirectHop[]> {
    const requestSequence: Request[] = [];
    let cursor: Request | null = finalRequest;
    while (cursor !== null) {
      requestSequence.unshift(cursor);
      cursor = cursor.redirectedFrom();
    }

    const hops: RedirectHop[] = [];

    if (requestSequence.length === 0) {
      // No network request was associated with the navigation (e.g. a cached
      // about:blank or an immediate client redirect). Seed the chain from the
      // entry URL so diffing still has a baseline.
      hops.push(this.makeHop(0, entryUrl, null, 'initial', expectedParams));
    } else {
      for (let index = 0; index < requestSequence.length; index += 1) {
        const request = requestSequence[index];
        if (request === undefined) {
          continue;
        }
        const status = await this.statusOf(request);
        const kind: RedirectHop['kind'] =
          index === 0 ? 'initial' : 'server-redirect';
        hops.push(
          this.makeHop(index, request.url(), status, kind, expectedParams),
        );
      }
    }

    const lastServerHop = hops[hops.length - 1];
    if (lastServerHop !== undefined && this.normalise(liveUrl) !== this.normalise(lastServerHop.url)) {
      hops.push(
        this.makeHop(
          hops.length,
          liveUrl,
          null,
          'client-navigation',
          expectedParams,
        ),
      );
    }

    return hops;
  }

  /** Resolve the HTTP status for a request once its response headers arrive. */
  private async statusOf(request: Request): Promise<number | null> {
    try {
      const response = await request.response();
      return response === null ? null : response.status();
    } catch {
      return null;
    }
  }

  /** Construct a single hop, computing present/dropped tracked parameters. */
  private makeHop(
    index: number,
    url: string,
    status: number | null,
    kind: RedirectHop['kind'],
    expectedParams: readonly string[],
  ): RedirectHop {
    const presentParams = extractParams(url, expectedParams);
    const droppedParams = expectedParams.filter(
      (param) => !(param in presentParams),
    );
    return { index, url, status, kind, presentParams, droppedParams };
  }

  /**
   * Walk consecutive hops and record the exact transition at which each
   * expected parameter first disappeared.
   */
  private locateDropPoints(
    chain: readonly RedirectHop[],
    expectedParams: readonly string[],
  ): ParamDropPoint[] {
    const dropPoints: ParamDropPoint[] = [];
    const alreadyDropped = new Set<string>();

    for (let i = 1; i < chain.length; i += 1) {
      const previous = chain[i - 1];
      const current = chain[i];
      if (previous === undefined || current === undefined) {
        continue;
      }
      for (const param of expectedParams) {
        if (alreadyDropped.has(param)) {
          continue;
        }
        const wasPresent = param in previous.presentParams;
        const isPresent = param in current.presentParams;
        if (wasPresent && !isPresent) {
          dropPoints.push({
            param,
            fromUrl: previous.url,
            toUrl: current.url,
            hopIndex: current.index,
            kind: current.kind,
          });
          alreadyDropped.add(param);
        }
      }
    }

    return dropPoints;
  }

  /** Derive a severity from the missing-parameter set and any error. */
  private classify(
    missingParams: readonly string[],
    expectedParams: readonly string[],
    error: string | undefined,
  ): Severity {
    if (error !== undefined) {
      return 'warning';
    }
    if (expectedParams.length === 0) {
      return 'ok';
    }
    return missingParams.length > 0 ? 'critical' : 'ok';
  }

  /**
   * Wait for the page to settle after the initial commit so that delayed
   * client-side redirects (meta-refresh, `setTimeout(() => location = ...)`,
   * SPA route changes) are reflected in `page.url()`.
   */
  private async settle(page: Page): Promise<void> {
    try {
      await page.waitForLoadState('networkidle', {
        timeout: this.options.timeout,
      });
    } catch {
      /* networkidle may never fire on long-polling pages; that is fine */
    }

    if (this.options.settleTime > 0) {
      try {
        await page.waitForTimeout(this.options.settleTime);
      } catch {
        /* page may have closed; ignore */
      }
    }
  }

  /**
   * Discover internal anchor links on the page in its current state. Applies
   * host filtering, deduplication, and the configured link cap.
   */
  private async discoverLinks(
    page: Page,
    seedUrl: string,
  ): Promise<DiscoveredLink[]> {
    const seed = parseUrlSafe(seedUrl);
    const baseHref = page.url();

    // Defensive: a late client-side navigation can destroy the execution
    // context between settling and querying. Treat that as "no links found"
    // rather than failing the whole scan.
    let rawLinks: Array<{ href: string; text: string }>;
    try {
      rawLinks = await page.$$eval('a[href]', (anchors) =>
        anchors.map((anchor) => {
          const el = anchor as HTMLAnchorElement;
          return {
            href: el.getAttribute('href') ?? '',
            text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
          };
        }),
      );
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const collected: DiscoveredLink[] = [];

    for (const raw of rawLinks) {
      if (collected.length >= this.options.maxLinks) {
        break;
      }

      const resolved = parseUrlSafe(raw.href, baseHref);
      if (resolved === null) {
        continue;
      }
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        continue;
      }

      // Ignore pure in-page anchors that resolve to the current document.
      const withoutHash = `${resolved.origin}${resolved.pathname}${resolved.search}`;
      if (
        resolved.hash !== '' &&
        withoutHash === this.normalise(baseHref).split('#')[0]
      ) {
        continue;
      }

      if (
        this.options.sameHostOnly &&
        seed !== null &&
        resolved.host !== seed.host
      ) {
        continue;
      }

      const key = this.normalise(resolved.href);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      collected.push({ href: resolved.href, text: raw.text });
    }

    return collected;
  }

  /** Normalise a URL for comparison: strip the trailing slash on bare paths. */
  private normalise(url: string): string {
    const parsed = parseUrlSafe(url);
    if (parsed === null) {
      return url;
    }
    if (parsed.pathname === '/' && parsed.search === '' && parsed.hash === '') {
      return `${parsed.origin}/`;
    }
    return parsed.href;
  }

  /** Aggregate severity counts across the seed and link reports. */
  private summarise(
    seedReport: RouteReport,
    linkReports: readonly RouteReport[],
  ): ScanSummary {
    const all: readonly RouteReport[] = [seedReport, ...linkReports];
    let passed = 0;
    let critical = 0;
    let warnings = 0;

    for (const report of all) {
      switch (report.severity) {
        case 'ok':
          passed += 1;
          break;
        case 'critical':
          critical += 1;
          break;
        case 'warning':
          warnings += 1;
          break;
      }
    }

    return {
      totalRoutes: all.length,
      passed,
      critical,
      warnings,
    };
  }
}
