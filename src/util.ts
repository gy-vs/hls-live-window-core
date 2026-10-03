/**
 * Small deterministic helpers. Nothing in this module reads the clock or
 * draws from `Math.random` (except Math.floor on computed numbers).
 */

export function sortedKeys<T>(record: Record<string, T>): string[] {
  return Object.keys(record).sort();
}

/** Lexicographically sorted entries — used for stable serialization/order. */
export function sortedEntries<T>(
  record: Record<string, T>
): [string, T][] {
  return sortedKeys(record).map((k) => [k, record[k]!]);
}

/** Deterministically ordered entries of a Map (by key). */
export function sortedMapEntries<K, T>(map: Map<K, T>): [K, T][] {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function minOf<T>(items: Iterable<T>, score: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestScore: number | null = null;
  for (const item of items) {
    const s = score(item);
    if (s === null) continue;
    if (bestScore === null || s < bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

export function maxOf<T>(items: Iterable<T>, score: (item: T) => number | null): T | null {
  let best: T | null = null;
  let bestScore: number | null = null;
  for (const item of items) {
    const s = score(item);
    if (s === null) continue;
    if (bestScore === null || s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Parse a quoted/attribute/decimal/integer/resolution/enumerated-string HLS attribute value. */
export type AttrValue = string | number;

export function parseAttrList(raw: string): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  let i = 0;
  while (i < raw.length) {
    const eq = raw.indexOf('=', i);
    if (eq === -1) break;
    const name = raw.slice(i, eq).trim();
    i = eq + 1;
    let value: AttrValue;
    if (raw[i] === '"') {
      let j = i + 1;
      let str = '';
      while (j < raw.length) {
        const c = raw[j]!;
        if (c === '\\' && j + 1 < raw.length) {
          str += raw[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        str += c;
        j += 1;
      }
      i = j;
      value = str;
    } else {
      let j = i;
      while (j < raw.length && raw[j] !== ',') j += 1;
      const token = raw.slice(i, j).trim();
      i = j;
      value = token;
    }
    out[name] = value;
    if (raw[i] === ',') i += 1;
  }
  return out;
}

export function attrString(attrs: Record<string, AttrValue>, name: string): string | null {
  const v = attrs[name];
  return typeof v === 'string' ? v : null;
}

export function attrNumber(attrs: Record<string, AttrValue>, name: string): number | null {
  const v = attrs[name];
  if (v === undefined) return null;
  if (typeof v === 'number') return v;
  // Unquoted tokens arrive as strings; convert when numeric.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

export function attrEnum(attrs: Record<string, AttrValue>, name: string): string | null {
  const v = attrs[name];
  return v === undefined ? null : String(v);
}

/**
 * Resolve `uri` against `base` (RFC 3986 section 5 relative-reference
 * resolution, enough for http(s) and plain paths used in playlists).
 */
export function resolveUri(base: string, uri: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return uri;
  if (uri.startsWith('//')) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(base);
    return (m ? m[1] : '') + uri;
  }
  const hashIdx = base.indexOf('#');
  let b = hashIdx === -1 ? base : base.slice(0, hashIdx);
  if (uri.startsWith('?')) {
    const qIdx = b.indexOf('?');
    return (qIdx === -1 ? b : b.slice(0, qIdx)) + uri;
  }
  const qIdx = b.indexOf('?');
  if (qIdx !== -1) b = b.slice(0, qIdx);
  if (uri.startsWith('/')) {
    const authority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+/.exec(b);
    return authority ? authority[0] + uri : uri;
  }
  const lastSlash = b.lastIndexOf('/');
  const combined = (lastSlash === -1 ? '' : b.slice(0, lastSlash + 1)) + uri;
  return removeDotSegments(combined);
}

function removeDotSegments(inputPath: string): string {
  const authority = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+)(\/.*)?$/.exec(inputPath);
  const prefix = authority ? authority[1]! : '';
  let input = authority ? authority[2] ?? '/' : inputPath;
  const trailingSlash = input.endsWith('/');
  const out: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '..') {
      out.pop();
    } else if (seg !== '.') {
      out.push(seg);
    }
  }
  let result = out.join('/');
  if (trailingSlash && !result.endsWith('/')) result += '/';
  return prefix + result;
}

export function parseByteRange(raw: string, previousStart: number | null, previousLength: number | null): ByteRangeLike {
  const at = raw.indexOf('@');
  let length: number;
  let start: number | null;
  if (at === -1) {
    length = Number(raw);
    start = null;
  } else {
    length = Number(raw.slice(0, at));
    start = Number(raw.slice(at + 1));
  }
  if (start === null) {
    if (previousStart !== null && previousLength !== null) {
      start = previousStart + previousLength;
    }
  }
  return { length, start };
}

export interface ByteRangeLike {
  length: number;
  start: number | null;
}

/** Normalize an EXT-X-KEY IV (hex string or decimal uint128) to lower-case hex. */
export function normalizeIv(raw: string): string | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) {
    return raw.slice(2).toLowerCase().padStart(32, '0');
  }
  if (/^\d+$/.test(raw)) {
    let n = BigInt(raw);
    let hex = '';
    if (n === 0n) hex = '0';
    while (n > 0n) {
      hex = n.toString(16) + hex;
      n >>= 4n;
    }
    return hex.padStart(32, '0');
  }
  return null;
}

/** ISO-8601 date (as used by EXT-X-PROGRAM-DATE-TIME) -> epoch ms. */
export function parseIsoDate(raw: string): number | null {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function msOfSeconds(seconds: number): number {
  return Math.round(seconds * 1000);
}

export function isInteger(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}
