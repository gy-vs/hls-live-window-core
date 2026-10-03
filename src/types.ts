/**
 * Public type definitions for the HLS window tracker.
 *
 * Every collection in every returned object is deterministically sorted; the
 * tracker itself never reads the wall clock or any other ambient state.
 */

/** Byte range of a segment inside a shared resource (EXT-X-BYTERANGE). */
export interface ByteRange {
  /** Start byte offset inside the resource. */
  offset: number;
  /** Length in bytes. */
  length: number;
}

/** EXT-X-KEY information that distinguishes otherwise identical segments. */
export interface KeyInfo {
  method: string;
  uri: string | null;
  /** Normalized initialization vector (lower-case hex), or null. */
  iv: string | null;
  keyFormat: string | null;
  keyFormatVersions: string | null;
}

/** EXT-X-MAP (initialization section). */
export interface MapInfo {
  uri: string;
  byteRange: ByteRange | null;
}

/** A single media segment (what a player actually fetches). */
export interface Segment {
  /** Media sequence number. */
  msn: number;
  uri: string;
  byteRange: ByteRange | null;
  /** Duration in milliseconds (integer, truncated). */
  durationMs: number;
  /** Program date time of the segment start, epoch milliseconds, or null. */
  pdtStart: number | null;
  /** Program date time of the segment end, or null. */
  pdtEnd: number | null;
  key: KeyInfo | null;
  map: MapInfo | null;
  /** True when this segment starts a discontinuity region. */
  discontinuity: boolean;
  /** Discontinuity sequence number in effect for this segment. */
  dseq: number;
}

/** Parsed media playlist (one rendition at one point in time). */
export interface MediaPlaylist {
  resolvedUri: string;
  version: number;
  targetDurationSec: number | null;
  mediaSequence: number;
  discontinuitySequence: number;
  allowCache: boolean;
  iFrameOnly: boolean;
  independentSegments: boolean;
  /** Live (sliding window) | event (growing) | vod (closed list). */
  type: 'live' | 'event' | 'vod';
  endList: boolean;
  serverControl: {
    canBlockReload: boolean;
    canSkipUntil: number | null;
    holdBack: number | null;
    partHoldBack: number | null;
  };
  segments: Segment[];
}

/** A rendition advertised in a master playlist. */
export interface VariantStream {
  uri: string;
  resolvedUri: string;
  bandwidth: number;
  averageBandwidth: number | null;
  codecs: string | null;
  resolution: { width: number; height: number } | null;
  frameRate: number | null;
  hdcpLevel: string | null;
  videoRange: 'sdr' | 'hlg' | 'dolby-vision' | 'unknown';
  audioGroup: string | null;
  videoGroup: string | null;
  subtitlesGroup: string | null;
  closedCaptionsGroup: string | null;
  /** Stable identity assigned while parsing (v0, v1, ... in order). */
  variantId: string;
}

/** An EXT-X-MEDIA entry (audio/video/subtitles rendition). */
export interface MediaRenditionSpec {
  type: 'audio' | 'video' | 'subtitles' | 'closed-captions';
  groupId: string;
  name: string;
  uri: string | null;
  resolvedUri: string | null;
  language: string | null;
  assocLanguage: string | null;
  isDefault: boolean;
  autoselect: boolean;
  forced: boolean;
  instreamId: string | null;
  characteristics: string | null;
  channels: string | null;
}

/** Parsed master playlist. */
export interface MasterPlaylist {
  resolvedUri: string;
  independentSegments: boolean;
  variants: VariantStream[];
  media: MediaRenditionSpec[];
}

/**
 * A confirmed hole in a rendition timeline.
 *
 * Gaps are only ever *confirmed* (never guessed from a sliding window head):
 * either a reload skipped over sequence numbers with evidence on both sides,
 * or a discontinuity sequence number did not line up with observed markers.
 */
export interface Gap {
  playlistUri: string;
  fromMsn: number;
  toMsn: number;
  /** Dseq observed on the segment before the hole, if known. */
  dseqBefore: number | null;
  /** Dseq observed on the segment after the hole, if known. */
  dseqAfter: number | null;
  reason:
    | 'window-slide'
    | 'sequence-jump'
    | 'dseq-mismatch';
  severity: 'info' | 'warning' | 'error';
  detectedInGeneration: number;
  recoveredInGeneration: number | null;
}

