import { describe, expect, it } from 'vitest';
import { HlsWindowTracker } from '../src/index.js';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  segmentRun
} from './helpers/playlists.js';

const URI = {
  master: 'http://example.com/live/master.m3u8',
  low: 'http://example.com/live/low.m3u8',
  high: 'http://example.com/live/high.m3u8'
};

function feed(
  tracker: HlsWindowTracker,
  uri: string,
  text: string,
  fetchedAtMs: number
) {
  return tracker.ingest(text, { uri, fetchedAtMs });
}

function window(segments: { msn: number; durationSec?: number }[], targetDurationSec = 6, extra: Parameters<typeof buildMediaPlaylist>[0] = {}) {
  return buildMediaPlaylist({
    targetDurationSec,
    mediaSequence: segments[0]?.msn ?? 0,
    segments: segments.map((s) => ({ msn: s.msn, durationSec: s.durationSec ?? 6 })),
    ...extra
  });
}

describe('merging: sliding window', () => {
  it('grows the merged window across overlapping reloads', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window(segmentRun(0, 5).map((s) => ({ msn: s.msn }))), 1000);
    feed(tracker, URI.low, window([3, 4, 5, 6, 7].map((msn) => ({ msn }))), 2000);
    const report = tracker.playable();
    const r = report.renditions.find((x) => x.uri === URI.low)!;
    expect(r.windowTailMsn).toBe(3);
    expect(r.windowHeadMsn).toBe(7);
    expect(r.playable).toEqual([{ fromMsn: 3, toMsn: 7, dseq: 0 }]);
    expect(r.status).toBe('live');
  });

  it('reports window-slide info when the tail advances normally', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn }))), 1000);
    const res = feed(tracker, URI.low, window([3, 4, 5, 6, 7].map((msn) => ({ msn }))), 2000);
    const codes = res.diagnostics.map((d) => d.code);
    expect(codes).toContain('window-slide');
    expect(codes).not.toContain('sequence-jump');
  });

  it('confirms a gap when a reload jumps over sequence numbers', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn }))), 1000);
    const res = feed(tracker, URI.low, window([10, 11, 12].map((msn) => ({ msn }))), 2000);
    expect(res.diagnostics.map((d) => d.code)).toContain('sequence-jump');
    const jump = res.diagnostics.find((d) => d.code === 'sequence-jump')!;
    expect(jump.playlistUri).toBe(URI.low);
    expect(jump.msn).toBe(10);

    const report = tracker.playable();
    const r = report.renditions.find((x) => x.uri === URI.low)!;
    expect(r.playable.map((p) => [p.fromMsn, p.toMsn])).toEqual([[10, 12]]);
    expect(r.gaps[0]!).toMatchObject({ fromMsn: 5, toMsn: 9, reason: 'sequence-jump' });
  });

  it('records confirmed gaps for segments a sequence jump skipped', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn }))), 1000);
    feed(tracker, URI.low, window([10, 11, 12].map((msn) => ({ msn }))), 2000);
    const r = tracker.playable().renditions.find((x) => x.uri === URI.low)!;
    // Playable now is 10..12 (window head/tail moved).
    expect(r.playable.map((p) => [p.fromMsn, p.toMsn])).toEqual([[10, 12]]);
    // But the skipped 5..9 are recorded as a confirmed gap.
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!).toMatchObject({
      playlistUri: URI.low,
      fromMsn: 5,
      toMsn: 9,
      reason: 'sequence-jump',
      severity: 'error'
    });
  });
});

describe('merging: out-of-order delivery', () => {
  it('rejects an older playlist arriving late; window never retreats', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn }))), 1000);
    feed(tracker, URI.low, window([3, 4, 5, 6, 7].map((msn) => ({ msn }))), 2000);
    // Late arrival of the first snapshot.
    const late = feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn }))), 3000);
    expect(late.accepted).toBe(false);
    expect(late.diagnostics.map((d) => d.code)).toContain('stale-playlist');

    const r = tracker.playable().renditions.find((x) => x.uri === URI.low)!;
    expect(r.windowTailMsn).toBe(3);
    expect(r.windowHeadMsn).toBe(7);
  });

  it('accepts an identical re-delivery as unchanged (for backoff)', () => {
    const tracker = new HlsWindowTracker();
    const text = window([0, 1, 2, 3, 4].map((msn) => ({ msn })));
    feed(tracker, URI.low, text, 1000);
    const again = feed(tracker, URI.low, text, 2000);
    expect(again.accepted).toBe(true);
    expect(again.changed).toBe(false);
    const third = feed(tracker, URI.low, text, 3000);
    expect(third.changed).toBe(false);
  });
});

