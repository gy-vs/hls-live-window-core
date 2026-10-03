/**
 * Public type model for the HLS live window tracker.
 *
 * Time is always expressed as an integer number of milliseconds supplied by
 * the caller. The library never reads the wall clock, which is what makes
 * every result reproducible for a given sequence of inputs.
 */

export type PlaylistKind = 'master' | 'media';

/** Playlist delivery mode derived from its tags. */
export type PlaylistMode = 'live' | 'event' | 'vod';

/** EXT-X-BYTERANGE resolved against the preceding segment when no offset. */
export interface ByteRange {
  length: number;
  offset: number;
}

/** A resolved EXT-X-KEY (or the implicit "none" key). */
export interface KeyDescriptor {
  method: string;
  /** Fully resolved URI, or null for NONE / key-less streams. */
  uri: string | null;
  /** Effective IV as a lowercase hex string; null when derived from MSN. */
  iv: string | null;
  keyFormat: string | null;
  keyFormatVersions: string | null;
}

/** A resolved EXT-X-MAP, including its optional byte range. */
export interface MapDescriptor {
  uri: string;
  byteRange: ByteRange | null;
}

export interface Segment {
  /** Media sequence number of this segment. */
  msn: number;
  /** Discontinuity sequence number of the media section containing it. */
  discontinuitySequence: number;
  /** Fully resolved media URI. */
  uri: string;
  /** EXTINF duration in whole milliseconds. */
  durationMs: number;
  /** Raw EXTINF duration in seconds, kept for diagnostics/round-tripping. */
  durationSec: number;
  /** Carries an EXT-X-DISCONTINUITY tag. */
  discontinuity: boolean;
  /** EXT-X-INDEPENDENT-SEGMENTS applies (global or per-segment). */
  independent: boolean;
  byteRange: ByteRange | null;
  key: KeyDescriptor;
  initMap: MapDescriptor | null;
  /** Absolute program date time of the start of the segment, if present. */
  programDateTime: number | null;
}

/** EXT-X-SERVER-CONTROL as actually seen on the playlist. */
export interface ServerControl {
  canSkipUntil: number | null;
  canSkipDateRanges: boolean;
  holdBackMs: number | null;
  partHoldBackMs: number | null;
  canBlockReload: boolean;
}

export interface MediaPlaylist {
  kind: 'media';
  /** URI the playlist was fetched from (already resolved by the caller). */
  uri: string;
  targetDurationSec: number | null;
  mediaSequence: number;
  discontinuitySequence: number;
  endlist: boolean;
  mode: PlaylistMode;
  independentSegments: boolean;
  serverControl: ServerControl;
  segments: Segment[];
  /** Warnings about tolerated tag problems; parsing did not fail. */
  warnings: ParseWarning[];
}

export interface VariantRendition {
  type: 'variant' | 'iframe';
  /** Fully resolved media playlist URI — the tracker's rendition identity. */
  uri: string;
  bandwidth: number | null;
  averageBandwidth: number | null;
  codecs: string | null;
  resolution: { width: number; height: number } | null;
  frameRate: number | null;
  hdcpLevel: string | null;
  videoRange: string | null;
  name: string | null;
  language: string | null;
  assocLanguage: string | null;
  groupId: string | null;
  isDefault: boolean | null;
  autoselect: boolean | null;
  forced: boolean | null;
  instreamId: string | null;
  characteristics: string | null;
}

export interface MasterPlaylist {
  kind: 'master';
  uri: string;
  renditions: VariantRendition[];
  independentSegments: boolean;
  warnings: ParseWarning[];
}

export type AnyPlaylist = MasterPlaylist | MediaPlaylist;

export interface ParseWarning {
  code:
    | 'missing-extm3u'
    | 'unrecognized-tag'
    | 'invalid-attr'
    | 'late-tag'
    | 'unexpected-tag'
    | 'invalid-value';
  message: string;
  line: number;
}

export class PlaylistParseError extends Error {
  readonly line: number | null;
  constructor(message: string, line: number | null = null) {
    super(line === null ? message : `${message} (line ${line + 1})`);
    this.name = 'PlaylistParseError';
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics produced by merging/queries
// ---------------------------------------------------------------------------

interface DiagnosticBase {
  code: string;
  message: string;
  /** Rendering id of the rendition (identity key), when applicable. */
  rendition: string | null;
}

/** A confirmed run of missing media sequence numbers on one rendition. */
export interface GapDiagnostic extends DiagnosticBase {
  code: 'window-slide' | 'sequence-jump';
  rendition: string;
  /** First MSN no longer obtainable. */
  fromMsn: number;
  /** Last MSN no longer obtainable (inclusive). */
  toMsn: number;
  count: number;
  /** MSN of the last segment known before the hole (inclusive boundary). */
  previousMsn: number | null;
  /** MSN of the first segment seen after the hole. */
  nextMsn: number;
}

/** Same MSN seen with different key, byte range or init map. */
export interface IdentityConflictDiagnostic extends DiagnosticBase {
  code: 'segment-identity-conflict';
  rendition: string;
  msn: number;
  existingUri: string;
  incomingUri: string;
  difference: 'byte-range' | 'key' | 'init-map';
}

/** A discontinuity-sequence number changed without a corresponding gap. */
export interface DiscontinuitySequenceMismatchDiagnostic
  extends DiagnosticBase {
  code: 'discontinuity-sequence-mismatch';
  rendition: string;
  expected: number;
  actual: number;
  atMsn: number;
}

/** An EVENT playlist trimmed its head, which the spec forbids. */
export interface EventTruncatedDiagnostic extends DiagnosticBase {
  code: 'event-truncated';
  rendition: string;
  previousFirstMsn: number;
  incomingFirstMsn: number;
}

/** A VOD / ended playlist changed segments it had already published. */
export interface VodChangedDiagnostic extends DiagnosticBase {
  code: 'vod-content-changed';
  rendition: string;
  msn: number | null;
  difference: 'segment-identity' | 'sequence' | 'media-sequence';
}

/** A media playlist was fed without any declaration in a master playlist. */
export interface UndeclaredRenditionDiagnostic extends DiagnosticBase {
  code: 'undeclared-rendition';
  rendition: string;
}

/** Discontinuity markers / sections do not line up across renditions. */
export interface RenditionDiscontinuityMismatchDiagnostic
  extends DiagnosticBase {
  code: 'rendition-discontinuity-mismatch';
  rendition: string;
  msn: number;
  expectedDiscontinuity: boolean;
  actualDiscontinuity: boolean;
}

export type Diagnostic =
  | GapDiagnostic
  | IdentityConflictDiagnostic
  | DiscontinuitySequenceMismatchDiagnostic
  | EventTruncatedDiagnostic
  | VodChangedDiagnostic
  | UndeclaredRenditionDiagnostic
  | RenditionDiscontinuityMismatchDiagnostic;
