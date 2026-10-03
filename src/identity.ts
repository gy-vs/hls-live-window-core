import { ByteRange, KeyDescriptor, MapDescriptor, Segment } from './types.js';

/**
 * Identity model.
 *
 * A rendition is a media playlist resource. CDNs commonly rotate signed
 * query parameters on every fetch, so two playlist URIs that differ only in
 * their query string describe the same rendition. The *path* (origin +
 * pathname) is the stable identity; the full URI is still kept for
 * diagnostics and for resolving segment URIs.
 *
 * Two segments at the same MSN are the *same* segment only when their
 * byte range, encryption key and initialization map agree. The media URI
 * query string (token rotation) does not participate.
 */

export function renditionId(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    const q = uri.indexOf('?');
    return q === -1 ? uri : uri.slice(0, q);
  }
}

export function segmentUriPath(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    const q = uri.indexOf('?');
    return q === -1 ? uri : uri.slice(0, q);
  }
}

function stableByteRange(b: ByteRange | null): string {
  return b === null ? '-' : `${b.length}@${b.offset}`;
}

function stableKey(k: KeyDescriptor): string {
  if (k.method === 'NONE') return 'NONE';
  return [
    k.method,
    k.uri === null ? '-' : segmentUriPath(k.uri),
    k.iv ?? 'msn',
    k.keyFormat ?? '-',
    k.keyFormatVersions ?? '-',
  ].join('|');
}

function stableMap(m: MapDescriptor | null): string {
  if (m === null) return '-';
  return `${segmentUriPath(m.uri)}#${stableByteRange(m.byteRange)}`;
}

/** Deterministic fingerprint of a segment's addressing and encryption. */
export function segmentFingerprint(seg: Segment): string {
  return [
    seg.msn,
    seg.discontinuitySequence,
    segmentUriPath(seg.uri),
    stableByteRange(seg.byteRange),
    stableKey(seg.key),
    stableMap(seg.initMap),
  ].join('#');
}

/**
 * Compare two observations of the same MSN and report what (if anything)
 * makes them different segments. URI query rotation is intentionally not a
 * difference.
 */
export function identityDifference(
  existing: Segment,
  incoming: Segment,
): 'byte-range' | 'key' | 'init-map' | null {
  if (!sameByteRange(existing.byteRange, incoming.byteRange)) {
    return 'byte-range';
  }
  if (stableKey(existing.key) !== stableKey(incoming.key)) {
    return 'key';
  }
  if (stableMap(existing.initMap) !== stableMap(incoming.initMap)) {
    return 'init-map';
  }
  return null;
}

function sameByteRange(a: ByteRange | null, b: ByteRange | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.offset === b.offset;
}
