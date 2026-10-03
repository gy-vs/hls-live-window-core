import { describe, expect, it } from 'vitest';
import { HlsWindowTracker } from '../src/index.js';
import { buildMediaPlaylist } from './helpers/playlists.js';

const URI = 'http://example.com/live/low.m3u8';

function feed(tracker: HlsWindowTracker, text: string, at: number) {
  return tracker.ingest(text, { uri: URI, fetchedAtMs: at });
}

const pl = (msns: number[], opts: { endList?: boolean; type?: 'live' | 'event' | 'vod' } = {}) =>
  buildMediaPlaylist({
    targetDurationSec: 6,
    mediaSequence: msns[0],
    type: opts.type,
    endList: opts.endList,
    segments: msns.map((msn) => ({ msn, durationSec: 6 }))
  });

describe('refresh scheduling', () => {
  it('schedules a live reload about one target duration out (no PDT)', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, pl([0, 1, 2, 3, 4]), 10_000);
    const plan = tracker.refreshPlans(10_000);
    const r = plan.renditions[0]!;
    expect(r.status).toBe('live');
    // 6s target +/- deterministic 5% jitter
    expect(r.delayMs).toBeGreaterThanOrEqual(6000 - 300);
    expect(r.delayMs).toBeLessThanOrEqual(6000 + 300);
    expect(plan.nextFetchMs).toBe(r.nextFetchMs);
  });

  it('backs off exponentially (capped) while playlists stay unchanged', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, pl([0, 1, 2, 3, 4]), 10_000);
    const delays: number[] = [];
    for (let t = 16_000; t <= 16_000 + 18_000; t += 6000) {
      feed(tracker, pl([0, 1, 2, 3, 4]), t);
      delays.push(tracker.refreshPlans(t).renditions[0]!.delayMs!);
    }
    // Multipliers 1.5, 3, 3, ... (capped at 3x target).
    expect(delays[0]).toBeGreaterThanOrEqual(9000 - 450);
    expect(delays[1]).toBeGreaterThanOrEqual(18_000 - 900);
    expect(delays[2]).toBeLessThanOrEqual(18_000 + 900);
    // Never busy-loops: minimum sensible delay always >= 8.5s here.
    for (const d of delays) expect(d).toBeGreaterThan(8000);
  });

  it('uses segment age from PDT to schedule close to the next boundary', () => {
    const tracker = new HlsWindowTracker();
    const now = 100_000;
    // Last segment ends 2s after "now".
    const text = buildMediaPlaylist({
      targetDurationSec: 6,
      segments: [
        { msn: 0, durationSec: 6, pdtMs: now - 28_000 },
        { msn: 1, durationSec: 6 },
        { msn: 2, durationSec: 6 },
        { msn: 3, durationSec: 6 },
        { msn: 4, durationSec: 6 }
      ]
    });
    feed(tracker, text, now);
    const r = tracker.refreshPlans(now).renditions[0]!;
    // Last segment pdtEnd = now+2000 -> wait ~2s, not a full 6s.
    expect(r.delayMs).toBeGreaterThanOrEqual(2000 - 200);
    expect(r.delayMs).toBeLessThanOrEqual(2000 + 200);
  });

  it('does not schedule ended or VOD renditions', () => {
    const ended = new HlsWindowTracker();
    feed(ended, pl([0, 1, 2], { endList: true }), 1000);
    expect(ended.refreshPlans(1000).renditions[0]!.nextFetchMs).toBeNull();

    const vod = new HlsWindowTracker();
    feed(vod, pl([0, 1, 2], { type: 'vod', endList: true }), 1000);
    expect(vod.refreshPlans(1000).renditions[0]!.status).toBe('vod');
    expect(vod.refreshPlans(1000).nextFetchMs).toBeNull();
  });

  it('ad-discontinuity era still yields a normal refresh cadence', () => {
    const tracker = new HlsWindowTracker();
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      ...Array.from({ length: 13 }, (_, msn) => {
        const lines: string[] = [];
        if (msn === 5 || msn === 8) lines.push('#EXT-X-DISCONTINUITY');
        lines.push(`#EXTINF:6,`, `seg-${msn}.ts`);
        return lines;
      }).flat(),
      ''
    ].join('\n');
    feed(tracker, text, 10_000);
    const r = tracker.refreshPlans(10_000).renditions[0]!;
    expect(r.delayMs).toBeGreaterThanOrEqual(6000 - 300);
    expect(r.delayMs).toBeLessThanOrEqual(6000 + 300);
  });
});
