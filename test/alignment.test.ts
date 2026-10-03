import { describe, expect, it } from 'vitest';
import { HlsWindowTracker } from '../src/index.js';
import {
  buildAdPodPlaylist,
  buildMasterPlaylist,
  buildMediaPlaylist
} from './helpers/playlists.js';

const URI = {
  master: 'http://example.com/live/master.m3u8',
  low: 'http://example.com/live/low.m3u8',
  high: 'http://example.com/live/high.m3u8'
};

function feedMaster(tracker: HlsWindowTracker) {
  tracker.ingest(
    buildMasterPlaylist({
      variants: [
        { uri: 'low.m3u8', bandwidth: 100_000 },
        { uri: 'high.m3u8', bandwidth: 500_000 }
      ]
    }),
    { uri: URI.master, fetchedAtMs: 0 }
  );
}

describe('alignment: uniform renditions', () => {
  it('matches the same msn across renditions in sequence mode', () => {
    const tracker = new HlsWindowTracker();
    feedMaster(tracker);
    const make = (head: number) =>
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: Math.max(0, head - 4),
        segments: Array.from({ length: 5 }, (_, i) => ({
          msn: Math.max(0, head - 4) + i,
          durationSec: 6
        }))
      });
    tracker.ingest(make(7), { uri: URI.low, fetchedAtMs: 1000 });
    tracker.ingest(make(7), { uri: URI.high, fetchedAtMs: 1000 });

    const report = tracker.alignment();
    expect(report.referenceRenditionId).toBe('v0');
    expect(report.eras).toHaveLength(1);
    const era = report.eras[0]!;
    expect(era.dseq).toBe(0);
    expect(era.mode).toBe('sequence');
    expect(era.points.length).toBeGreaterThan(0);
    for (const p of era.points) {
      expect(p.at.v0).toBe(p.at.v1);
    }
  });

  it('aligns by PDT when timestamps exist even with different local sequence numbers', () => {
    const tracker = new HlsWindowTracker();
    feedMaster(tracker);
    const base = Date.UTC(2025, 5, 1, 12, 0, 0);
    // Low starts at msn 100, high at msn 200, same wall clock and durations.
    const segs = (startMsn: number) =>
      Array.from({ length: 4 }, (_, i) => ({
        msn: startMsn + i,
        durationSec: 6,
        pdtMs: i === 0 ? base : undefined
      }));
    tracker.ingest(
      buildMediaPlaylist({ targetDurationSec: 6, mediaSequence: 100, segments: segs(100) }),
      { uri: URI.low, fetchedAtMs: 1000 }
    );
    tracker.ingest(
      buildMediaPlaylist({ targetDurationSec: 6, mediaSequence: 200, segments: segs(200) }),
      { uri: URI.high, fetchedAtMs: 1000 }
    );
    const era = tracker.alignment().eras[0]!;
    expect(era.mode).toBe('pdt');
    const first = era.points[0]!;
    expect(first.at.v0).toBe(100);
    expect(first.at.v1).toBe(200);
    expect(first.pdtMs).toBe(base);
  });
});

describe('alignment: discontinuity / ad pod', () => {
  it('splits eras at the ad boundaries and does not align ad with main content', () => {
    const tracker = new HlsWindowTracker();
    feedMaster(tracker);
    // Both renditions carry identical structure: main(0..4) ad(5..7) main(8..12)
    const text = buildAdPodPlaylist({
      mainFrom: 0,
      adStart: 5,
      adEnd: 8,
      to: 12,
      durationSec: 6
    });
    tracker.ingest(text, { uri: URI.low, fetchedAtMs: 1000 });
    tracker.ingest(text, { uri: URI.high, fetchedAtMs: 1000 });

    const report = tracker.alignment();
    expect(report.eras.map((e) => e.dseq)).toEqual([0, 1, 2]);

    const adEra = report.eras.find((e) => e.dseq === 1)!;
    const mainBefore = report.eras.find((e) => e.dseq === 0)!;
    const mainAfter = report.eras.find((e) => e.dseq === 2)!;

    // Inside each era, renditions still map 1:1.
    for (const era of [mainBefore, adEra, mainAfter]) {
      for (const p of era.points) expect(p.at.v0).toBe(p.at.v1);
    }
    // The ad era covers only ad msns.
    expect(adEra.commonPlayable.v0).toEqual({ fromMsn: 5, toMsn: 7 });
    expect(mainAfter.commonPlayable.v0).toEqual({ fromMsn: 8, toMsn: 12 });
    // Ad start is a discontinuity boundary in both renditions.
    const adStartPoint = adEra.points[0]!;
    expect(adStartPoint.discontinuityBoundary).toBe(true);
  });

  it('keeps eras independent when an ad exists in only one rendition at first', () => {
    const tracker = new HlsWindowTracker();
    feedMaster(tracker);
    const withAd = buildAdPodPlaylist({
      mainFrom: 0,
      adStart: 5,
      adEnd: 8,
      to: 12,
      durationSec: 6
    });
    const noAd = buildMediaPlaylist({
      targetDurationSec: 6,
      mediaSequence: 0,
      segments: Array.from({ length: 13 }, (_, msn) => ({ msn, durationSec: 6 }))
    });
    tracker.ingest(withAd, { uri: URI.low, fetchedAtMs: 1000 });
    tracker.ingest(noAd, { uri: URI.high, fetchedAtMs: 1000 });

    const report = tracker.alignment();
    // Reference (v0) has 3 eras.
    expect(report.eras.map((e) => e.dseq)).toEqual([0, 1, 2]);
    // The ad era only matches renditions that actually have dseq 1 content;
    // v1 has none, so it contributes no alignment points there.
    const adEra = report.eras.find((e) => e.dseq === 1)!;
    expect(adEra.points).toEqual([]);
  });

  it('still aligns populated renditions when a master variant has no media ingested yet', () => {
    const tracker = new HlsWindowTracker();
    feedMaster(tracker); // registers v0 and v1
    tracker.ingest(
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: 0,
        segments: [0, 1, 2].map((msn) => ({ msn, durationSec: 6 }))
      }),
      { uri: URI.low, fetchedAtMs: 1000 }
    );
    // v1 never ingested.
    const report = tracker.alignment();
    expect(report.eras).toHaveLength(1);
    expect(report.eras[0]!.points.length).toBeGreaterThan(0);
    for (const p of report.eras[0]!.points) expect(p.at.v0).toBeDefined();
  });
});