describe('merging: content identity', () => {
  it('flags the same msn with a different byte range as a conflict', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      URI.low,
      buildMediaPlaylist({
        targetDurationSec: 6,
        segments: [
          { msn: 0, durationSec: 6 },
          { msn: 1, durationSec: 6, byteRange: { length: 100, start: 1000 } },
          { msn: 2, durationSec: 6 }
        ]
      }),
      1000
    );
    const res = feed(
      tracker,
      URI.low,
      buildMediaPlaylist({
        targetDurationSec: 6,
        segments: [
          { msn: 0, durationSec: 6 },
          { msn: 1, durationSec: 6, byteRange: { length: 100, start: 5000 } },
          { msn: 2, durationSec: 6 },
          { msn: 3, durationSec: 6 }
        ]
      }),
      2000
    );
    const conflict = res.diagnostics.find((d) => d.code === 'same-msn-conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.msn).toBe(1);
    expect(conflict!.playlistUri).toBe(URI.low);
  });

  it('flags the same msn with a different encryption key as a conflict', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      URI.low,
      buildMediaPlaylist({
        targetDurationSec: 6,
        segments: [
          { msn: 0, durationSec: 6, key: { method: 'AES-128', uri: 'k.bin', ivHex: '01' } },
          { msn: 1, durationSec: 6 }
        ]
      }),
      1000
    );
    const res = feed(
      tracker,
      URI.low,
      buildMediaPlaylist({
        targetDurationSec: 6,
        segments: [
          { msn: 0, durationSec: 6, key: { method: 'AES-128', uri: 'k.bin', ivHex: '02' } },
          { msn: 1, durationSec: 6 },
          { msn: 2, durationSec: 6 }
        ]
      }),
      2000
    );
    expect(res.diagnostics.map((d) => d.code)).toContain('same-msn-conflict');
  });

  it('does not flag identity when key/byte-range are equal', () => {
    const tracker = new HlsWindowTracker();
    const make = () =>
      buildMediaPlaylist({
        targetDurationSec: 6,
        segments: [
          { msn: 0, durationSec: 6, key: { method: 'AES-128', uri: 'k.bin' } },
          { msn: 1, durationSec: 6, byteRange: { length: 9, start: 9 } },
          { msn: 2, durationSec: 6 }
        ]
      });
    feed(tracker, URI.low, make(), 1000);
    const res = feed(tracker, URI.low, make(), 2000);
    expect(res.diagnostics.map((d) => d.code)).not.toContain('same-msn-conflict');
  });
});

describe('merging: EVENT / VOD / ended', () => {
  it('EVENT windows only grow at the head', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2].map((msn) => ({ msn })), 6, { type: 'event' }), 1000);
    feed(tracker, URI.low, window([0, 1, 2, 3, 4].map((msn) => ({ msn })), 6, { type: 'event' }), 2000);
    const r = tracker.playable().renditions.find((x) => x.uri === URI.low)!;
    expect(r.windowTailMsn).toBe(0);
    expect(r.windowHeadMsn).toBe(4);
    expect(r.status).toBe('event');
  });

  it('diagnoses an EVENT playlist whose tail advanced', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2].map((msn) => ({ msn })), 6, { type: 'event' }), 1000);
    const res = feed(tracker, URI.low, window([1, 2, 3].map((msn) => ({ msn })), 6, { type: 'event' }), 2000);
    expect(res.diagnostics.map((d) => d.code)).toContain('event-window-shrank');
  });

  it('marks a live stream ended when ENDLIST arrives and stops scheduling', () => {
    const tracker = new HlsWindowTracker();
    feed(tracker, URI.low, window([0, 1, 2].map((msn) => ({ msn }))), 1000);
    feed(
      tracker,
      URI.low,
      window([0, 1, 2, 3].map((msn) => ({ msn })), 6, { endList: true }),
      2000
    );
    const r = tracker.playable().renditions.find((x) => x.uri === URI.low)!;
    expect(r.status).toBe('ended');
    const refresh = tracker.refreshPlans(2000);
    const plan = refresh.renditions.find((x) => x.uri === URI.low)!;
    expect(plan.nextFetchMs).toBeNull();
  });

  it('never re-schedules a VOD playlist', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      URI.low,
      window([0, 1, 2].map((msn) => ({ msn })), 6, { type: 'vod', endList: true }),
      1000
    );
    const again = feed(
      tracker,
      URI.low,
      window([0, 1, 2].map((msn) => ({ msn })), 6, { type: 'vod', endList: true }),
      2000
    );
    expect(again.accepted).toBe(false);
    const plan = tracker.refreshPlans(2000).renditions.find((x) => x.uri === URI.low)!;
    expect(plan.status).toBe('vod');
    expect(plan.nextFetchMs).toBeNull();
  });
});

describe('master + multiple renditions', () => {
  it('registers renditions from the master and ties media playlists to them', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      URI.master,
      buildMasterPlaylist({
        variants: [
          { uri: 'low.m3u8', bandwidth: 100_000 },
          { uri: 'high.m3u8', bandwidth: 500_000 }
        ]
      }),
      0
    );
    feed(tracker, URI.low, window([0, 1, 2].map((msn) => ({ msn }))), 1000);
    feed(tracker, URI.high, window([0, 1, 2].map((msn) => ({ msn }))), 1000);
    const report = tracker.playable();
    const ids = report.renditions.map((r) => r.renditionId).sort();
    expect(ids).toEqual(['v0', 'v1']);
  });

  it('warns when a rendition URI disappears from a newer master', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      URI.master,
      buildMasterPlaylist({ variants: [{ uri: 'low.m3u8', bandwidth: 1 }, { uri: 'high.m3u8', bandwidth: 2 }] }),
      0
    );
    const res = feed(
      tracker,
      URI.master,
      buildMasterPlaylist({ variants: [{ uri: 'low.m3u8', bandwidth: 1 }] }),
      1000
    );
    expect(res.diagnostics.map((d) => d.code)).toContain('master-variant-uri-changed');
  });
});
