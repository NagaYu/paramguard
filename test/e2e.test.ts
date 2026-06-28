import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Scanner } from '../src/scanner.js';
import { DEFAULT_TRACKED_PARAMS, type ScanOptions } from '../src/types.js';

/**
 * A tiny fixture server reproducing the real-world ways UTM parameters get
 * dropped: server redirects, in-page links that route through a stripping
 * redirect, and JavaScript-driven navigation.
 */
let server: Server;
let base: string;

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/keep') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('<h1>params kept</h1>'));
      return;
    }

    if (path === '/redirect-strip') {
      // 302 to a destination that carries no query string at all.
      res.writeHead(302, { location: '/clean' });
      res.end();
      return;
    }

    if (path === '/clean') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('<h1>clean</h1>'));
      return;
    }

    if (path === '/go') {
      res.writeHead(302, { location: '/dest' });
      res.end();
      return;
    }

    if (path === '/dest') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('<h1>destination</h1>'));
      return;
    }

    if (path === '/js-strip') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        html('<h1>redirecting…</h1><script>location.replace("/clean")</script>'),
      );
      return;
    }

    if (path === '/start') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        html(
          '<h1>landing</h1>' +
            '<a href="/go?utm_source=fb&utm_medium=cpc">Through stripping redirect</a>' +
            '<a href="/keep?utm_source=fb&utm_medium=cpc">Param-safe page</a>',
        ),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(html('<h1>not found</h1>'));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function options(url: string, overrides: Partial<ScanOptions> = {}): ScanOptions {
  return {
    url,
    trackedParams: DEFAULT_TRACKED_PARAMS,
    maxLinks: 20,
    timeout: 30_000,
    settleTime: 800,
    headless: true,
    sameHostOnly: true,
    quiet: true,
    ...overrides,
  };
}

describe('Scanner (end-to-end with a real browser)', () => {
  it('flags a server redirect that strips the query string', async () => {
    const scanner = new Scanner(
      options(`${base}/redirect-strip?utm_source=fb&utm_medium=cpc`, {
        maxLinks: 0,
      }),
    );
    const result = await scanner.run();

    expect(result.seedReport.severity).toBe('critical');
    expect(result.seedReport.finalUrl).toBe(`${base}/clean`);
    expect(result.seedReport.missingParams.sort()).toEqual([
      'utm_medium',
      'utm_source',
    ]);
    expect(result.seedReport.dropPoints.length).toBe(2);
    expect(result.seedReport.dropPoints[0]?.kind).toBe('server-redirect');
    expect(result.summary.critical).toBe(1);
  });

  it('passes a route that preserves every parameter', async () => {
    const scanner = new Scanner(
      options(`${base}/keep?utm_source=fb&utm_medium=cpc`, { maxLinks: 0 }),
    );
    const result = await scanner.run();

    expect(result.seedReport.severity).toBe('ok');
    expect(result.seedReport.missingParams).toEqual([]);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.critical).toBe(0);
  });

  it('detects a JavaScript-driven navigation that drops params', async () => {
    const scanner = new Scanner(
      options(`${base}/js-strip?utm_source=fb`, { maxLinks: 0 }),
    );
    const result = await scanner.run();

    expect(result.seedReport.finalUrl).toBe(`${base}/clean`);
    expect(result.seedReport.severity).toBe('critical');
    expect(result.seedReport.missingParams).toEqual(['utm_source']);
    expect(result.seedReport.dropPoints[0]?.kind).toBe('client-navigation');
  });

  it('discovers internal links and reports the one that drops params', async () => {
    const scanner = new Scanner(
      options(`${base}/start?utm_source=fb&utm_medium=cpc`),
    );
    const result = await scanner.run();

    // The seed page itself keeps its params.
    expect(result.seedReport.severity).toBe('ok');

    // Two internal links were discovered and followed.
    expect(result.linkReports.length).toBe(2);

    const stripping = result.linkReports.find((r) =>
      r.entryUrl.includes('/go'),
    );
    const safe = result.linkReports.find((r) => r.entryUrl.includes('/keep'));

    expect(stripping?.severity).toBe('critical');
    expect(stripping?.finalUrl).toBe(`${base}/dest`);
    expect(safe?.severity).toBe('ok');

    expect(result.summary.critical).toBe(1);
  });

  it('produces a warning when the seed URL cannot be reached', async () => {
    const scanner = new Scanner(
      options(`${base}/redirect-strip?utm_source=fb`, {
        maxLinks: 0,
        timeout: 1,
      }),
    );
    const result = await scanner.run();

    // A 1ms timeout guarantees a navigation failure, surfaced as a warning.
    expect(result.seedReport.severity).toBe('warning');
    expect(result.seedReport.error).toBeTypeOf('string');
  });
});