/** Playable range for a single rendition, split across eras (dseq regions). */
export interface PlayableRendition {
  renditionId: string;
  uri: string;
  kind: 'variant' | 'audio' | 'video' | 'subtitles' | 'closed-captions';
  label: string;
  status: 'live' | 'event' | 'vod' | 'ended' | 'unknown';
  /** Head/tail of the current (latest accepted) window. */
  windowHeadMsn: number | null;
  windowTailMsn: number | null;
  /** Contiguous, non-gapped ranges that can be played right now. */
  playable: { fromMsn: number; toMsn: number; dseq: number }[];
  /** Confirmed unrecovered gaps inside the current window, sorted by msn. */
  gaps: Gap[];
}

export interface PlayableReport {
  generation: number;
  renditions: PlayableRendition[];
}

/** One point where renditions can be switched/resynchronized. */
export interface AlignmentPoint {
  /** Segment on the reference rendition. */
  referenceMsn: number;
  /** Map renditionId -> msn at this point. */
  at: Record<string, number>;
  pdtMs: number | null;
  /** True when the point is a discontinuity boundary in every rendition. */
  discontinuityBoundary: boolean;
}

/** Alignment information for one era (one dseq region, e.g. one ad pod). */
export interface EraAlignment {
  dseq: number;
  mode: 'pdt' | 'sequence' | 'none';
  points: AlignmentPoint[];
  /** Common contiguous msn range per rendition inside this era. */
  commonPlayable: Record<string, { fromMsn: number; toMsn: number }>;
}

export interface AlignmentReport {
  generation: number;
  referenceRenditionId: string | null;
  renditionIds: string[];
  eras: EraAlignment[];
}

/**
 * Locatable diagnostic. Every hint always names the playlist and, when
 * relevant, the exact segment (msn).
 */
export interface Diagnostic {
  code:
    | 'sequence-jump'
    | 'window-slide'
    | 'dseq-mismatch'
    | 'same-msn-conflict'
    | 'event-window-shrank'
    | 'stale-playlist'
    | 'empty-media-playlist'
    | 'unparseable-line'
    | 'master-variant-uri-changed';
  severity: 'info' | 'warning' | 'error';
  playlistUri: string;
  msn: number | null;
  message: string;
  details: Record<string, string | number | boolean | null>;
  generation: number;
}

export interface RenditionRefresh {
  renditionId: string;
  uri: string;
  status: 'live' | 'event' | 'vod' | 'ended' | 'unknown';
  /** Epoch ms of the next recommended fetch, or null if no refresh needed. */
  nextFetchMs: number | null;
  /** Delay in ms relative to the input reference time. */
  delayMs: number | null;
  reason:
    | 'vod'
    | 'ended'
    | 'unknown-target-duration'
    | 'unchanged-backoff'
    | 'live-edge-age'
    | 'event-grow';
  targetDurationMs: number | null;
  reloadMultiplier: number;
}

export interface RefreshReport {
  generation: number;
  /** Epoch ms when the caller should refresh at least one rendition. */
  nextFetchMs: number | null;
  renditions: RenditionRefresh[];
}

export type CatchUpStep =
  | {
      kind: 'play';
      fromMsn: number;
      toMsn: number;
      dseq: number;
      /** msn to use on every other rendition that covers the same time. */
      at: Record<string, number>;
    }
  | { kind: 'gap'; gap: Gap }
  | {
      kind: 'discontinuity';
      msn: number;
      fromDseq: number;
      toDseq: number;
    }
  | {
      kind: 'catch-live-edge';
      targetMsn: number;
      at: Record<string, number>;
    }
  | { kind: 'end-of-play'; msn: number }
  | { kind: 'wait'; delayMs: number; untilMs: number };

export interface CatchUpPlan {
  generation: number;
  referenceRenditionId: string;
  startsAtMsn: number;
  steps: CatchUpStep[];
}
