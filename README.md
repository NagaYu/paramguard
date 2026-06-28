<div align="center">

# 🛡️ ParamGuard

### Stop bleeding ad budget to silently dropped UTM parameters.

**ParamGuard** crawls your landing pages in a real headless browser, follows every
redirect and JavaScript navigation, and screams the moment a tracking parameter
disappears — before your campaign goes live, not after the attribution data is gone.

[![npm version](https://img.shields.io/npm/v/paramguard.svg?style=flat-square)](https://www.npmjs.com/package/paramguard)
[![Node.js](https://img.shields.io/node/v/paramguard.svg?style=flat-square)](https://nodejs.org)
[![Built with Playwright](https://img.shields.io/badge/built%20with-Playwright-2EAD33?style=flat-square)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](#license)

</div>

---

## Why a dropped UTM is a five-figure mistake

You pay for a click. The user lands on `?utm_source=facebook&utm_medium=cpc`. So
far, so good. But then:

- a marketing redirect (`/promo` → `/promo/`) strips the query string,
- a "smart" geo-router bounces them through `r.example.com` and forgets the params,
- a SPA reads the URL once, calls `history.replaceState` on hydration, and wipes it,
- or an A/B testing tool 302s the user to a variant **without** the original query.

The visitor still converts. The sale still happens. But in your analytics it now
looks like **organic / direct traffic**. The campaign that actually drove the
revenue shows a CPA of infinity. So you pause it. You just turned off your best
channel because of a trailing slash.

> **Dropped UTMs don't break the page. They break the *story the page tells your
> analytics* — and that story is what you spend your budget on.**

Multiply one broken route across a six-figure monthly ad spend and the leak is
enormous, invisible, and almost impossible to find by hand. ParamGuard finds it
in ten seconds.

---

## What ParamGuard does

```text
$ paramguard --url "https://example.com/?utm_source=facebook&utm_medium=cpc"

ParamGuard — scanning https://example.com/?utm_source=facebook&utm_medium=cpc
Watching: utm_source, utm_medium, utm_campaign, utm_term, utm_content  •  Links followed: 12/20

https://example.com/promo  (“See the summer deal”)
  CRITICAL UTM parameter utm_source dropped at https://example.com/promo/  utm/utm_source
           via server-redirect (hop #1)  https://example.com/promo → https://example.com/promo/
  CRITICAL UTM parameter utm_medium dropped at https://example.com/promo/  utm/utm_medium
           via server-redirect (hop #1)  https://example.com/promo → https://example.com/promo/

https://example.com/?utm_source=facebook&utm_medium=cpc
  OK       params      All 2 tracked parameter(s) survived to https://example.com/

✖ 1 problem(s) across 13 route(s)  —  1 critical, 0 warning, 12 ok
Completed in 4182 ms.
```

ParamGuard:

1. **Launches a real browser** (headless Chromium via Playwright) — not a `fetch`,
   so JavaScript redirects and SPA navigations are caught exactly as a user
   experiences them.
2. **Follows the full chain** for the seed URL: every 3xx redirect, meta-refresh,
   and client-side `location` change is reconstructed into an ordered hop list.
3. **Discovers internal links** on the landing page and validates each one too —
   because the parameter often survives the entry point and dies one click later.
4. **Pinpoints the exact hop** where each parameter vanished, with an ESLint-style,
   colour-coded report and a non-zero exit code for CI.

---

## Scan flow

```mermaid
flowchart TD
    A([paramguard --url ...]) --> B{Valid http(s) URL<br/>with tracked params?}
    B -- no --> X[/Print error · exit 2/]
    B -- yes --> C[Launch headless Chromium]
    C --> D[Navigate to seed URL]
    D --> E[Follow redirect chain<br/>server 3xx · meta-refresh · JS nav]
    E --> F[Diff tracked params<br/>at every hop]
    F --> G[Discover internal &lt;a&gt; links]
    G --> H{More links<br/>under --max-links?}
    H -- yes --> I[Navigate to next link]
    I --> E
    H -- no --> J[Aggregate findings]
    J --> K{Any parameter<br/>dropped?}
    K -- yes --> L[/CRITICAL report · exit 1/]
    K -- no --> M[/All clear · exit 0/]
```

---

## Quickstart (10 seconds)

```bash
# 1. Install ParamGuard and the Chromium it drives
npm install -g paramguard
npx playwright install chromium

# 2. Point it at any campaign URL
paramguard --url "https://example.com/?utm_source=facebook&utm_medium=cpc"
```

No global install? Run it straight from npx:

```bash
npx paramguard --url "https://example.com/?utm_source=newsletter&utm_campaign=q3"
```

That's it. A non-zero exit code means a parameter was dropped — wire it into CI
and your campaigns can never ship a broken redirect again.

---

## Usage

```text
Usage: paramguard [options]

Detect when UTM tracking parameters silently vanish across redirects and in-page navigations.

Options:
  -v, --version          Print the ParamGuard version.
  -u, --url <url>        Seed URL to validate (must include the tracking parameters
                         you expect to survive).
  -p, --params <list>    Comma-separated tracking parameters to monitor.
                         (default: utm_source,utm_medium,utm_campaign,utm_term,utm_content)
  -m, --max-links <n>    Maximum number of internal links to follow. (default: 20)
  -t, --timeout <ms>     Per-navigation timeout in milliseconds. (default: 30000)
  -s, --settle <ms>      Extra time to wait for JS-driven redirects. (default: 1500)
  --no-headless          Run the browser with a visible window.
  --no-same-host         Follow internal links to other hosts as well.
  --user-agent <ua>      Override the browser User-Agent string.
  --json                 Emit the full machine-readable report as JSON.
  --quiet                Suppress informational output; print findings only.
  --no-color             Disable ANSI colour in the output.
  -h, --help             Display help for command.
```

### Examples

Track a custom parameter set (including Google Click ID) and emit JSON for a
dashboard:

```bash
paramguard \
  --url "https://shop.example.com/?utm_source=google&gclid=abc123" \
  --params utm_source,utm_medium,gclid \
  --json > paramguard-report.json
```

Crawl deeper, allow cross-host hops, and watch the browser do it:

```bash
paramguard \
  --url "https://example.com/?utm_source=x&utm_campaign=launch" \
  --max-links 50 \
  --no-same-host \
  --no-headless
```

---

## Using ParamGuard in CI

Because ParamGuard exits with code `1` whenever a tracked parameter is dropped,
guarding a deploy is a single step:

```yaml
# .github/workflows/utm-guard.yml
name: UTM Guard
on: [pull_request]

jobs:
  paramguard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g paramguard
      - run: npx playwright install --with-deps chromium
      - run: paramguard --url "https://staging.example.com/?utm_source=ci&utm_medium=test"
```

A red build now means "this change would have leaked attribution," caught before
a single ad dollar is spent against it.

---

## JSON output

`--json` prints the complete `ScanResult` — ideal for piping into a monitor or
storing as a build artifact. The shape is fully typed (see
[`src/types.ts`](src/types.ts)); the essentials:

```jsonc
{
  "summary": { "totalRoutes": 13, "passed": 12, "critical": 1, "warnings": 0 },
  "seedReport": { "severity": "ok", "finalUrl": "...", "missingParams": [] },
  "linkReports": [
    {
      "entryUrl": "https://example.com/promo",
      "finalUrl": "https://example.com/promo/",
      "severity": "critical",
      "missingParams": ["utm_source", "utm_medium"],
      "dropPoints": [
        {
          "param": "utm_source",
          "fromUrl": "https://example.com/promo",
          "toUrl": "https://example.com/promo/",
          "hopIndex": 1,
          "kind": "server-redirect"
        }
      ]
    }
  ]
}
```

---

## How it works under the hood

ParamGuard treats every navigation as a **chain of hops** and diffs the tracked
parameter set at each one:

- **Server redirects** are reconstructed from Playwright's request graph
  (`Request.redirectedFrom()`), preserving status codes for every 3xx hop.
- **Client-side navigations** (meta-refresh, `setTimeout(() => location = ...)`,
  SPA route changes) are caught by waiting for the network to go idle plus a
  configurable `--settle` window, then comparing the live `page.url()` against
  the last committed server URL.
- A parameter is reported **at the precise hop where it first goes missing**, so
  you know whether to fix a redirect rule, a router config, or a hydration bug.

Everything is strict TypeScript with `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` enabled — the scanner returns data, never side effects,
so it is equally usable as a library.

---

## Programmatic API

```ts
import { Scanner } from 'paramguard';
import { DEFAULT_TRACKED_PARAMS } from 'paramguard';

const scanner = new Scanner({
  url: 'https://example.com/?utm_source=facebook&utm_medium=cpc',
  trackedParams: DEFAULT_TRACKED_PARAMS,
  maxLinks: 20,
  timeout: 30_000,
  settleTime: 1_500,
  headless: true,
  sameHostOnly: true,
  quiet: false,
});

const result = await scanner.run();
if (result.summary.critical > 0) {
  console.error('UTM parameters were dropped!', result.linkReports);
}
```

---

## Requirements

- **Node.js ≥ 18**
- **Chromium** installed via Playwright (`npx playwright install chromium`)

---

## Development

```bash
git clone https://github.com/paramguard/paramguard.git
cd paramguard
npm install
npm run build       # bundle with tsup → dist/
npm run typecheck   # strict tsc --noEmit
npm start -- --url "https://example.com/?utm_source=dev"
```

---

## Contributing

Issues and pull requests are welcome. If ParamGuard caught a leak that saved your
campaign, a ⭐ on GitHub helps other marketers find it.

---

## License

Released under the [MIT License](LICENSE).

```text
MIT License — Copyright (c) 2026 ParamGuard Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the conditions in the LICENSE file.
```
