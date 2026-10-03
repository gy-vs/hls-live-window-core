import { RenditionStateView } from './tracker.js';

/**
 * Refresh planning (RFC 8216 §6.3.4, made deterministic).
 *
 * - first reload after a playlist: target duration
 * - subsequent reloads while nothing changes: target duration for the first
 *   retry, then x1.5, capped at x2 — the conventional backoff that keeps an
 *   idle player from hammering the origin
 * - ENDLIST / VOD: never reload
 *
 * LL-HLS CAN-BLOCK-RELOAD allows polling immediately, but only the immediate
 * next poll; the one after that still paces on target duration.
 */

export interface RenditionRefresh {
  rendition: string;
  mode: RenditionStateView['mode'];
  ended: boolean;
  targetDurationMs: number | null;
  /** Delay the caller should wait before the next fetch. */
  intervalMs: number;
  /** fetchedAt + intervalMs, or null when no further refresh is needed. */
  nextRefreshAt: number | null;
  /** True when the next fetch may be a blocking reload. */
  canBlockReload: boolean;
  unchangedStreak: number;
}

export interface RefreshSchedule {
  /** Earliest refresh across every live rendition. */
  nextRefreshAt: number | null;
  /** Absolute earliest refresh timestamp (same value, named for sleep use). */
  waitMs: number;
  renditions: RenditionRefresh[];
}

/** RFC-style multiplier for the nth unchanged reload (0-indexed). */
export function unchangedReloadMultiplier(streak: number): number {
  if (streak <= 1) return 1;
  if (streak === 2) return 1.5;
  return 2;
}

export function planRefresh(
  rendition: RenditionStateView,
  canBlockReload = false,
): RenditionRefresh {
  const target =
    rendition.targetDurationMs ?? fallbackTargetDurationMs(rendition);
  let intervalMs: number;
  let nextRefreshAt: number | null;

  if (rendition.ended || rendition.mode === 'vod') {
    intervalMs = 0;
    nextRefreshAt = null;
  } else if (canBlockReload && rendition.unchangedStreak === 0) {
    // The playlist supports blocking reload and this is the immediate next
    // poll: long-poll now.
    intervalMs = 0;
    nextRefreshAt = rendition.frontierFetchedAt;
  } else {
    const multiplier = unchangedReloadMultiplier(rendition.unchangedStreak);
    intervalMs = Math.max(1, Math.round(target * multiplier));
    nextRefreshAt = rendition.frontierFetchedAt + intervalMs;
  }

  return {
    rendition: rendition.id,
    mode: rendition.mode,
    ended: rendition.ended,
    targetDurationMs: rendition.targetDurationMs,
    intervalMs,
    nextRefreshAt,
    canBlockReload,
    unchangedStreak: rendition.unchangedStreak,
  };
}

export function planRefreshAll(
  renditions: RenditionStateView[],
  options: { honorBlockReload?: boolean } = {},
): RefreshSchedule {
  const honorBlockReload = options.honorBlockReload ?? false;
  const per = renditions.map((r) =>
    planRefresh(r, honorBlockReload && r.serverControl.canBlockReload),
  );
  per.sort((a, b) =>
    a.rendition < b.rendition ? -1 : a.rendition > b.rendition ? 1 : 0,
  );

  const live = per.filter((p) => p.nextRefreshAt !== null);
  if (live.length === 0) {
    return { nextRefreshAt: null, waitMs: -1, renditions: per };
  }
  const next = live.reduce(
    (min, p) => Math.min(min, p.nextRefreshAt as number),
    Infinity,
  );
  return { nextRefreshAt: next, waitMs: next, renditions: per };
}

function fallbackTargetDurationMs(r: RenditionStateView): number {
  if (r.segments.length === 0) return 5000;
  const sum = r.segments.reduce((acc, s) => acc + s.durationMs, 0);
  return Math.max(1, Math.round(sum / r.segments.length));
}
