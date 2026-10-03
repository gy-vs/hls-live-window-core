import { describe, expect, it } from 'vitest';
import { HlsWindowTracker } from '../src/index.js';
import {
  buildAdPodPlaylist,
  buildMasterPlaylist,
  buildMediaPlaylist
} from './helpers/playlists.js';

const MASTER = 'http://example.com/live/master.m3u8';
const LOW = 'http://example.com/live/low.m3u8';
const HIGH = 'http://example.com/live/high.m3u8';

/** Drive a tracker through a fixed script and return a stable snapshot. */
function runScript() {
  const tracker = new HlsWindowTracker();
  const master = buildMasterPlaylist({
    variants: [
      { uri: 'low.m3u8', bandwidth: 100_000 },
      { uri: 'high.m3u8', bandwidth: 500_000 }
    ]
  });
  tracker.ingest(master, { uri: MASTER, fetchedAtMs: 0 });

  const ad = buildAdPodPlaylist({
    mainFrom: 0,
    adStart: 5,
    adEnd: 8,
    to: 12,
    durationSec: 6,
    basePdtMs: 1_700_000_000_000
  });
  tracker.ingest(ad, { uri: LOW, fetchedAtMs: 1000 });
  tracker.ingest(ad, { uri: HIGH, fetchedAtMs: 1000 });

  // Late older snapshot must be rejected.
  tracker.ingest(
    buildMediaPlaylist({
      targetDurationSec: 6,
      segments: [0, 1, 2].map((msn) => ({ msn, durationSec: 6 }))
    }),
    { uri: LOW, fetchedAtMs: 1500 }
  );

  // Windows slide.
  const slide = buildAdPodPlaylist({
    mainFrom: 3,
    adStart: 5,
    adEnd: 8,
    to: 15,
    durationSec: 6,
    basePdtMs: 1_700_000_000_000 + 3 * 6000
  });
  tracker.ingest(slide, { uri: LOW, fetchedAtMs: 2000 });
  tracker.ingest(slide, { uri: HIGH, fetchedAtMs: 2000 });

  return {
    playable: tracker.playable(),
    alignment: tracker.alignment(),
    refresh: tracker.refreshPlans(2000),
    catchUp: tracker.catchUpPlan({ nowMs: 2000 }),
    diagnostics: tracker.getDiagnostics()
  };
}

describe('determinism', () => {
  it('produces byte-identical results and ordering across runs', () => {
    const a = runScript();
    const b = runScript();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('orders renditions and diagnostics stably', () => {
    const { playable, diagnostics } = runScript();
    const ids = playable.renditions.map((r) => r.renditionId);
    expect(ids).toEqual([...ids].sort());
    const gens = diagnostics.map((d) => d.generation);
    expect(gens).toEqual([...gens].sort((x, y) => x - y));
  });

  it('does not depend on wall clock: same nowMs => same refresh times', () => {
    const a = runScript().refresh;
    const b = runScript().refresh;
    expect(b.nextFetchMs).toBe(a.nextFetchMs);
    expect(b.renditions.map((r) => [r.renditionId, r.nextFetchMs])).toEqual(
      a.renditions.map((r) => [r.renditionId, r.nextFetchMs])
    );
  });
});

describe('end-to-end: live with mid-roll ad, slide, stale delivery', () => {
  it('keeps playable windows, eras, gaps and refresh coherent', () => {
    const r = runScript();

    // Playable windows advanced and never retreated.
    const low = r.playable.renditions.find((x) => x.renditionId === 'v0')!;
    expect(low.windowTailMsn).toBe(3);
    expect(low.windowHeadMsn).toBe(15);

    // Eras survive the slide: before-ad, ad, after-ad.
    expect(r.alignment.eras.map((e) => e.dseq)).toEqual([0, 1, 2]);
    const after = r.alignment.eras.find((e) => e.dseq === 2)!;
    expect(after.commonPlayable.v0).toEqual({ fromMsn: 8, toMsn: 15 });

    // Stale snapshot was rejected.
    expect(r.diagnostics.some((d) => d.code === 'stale-playlist')).toBe(true);

    // Refresh is scheduled, and far enough out (no busy loop).
    expect(r.refresh.nextFetchMs).not.toBeNull();
    expect(r.refresh.nextFetchMs! - 2000).toBeGreaterThan(5000);

    // Catch-up crosses both discontinuities.
    const dSteps = r.catchUp!.steps.filter((s) => s.kind === 'discontinuity');
    expect(dSteps).toHaveLength(2);
  });
});
