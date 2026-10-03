/**
 * Code-generated HLS playlist samples for tests. Nothing here hits the
 * network; text is built deterministically from the parameters.
 */

export interface KeySpec {
  method: string;
  uri: string;
  ivHex?: string;
  keyFormat?: string;
}

export interface MediaSegmentSpec {
  /** Absolute msn; the generator assigns EXTINF/URI lines in array order. */
  msn: number;
  durationSec: number;
  uri?: string;
  /** Emit #EXT-X-DISCONTINUITY before this segment. */
  discontinuity?: boolean;
  /** Absolute program date time at segment start, epoch ms. */
  pdtMs?: number;
  byteRange?: { length: number; start?: number };
  /** Key in effect from this segment onward (emits EXT-X-KEY). */
  key?: KeySpec | null;
  /** Initialization section (emits EXT-X-MAP). */
  map?: { uri: string; byteRange?: { length: number; start: number } } | null;
}

export interface MediaPlaylistSpec {
  targetDurationSec: number;
  /** Default dseq used until a discontinuity marker bumps it. */
  discontinuitySequence?: number;
  mediaSequence?: number;
  type?: 'live' | 'event' | 'vod';
  endList?: boolean;
  version?: number;
  independentSegments?: boolean;
  serverControl?: {
    canBlockReload?: boolean;
    canSkipUntil?: number;
    holdBack?: number;
    partHoldBack?: number;
  };
  segments: MediaSegmentSpec[];
}

export function buildMediaPlaylist(spec: MediaPlaylistSpec): string {
  const lines: string[] = ['#EXTM3U'];
  lines.push(`#EXT-X-VERSION:${spec.version ?? 3}`);
  if (spec.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  if (spec.type === 'event') lines.push('#EXT-X-PLAYLIST-TYPE:EVENT');
  if (spec.type === 'vod') lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
  lines.push(`#EXT-X-TARGETDURATION:${spec.targetDurationSec}`);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${spec.mediaSequence ?? spec.segments[0]?.msn ?? 0}`);
  if (spec.discontinuitySequence !== undefined) {
    lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${spec.discontinuitySequence}`);
  }
  if (spec.serverControl) {
    const attrs: string[] = [];
    if (spec.serverControl.canBlockReload) attrs.push('CAN-BLOCK-RELOAD=YES');
    if (spec.serverControl.canSkipUntil !== undefined)
      attrs.push(`CAN-SKIP-UNTIL=${spec.serverControl.canSkipUntil}`);
    if (spec.serverControl.holdBack !== undefined)
      attrs.push(`HOLD-BACK=${spec.serverControl.holdBack}`);
    if (spec.serverControl.partHoldBack !== undefined)
      attrs.push(`PART-HOLD-BACK=${spec.serverControl.partHoldBack}`);
    lines.push(`#EXT-X-SERVER-CONTROL:${attrs.join(',')}`);
  }

  for (const seg of spec.segments) {
    if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (seg.pdtMs !== undefined) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(seg.pdtMs)}`);
    if (seg.key !== undefined) {
      if (seg.key === null) {
        lines.push('#EXT-X-KEY:METHOD=NONE');
      } else {
        const parts = [`METHOD=${seg.key.method}`, `URI="${seg.key.uri}"`];
        if (seg.key.ivHex) parts.push(`IV=0x${seg.key.ivHex}`);
        if (seg.key.keyFormat) parts.push(`KEYFORMAT="${seg.key.keyFormat}"`);
        lines.push(`#EXT-X-KEY:${parts.join(',')}`);
      }
    }
    if (seg.map !== undefined) {
      if (seg.map === null) {
        // explicit "clear map" isn't a real tag; callers use null to leave
        // the previous map in effect is not supported.
      } else {
        const br = seg.map.byteRange
          ? `,BYTERANGE="${seg.map.byteRange.length}@${seg.map.byteRange.start}"`
          : '';
        lines.push(`#EXT-X-MAP:URI="${seg.map.uri}"${br}`);
      }
    }
    if (seg.byteRange) {
      const br =
        seg.byteRange.start !== undefined
          ? `${seg.byteRange.length}@${seg.byteRange.start}`
          : `${seg.byteRange.length}`;
      lines.push(`#EXT-X-BYTERANGE:${br}`);
    }
    lines.push(`#EXTINF:${seg.durationSec.toFixed(3)},`);
    lines.push(seg.uri ?? `seg-${seg.msn}.ts`);
  }

  if (spec.endList) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export interface VariantSpec {
  uri: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  codecs?: string;
  audio?: string;
}

