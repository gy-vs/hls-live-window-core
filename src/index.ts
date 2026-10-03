/**
 * hls-live-window
 *
 * A deterministic, side-effect-free tracker for HLS live playlists. It does
 * not download media, open sockets or render anything; the caller feeds
 * parsed master/media playlists and asks what is playable right now.
 */

export {
  parsePlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  parseAttributes,
  resolveUri,
} from './parser.js';

export {
  renditionId,
  segmentFingerprint,
  identityDifference,
  segmentUriPath,
} from './identity.js';

export {
  HlsWindowTracker,
  type HlsWindowTracker as HlsLiveWindow,
  type TrackerOptions,
  type IngestResult,
  type RenditionStateView,
} from './tracker.js';

export {
  planRefresh,
  planRefreshAll,
  unchangedReloadMultiplier,
  type RefreshSchedule,
  type RenditionRefresh,
} from './refresh.js';

export {
  getAlignment,
  type AlignmentPoint,
  type RenditionAlignmentResult,
} from './alignment.js';

export {
  getCatchupPlan,
  type CatchupPlan,
  type CatchupOptions,
  type CatchupPosition,
  type CatchupMode,
  type RenditionCatchup,
} from './catchup.js';

export { PlaylistParseError } from './types.js';
export type {
  AnyPlaylist,
  MasterPlaylist,
  MediaPlaylist,
  VariantRendition,
  Segment,
  ByteRange,
  KeyDescriptor,
  MapDescriptor,
  ServerControl,
  PlaylistKind,
  PlaylistMode,
  ParseWarning,
  Diagnostic,
  GapDiagnostic,
  IdentityConflictDiagnostic,
  DiscontinuitySequenceMismatchDiagnostic,
  EventTruncatedDiagnostic,
  VodChangedDiagnostic,
  UndeclaredRenditionDiagnostic,
  RenditionDiscontinuityMismatchDiagnostic,
} from './types.js';

import { HlsWindowTracker } from './tracker.js';

/** Friendly alias for the main entry point. */
export const HlsLiveWindowTracker = HlsWindowTracker;
