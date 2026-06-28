import { describe, expect, it } from 'vitest';

import { diffMissing, extractParams, parseUrlSafe } from '../src/scanner.js';
import { DEFAULT_TRACKED_PARAMS } from '../src/types.js';

describe('parseUrlSafe', () => {
  it('parses an absolute URL', () => {
    const url = parseUrlSafe('https://example.com/path?a=1');
    expect(url).not.toBeNull();
    expect(url?.host).toBe('example.com');
    expect(url?.pathname).toBe('/path');
  });

  it('resolves a relative URL against a base', () => {
    const url = parseUrlSafe('/promo?x=1', 'https://example.com/start');
    expect(url?.href).toBe('https://example.com/promo?x=1');
  });

  it('returns null for non-URLs', () => {
    expect(parseUrlSafe('not a url')).toBeNull();
    expect(parseUrlSafe('javascript:void(0)', 'https://example.com')).not.toBeNull();
    expect(parseUrlSafe('#section', undefined)).toBeNull();
  });
});

describe('extractParams', () => {
  it('extracts only the tracked params that are present', () => {
    const params = extractParams(
      'https://example.com/?utm_source=fb&utm_medium=cpc&foo=bar',
      DEFAULT_TRACKED_PARAMS,
    );
    expect(params).toEqual({ utm_source: 'fb', utm_medium: 'cpc' });
  });

  it('captures empty-valued params as present', () => {
    const params = extractParams(
      'https://example.com/?utm_source=',
      ['utm_source'],
    );
    expect(params).toEqual({ utm_source: '' });
  });

  it('returns an empty object when no tracked params are present', () => {
    const params = extractParams('https://example.com/?foo=1', DEFAULT_TRACKED_PARAMS);
    expect(params).toEqual({});
  });

  it('returns an empty object for an invalid URL', () => {
    expect(extractParams('::::', DEFAULT_TRACKED_PARAMS)).toEqual({});
  });
});

describe('diffMissing', () => {
  it('reports params that disappeared', () => {
    const missing = diffMissing('https://example.com/?utm_source=fb', [
      'utm_source',
      'utm_medium',
      'utm_campaign',
    ]);
    expect(missing).toEqual(['utm_medium', 'utm_campaign']);
  });

  it('reports nothing when all params survive', () => {
    const missing = diffMissing(
      'https://example.com/?utm_source=fb&utm_medium=cpc',
      ['utm_source', 'utm_medium'],
    );
    expect(missing).toEqual([]);
  });

  it('treats every expected param as missing on an invalid URL', () => {
    expect(diffMissing('not-a-url', ['utm_source'])).toEqual(['utm_source']);
  });
});

describe('DEFAULT_TRACKED_PARAMS', () => {
  it('contains the five canonical UTM keys', () => {
    expect(DEFAULT_TRACKED_PARAMS).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
    ]);
  });
});
