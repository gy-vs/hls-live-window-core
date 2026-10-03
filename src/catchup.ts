import { Segment } from './types.js';
import { RenditionStateView } from './tracker.js';
import { AlignmentPoint, getAlignment } from './alignment.js';
import { RenditionRefresh, planRefresh } from './refresh.js';

/**
 * Catch-up planning.
 *
 * Given where a player currently is (or nothing, for a cold start) the plan
 * answers:
 *   - where to start/resume from on every rendition
 *   - how far behind the live edge the player is
 *   - which safe (keyframe / discontinuity) points allow rendition switches
 *   - when to refresh next
 *
 * Every result is a pure function of the tracker state and the inputs.
 */

export interface CatchupPosition {
  /** Last MSN the player has buffered/played. */
  lastBufferedMsn: number;
  /** Optional render position, for behind-edge reporting. */
  renderedAtMs: number | null;
}

export type CatchupMode =
  | 'cold-start'
  | 'live'
  | 'behind'
  | 'catching-up'
  | 'ended'
  | 'waiting';

export interface RenditionCatchup {
  rendition: string;
  mode: CatchupMode;
  firstMsn: number | null;
  lastMsn: number | null;
  /** MSN to start/resume from. */
  startMsn: number | null;
  /** Last MSN worth buffering (usually the tail). */
  endMsn: number | null;
  /** Nearest safe-switch MSN at or after startMsn. */
  safeStartMsn: number | null;
  /** MSNs that were already gone before the player could fetch them. */
  missedFromMsn: number | null;
  missedToMsn: number | null;
  behindSegments: number;
  behindMs: number;
  /** Estimated wall time of the tail segment start (PDT when available). */
  edgeStartAtMs: number | null;
  refresh: RenditionRefresh;
}

export interface CatchupPlan {
  mode: CatchupMode;
  primaryRendition: string | null;
  renditions: RenditionCatchup[];
  safeAlignmentPoints: AlignmentPoint[];
  /** Earliest next refresh across renditions. */
  nextRefreshAt: number | null;
  nowMs: number;
}

export interface CatchupOptions {
  /** Which rendition the player is currently rendering. Defaults to first. */
  primaryRendition?: string;
  /** RFC 8216 §4.3.4.2 default hold-back is 3 target durations. */
  holdBackSegments?: number;
  position?: CatchupPosition | null;
  /** Current time in ms. Used for behind-edge estimates; defaults to 0. */
  nowMs?: number;
}

export function getCatchupPlan(
  renditions: RenditionStateView[],
  options: CatchupOptions = {},
): CatchupPlan {
  const sorted = renditions
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nowMs = options.nowMs ?? 0;
  const holdBack = options.holdBackSegments ?? 3;

  const primary =
    sorted.find((r) => r.id === options.primaryRendition) ??
    sorted[0] ??
    null;

  const alignment = getAlignment(sorted);
  const safePoints = alignment.points.filter((p) => p.safeToSwitch);

  const perRendition = sorted.map((r) =>
    planRendition(r, options.position ?? null, holdBack, nowMs),
  );

  let mode: CatchupMode;
  if (sorted.length === 0) mode = 'waiting';
  else if (perRendition.every((p) => p.mode === 'ended' || p.mode === 'waiting')) {
    mode = perRendition.some((p) => p.mode === 'ended') ? 'ended' : 'waiting';
  } else if (primary === null || options.position === undefined || options.position === null) {
    mode = 'cold-start';
  } else {
    const pm = perRendition.find((p) => p.rendition === primary.id);
    mode = pm ? pm.mode : 'waiting';
  }

  const refreshes = perRendition
    .map((p) => p.refresh.nextRefreshAt)
    .filter((v): v is number => v !== null);
  const nextRefreshAt =
    refreshes.length === 0 ? null : Math.min(...refreshes);

  return {
    mode,
    primaryRendition: primary ? primary.id : null,
    renditions: perRendition,
    safeAlignmentPoints: safePoints,
    nextRefreshAt,
    nowMs,
  };
}

