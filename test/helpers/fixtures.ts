/**
 * Code-generated playlist fixtures. Tests never read fixture files; every
 * playlist text is assembled here so the exact bytes are obvious from the
 * test that uses them.
 */

export interface SegmentSpec {
  /** Relative URI; defaults to seg{N}.ts when omitted. */
  uri?: string;
  durationSec?: number;
  /** Emit EXT-X-DISCONTINUITY before this segment. */
  discontinuity?: boolean;
  /** Emit EXT-X-PROGRAM-DATE-TIME before this segment (ms epoch). */
  pdtMs?: number;
  /** Emit EXT-X-BYTERANGE before this segment. */
  byteRange?: string;
  /** Emit EXT-X-KEY before this segment. */
  key?: KeySpec | null;
  /** Emit EXT-X-MAP before this segment. */
  map?: { uri: string; byteRange?: string } | null;
}

export interface KeySpec {
  method: string;
  uri?: string;
  iv?: string;
  keyformat?: string;
  keyformatversions?: string;
}

export interface MediaPlaylistSpec {
  targetDuration?: number;
  mediaSequence?: number;
  discontinuitySequence?: number;
  endlist?: boolean;
  playlistType?: 'EVENT' | 'VOD';
  independentSegments?: boolean;
  serverControl?: Record<string, string>;
  segments: SegmentSpec[];
}

export function buildMediaPlaylist(spec: MediaPlaylistSpec): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:6'];
  if (spec.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (spec.playlistType) lines.push(`#EXT-X-PLAYLIST-TYPE:${spec.playlistType}`);
  if (spec.serverControl) {
    const attrs = Object.entries(spec.serverControl)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    lines.push(`#EXT-X-SERVER-CONTROL:${attrs}`);
  }
  if (spec.targetDuration !== undefined) {
    lines.push(`#EXT-X-TARGETDURATION:${spec.targetDuration}`);
  }
  if (spec.mediaSequence !== undefined) {
    lines.push(`#EXT-X-MEDIA-SEQUENCE:${spec.mediaSequence}`);
  }
  if (spec.discontinuitySequence !== undefined) {
    lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${spec.discontinuitySequence}`);
  }

  let implicit = 0;
  const seenSequence = spec.mediaSequence ?? 0;
  for (const seg of spec.segments) {
    if (seg.key !== undefined) lines.push(buildKey(seg.key));
    if (seg.map !== undefined && seg.map !== null) {
      const br = seg.map.byteRange ? `,BYTERANGE="${seg.map.byteRange}"` : '';
      lines.push(`#EXT-X-MAP:URI="${seg.map.uri}"${br}`);
    }
    if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (seg.pdtMs !== undefined) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(seg.pdtMs).toISOString()}`);
    }
    if (seg.byteRange !== undefined) {
      lines.push(`#EXT-X-BYTERANGE:${seg.byteRange}`);
    }
    const idx = seenSequence + implicit;
    implicit += 1;
    const duration = seg.durationSec ?? 2;
    lines.push(`#EXTINF:${duration.toFixed(3)},`);
    lines.push(seg.uri ?? `seg${idx}.ts`);
  }
  if (spec.endlist) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function buildKey(key: KeySpec | null): string {
  if (key === null) return '#EXT-X-KEY:METHOD=NONE';
  const parts: string[] = [`METHOD=${key.method}`];
  if (key.uri !== undefined) parts.push(`URI="${key.uri}"`);
  if (key.iv !== undefined) parts.push(`IV=${key.iv}`);
  if (key.keyformat !== undefined) parts.push(`KEYFORMAT="${key.keyformat}"`);
  if (key.keyformatversions !== undefined) {
    parts.push(`KEYFORMATVERSIONS="${key.keyformatversions}"`);
  }
  return `#EXT-X-KEY:${parts.join(',')}`;
}

export interface VariantSpec {
  uri: string;
  bandwidth: number;
  codecs?: string;
  resolution?: string;
  frameRate?: number;
  independentSegments?: boolean;
}

export function buildMasterPlaylist(variants: VariantSpec[]): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:6'];
  if (variants.some((v) => v.independentSegments)) {
    lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  }
  for (const v of variants) {
    const attrs: string[] = [
      `BANDWIDTH=${v.bandwidth}`,
      v.codecs ? `CODECS="${v.codecs}"` : '',
      v.resolution ? `RESOLUTION=${v.resolution}` : '',
      v.frameRate !== undefined ? `FRAME-RATE=${v.frameRate}` : '',
    ].filter(Boolean);
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
    lines.push(v.uri);
  }
  return lines.join('\n') + '\n';
}

/** Generate n plain segments starting at the given media sequence. */
export function plainSegments(
  n: number,
  startMsn: number,
  extra: Partial<SegmentSpec> = {},
): SegmentSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    uri: `seg${startMsn + i}.ts`,
    durationSec: 2,
    ...extra,
  }));
}