export interface MasterSpec {
  variants: VariantSpec[];
  media?: {
    type: 'AUDIO' | 'SUBTITLES' | 'VIDEO';
    groupId: string;
    name: string;
    uri?: string;
    language?: string;
    default?: boolean;
  }[];
  independentSegments?: boolean;
}

export function buildMasterPlaylist(spec: MasterSpec): string {
  const lines: string[] = ['#EXTM3U'];
  if (spec.independentSegments) lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
  for (const m of spec.media ?? []) {
    const parts = [
      `TYPE=${m.type}`,
      `GROUP-ID="${m.groupId}"`,
      `NAME="${m.name}"`
    ];
    if (m.uri) parts.push(`URI="${m.uri}"`);
    if (m.language) parts.push(`LANGUAGE="${m.language}"`);
    if (m.default) parts.push('DEFAULT=YES');
    lines.push(`#EXT-X-MEDIA:${parts.join(',')}`);
  }
  for (const v of spec.variants) {
    const parts = [`BANDWIDTH=${v.bandwidth}`];
    if (v.codecs) parts.push(`CODECS="${v.codecs}"`);
    if (v.resolution) parts.push(`RESOLUTION=${v.resolution.width}x${v.resolution.height}`);
    if (v.audio) parts.push(`AUDIO="${v.audio}"`);
    lines.push(`#EXT-X-STREAM-INF:${parts.join(',')}`);
    lines.push(v.uri);
  }
  return lines.join('\n') + '\n';
}

/** Build a uniform run of segments [fromMsn, toMsn] with fixed duration. */
export function segmentRun(
  fromMsn: number,
  toMsn: number,
  durationSec: number,
  extra: Partial<MediaSegmentSpec> = {}
): MediaSegmentSpec[] {
  const out: MediaSegmentSpec[] = [];
  for (let msn = fromMsn; msn <= toMsn; msn += 1) {
    out.push({ msn, durationSec, ...extra });
  }
  return out;
}

/**
 * A live playlist with an ad pod:
 *   dseq 0: main content [mainFrom..adStart-1]
 *   dseq 1: ad pod [adStart..adEnd-1]  (timestamps reset: pdt absent inside)
 *   dseq 2: main content resumes [adEnd..to]
 */
export interface AdPodSpec {
  mainFrom: number;
  adStart: number;
  adEnd: number;
  to: number;
  durationSec: number;
  basePdtMs?: number;
  mediaSequence?: number;
  targetDurationSec?: number;
  discontinuitySequence?: number;
}

export function buildAdPodPlaylist(spec: AdPodSpec): string {
  const segments: MediaSegmentSpec[] = [];
  for (let msn = spec.mainFrom; msn <= spec.to; msn += 1) {
    const isAd = msn >= spec.adStart && msn < spec.adEnd;
    const isResume = msn === spec.adEnd;
    const seg: MediaSegmentSpec = {
      msn,
      durationSec: spec.durationSec,
      discontinuity: msn === spec.adStart || isResume
    };
    if (spec.basePdtMs !== undefined && !isAd) {
      // Main-content PDT keeps advancing; after the ad it resumes as if
      // ad duration was real wall-clock time too (server decides).
      seg.pdtMs = spec.basePdtMs + (msn - spec.mainFrom) * spec.durationSec * 1000;
    }
    segments.push(seg);
  }
  return buildMediaPlaylist({
    targetDurationSec: spec.targetDurationSec ?? spec.durationSec,
    mediaSequence: spec.mediaSequence ?? spec.mainFrom,
    discontinuitySequence: spec.discontinuitySequence,
    segments
  });
}

/** Deterministic ISO-8601 (UTC, milliseconds). */
export function iso(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toISOString();
}

/** Shift absolute msns in a spec run to a window slice. */
export function sliceSegments(
  segments: MediaSegmentSpec[],
  fromMsn: number,
  toMsn: number
): MediaSegmentSpec[] {
  return segments.filter((s) => s.msn >= fromMsn && s.msn <= toMsn);
}
