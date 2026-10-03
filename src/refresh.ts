/**
 * Deterministic reload scheduling.
 *
 * Everything is computed from caller-provided `nowMs` (the fetch time of the
 * latest batch) and playlist metadata. A small deterministic jitter derived
 * from the playlist URI keeps synchronized encoders from being polled in
 * lock-step, but the result for identical inputs is always identical.
 */
import { Catalog, RenditionState } from './catalog.js';
import { RefreshReport, RenditionRefresh } from './types.js';
import { clamp, sortedMapEntries } from './util.js';

const UNCHANGED_BASE_MULTIPLIER = 1.5;
const UNCHANGED_MAX_MULTIPLIER = 3;
const EDGE_MULTIPLIER = 1;
const LIVE_BACKOFF_SECONDS = 5;

export function buildRefresh(catalog: Catalog, nowMs: number): RefreshReport {
  const renditions: RenditionRefresh[] = [];

  for (const [, state] of sortedMapEntries(catalog.renditions)) {
    renditions.push(planRendition(state, nowMs));
  }

  const needing = renditions.filter((r) => r.nextFetchMs !== null);
  needing.sort((a, b) =>
    a.nextFetchMs === b.nextFetchMs
      ? a.renditionId < b.renditionId
        ? -1
        : 1
      : a.nextFetchMs! < b.nextFetchMs!
        ? -1
        : 1
  );
  return {
    generation: catalog.generation,
    nextFetchMs: needing.length > 0 ? needing[0]!.nextFetchMs : null,
    renditions
  };
}

function planRendition(state: RenditionState, nowMs: number): RenditionRefresh {
  const id = state.descriptor.id;
  const uri = state.descriptor.uri;
  const playlist = state.latest;

  const base: Omit<RenditionRefresh, 'status' | 'nextFetchMs' | 'delayMs' | 'reason'> = {
    renditionId: id,
    uri,
    targetDurationMs: playlist?.targetDurationSec !== undefined && playlist?.targetDurationSec !== null
      ? playlist.targetDurationSec * 1000
      : null,
    reloadMultiplier: 1
  };

  if (playlist?.type === 'vod') {
    return {
      ...base,
      status: 'vod',
      nextFetchMs: null,
      delayMs: null,
      reason: 'vod'
    };
  }
  if (state.everEnded) {
    return {
      ...base,
      status: 'ended',
      nextFetchMs: null,
      delayMs: null,
      reason: 'ended'
    };
  }
  if (!playlist || playlist.targetDurationSec === null) {
    const targetMs = base.targetDurationMs ?? LIVE_BACKOFF_SECONDS * 1000;
    const delayMs = withJitter(targetMs, uri, state.unchangedCount);
    return {
      ...base,
      targetDurationMs: base.targetDurationMs,
      status: 'unknown',
      nextFetchMs: nowMs + delayMs,
      delayMs,
      reason: 'unknown-target-duration',
      reloadMultiplier: 1
    };
  }

  const status: RenditionRefresh['status'] = playlist.type === 'event' ? 'event' : 'live';
  const targetMs = playlist.targetDurationSec * 1000;

  if (state.unchangedCount > 0) {
    const multiplier = Math.min(
      UNCHANGED_MAX_MULTIPLIER,
      UNCHANGED_BASE_MULTIPLIER * 2 ** Math.max(0, state.unchangedCount - 1)
    );
    const delayMs = withJitter(Math.round(targetMs * multiplier), uri, state.unchangedCount);
    return {
      ...base,
      status,
      nextFetchMs: nowMs + delayMs,
      delayMs,
      reason: 'unchanged-backoff',
      reloadMultiplier: multiplier
    };
  }

  const lastSeg = playlist.segments[playlist.segments.length - 1] ?? null;
  let delayMs: number;
  let reason: RenditionRefresh['reason'];

  if (lastSeg !== null && lastSeg.pdtEnd !== null && Number.isFinite(lastSeg.pdtEnd)) {
    // Schedule from the actual end of the last segment.
    const edgeMs = Math.max(0, lastSeg.pdtEnd - nowMs);
    delayMs = clamp(edgeMs, 0, targetMs * 2);
    reason = 'live-edge-age';
  } else {
    // Without PDT we cannot know segment age; use one target duration. The
    // returned plan may poll slightly early, but never in a tight loop.
    delayMs = targetMs * EDGE_MULTIPLIER;
    reason = playlist.type === 'event' ? 'event-grow' : 'live-edge-age';
  }

  const jittered = withJitter(delayMs, uri, state.unchangedCount);
  return {
    ...base,
    status,
    nextFetchMs: nowMs + jittered,
    delayMs: jittered,
    reason,
    reloadMultiplier: 1
  };
}

/**
 * Deterministic jitter in [-5%, +5%] (never negative), derived from a stable
 * hash of uri + attempt. No RNG, no clock.
 */
function withJitter(delayMs: number, uri: string, attempt: number): number {
  if (delayMs <= 0) return delayMs;
  const span = Math.floor(delayMs * 0.1);
  if (span === 0) return delayMs;
  const h = fnv1a(`${uri}#${attempt}`);
  const offset = (h % (span + 1)) - Math.floor(span / 2);
  return delayMs + offset;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