function planRendition(
  r: RenditionStateView,
  position: CatchupPosition | null,
  holdBack: number,
  nowMs: number,
): RenditionCatchup {
  const refresh = planRefresh(r, r.serverControl.canBlockReload);

  if (r.firstMsn === null || r.lastMsn === null || r.segments.length === 0) {
    return {
      rendition: r.id,
      mode: 'waiting',
      firstMsn: null,
      lastMsn: null,
      startMsn: null,
      endMsn: null,
      safeStartMsn: null,
      missedFromMsn: null,
      missedToMsn: null,
      behindSegments: 0,
      behindMs: 0,
      edgeStartAtMs: null,
      refresh,
    };
  }

  const first = r.firstMsn;
  const last = r.lastMsn;
  const edgeStartAtMs = estimateEdgeStart(r, nowMs);
  const isSafe = (msn: number): boolean => {
    const seg = r.segments.find((s) => s.msn === msn);
    if (!seg) return false;
    return seg.discontinuity || r.independentSegments;
  };

  // Position defaults to cold start.
  if (position === null) {
    const startMsn = Math.max(first, last - holdBack + 1);
    return {
      rendition: r.id,
      mode: 'cold-start',
      firstMsn: first,
      lastMsn: last,
      startMsn,
      endMsn: last,
      safeStartMsn: nearestSafe(r, startMsn, isSafe, 1),
      missedFromMsn: null,
      missedToMsn: null,
      behindSegments: last - startMsn,
      behindMs: durationBetween(r, startMsn, last + 1),
      edgeStartAtMs,
      refresh,
    };
  }

  const buffered = position.lastBufferedMsn;
  let missedFrom: number | null = null;
  let missedTo: number | null = null;
  if (buffered < first - 1) {
    missedFrom = buffered + 1;
    missedTo = first - 1;
  }

  let startMsn: number;
  let mode: CatchupMode;
  if (buffered < first - 1) {
    startMsn = first;
    mode = 'catching-up';
  } else {
    startMsn = Math.max(first, buffered + 1);
    const behind = last - buffered;
    if (r.ended) mode = 'ended';
    else if (startMsn > last) mode = 'waiting';
    else if (behind <= holdBack) mode = 'live';
    else mode = behind >= 2 * holdBack ? 'catching-up' : 'behind';
  }

  return {
    rendition: r.id,
    mode,
    firstMsn: first,
    lastMsn: last,
    startMsn,
    endMsn: last,
    safeStartMsn:
      startMsn > last ? null : nearestSafe(r, startMsn, isSafe, 1),
    missedFromMsn: missedFrom,
    missedToMsn: missedTo,
    behindSegments: Math.max(0, last - buffered),
    behindMs: durationBetween(r, Math.min(Math.max(buffered + 1, first), last + 1), last + 1),
    edgeStartAtMs,
    refresh,
  };
}

function nearestSafe(
  r: RenditionStateView,
  fromMsn: number,
  isSafe: (msn: number) => boolean,
  _direction: 1 | -1,
): number | null {
  void _direction;
  for (let msn = fromMsn; msn <= (r.lastMsn ?? fromMsn); msn++) {
    if (isSafe(msn)) return msn;
  }
  return null;
}

function durationBetween(
  r: RenditionStateView,
  fromMsn: number,
  untilMsnExclusive: number,
): number {
  let total = 0;
  for (const seg of r.segments) {
    if (seg.msn >= fromMsn && seg.msn < untilMsnExclusive) {
      total += seg.durationMs;
    }
  }
  return total;
}

function estimateEdgeStart(
  r: RenditionStateView,
  nowMs: number,
): number | null {
  const tail: Segment | undefined = r.segments[r.segments.length - 1];
  if (!tail) return null;
  if (tail.programDateTime !== null) return tail.programDateTime;
  // Relative estimate: the tail began one target duration before "now".
  const target =
    r.targetDurationMs ??
    r.segments.reduce((acc, s) => acc + s.durationMs, 0) /
      Math.max(1, r.segments.length);
  return nowMs - Math.round(target);
}
