import { describe, it, expect } from 'vitest';
import {
  HlsWindowTracker,
  getAlignment,
  getCatchupPlan,
  parseMasterPlaylist,
  parseMediaPlaylist,
  planRefreshAll,
} from '../src/index.js';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  plainSegments,
  SegmentSpec,
} from './helpers/fixtures.js';

const ORIGIN = 'https://cdn.example.com/live/';
const HIGH = `${ORIGIN}high/index.m3u8`;
const LOW = `${ORIGIN}low/index.m3u8`;

function media(
  uri: string,
  firstMsn: number,
  count: number,
  extra: Parameters<typeof buildMediaPlaylist>[0] = {},
) {
  return parseMediaPlaylist(
    buildMediaPlaylist({
      targetDuration: 2,
      mediaSequence: firstMsn,
      segments: plainSegments(count, firstMsn),
      ...extra,
    }),
    uri,
  );
}

/** One complete, representative feed sequence. */
function feedScenario(shuffle: boolean) {
  const master = parseMasterPlaylist(
    buildMasterPlaylist([
      { uri: 'high/index.m3u8', bandwidth: 2000 },
      { uri: 'low/index.m3u8', bandwidth: 400 },
    ]),
    `${ORIGIN}index.m3u8`,
  );

  // (playlist, fetchedAt) pairs; with shuffle=true the late duplicates are
  // delivered out of order to simulate network jitter.
  const steps: Array<() => void> = [];
  const t = new HlsWindowTracker();
  steps.push(() => t.ingestMaster(master));
  steps.push(() => t.ingestMedia(media(HIGH, 0, 4), 0));
  steps.push(() => t.ingestMedia(media(LOW, 0, 4), 0));
  steps.push(() => t.ingestMedia(media(HIGH, 0, 5), 2000));
  steps.push(() => t.ingestMedia(media(HIGH, 0, 4), 9000)); // stale, late
  steps.push(() => t.ingestMedia(media(LOW, 0, 5), 2000));
  steps.push(() => t.ingestMedia(media(HIGH, 2, 4), 4000)); // slide
  steps.push(() => t.ingestMedia(media(LOW, 2, 4), 4000));
  steps.push(() => t.ingestMedia(media(LOW, 0, 4), 11_000)); // stale, late
  steps.push(() => t.ingestMedia(media(HIGH, 2, 5), 6000));
  steps.push(() => t.ingestMedia(media(LOW, 2, 5), 6000));
  steps.push(() => t.ingestMedia(media(HIGH, 2, 5, { endlist: true }), 8000));
  steps.push(() => t.ingestMedia(media(LOW, 2, 5, { endlist: true }), 8000));

  const order = steps.map((_, i) => i);
  if (shuffle) {
    // Deterministic permutation (not Math.random): swap stale deliveries
    // past the later ones while keeping each rendition well-formed.
    [order[3], order[4]] = [order[4]!, order[3]!];
    [order[7], order[8]] = [order[8]!, order[7]!];
  }
  for (const i of order) steps[i]!();
  return t;
}

function snapshot(t: HlsWindowTracker) {
  return {
    ids: t.getRenditionIds(),
    ranges: t.getPlayableRanges().map((r) => ({
      id: r.id,
      first: r.firstMsn,
      last: r.lastMsn,
      ended: r.ended,
      mode: r.mode,
      streak: r.unchangedStreak,
    })),
    diagnostics: t.getDiagnostics().map((d) => ({ ...d })),
    alignment: getAlignment(t.getPlayableRanges()),
    refresh: planRefreshAll(t.getPlayableRanges()),
    catchup: getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 2, renderedAtMs: null },
      nowMs: 9000,
    }),
  };
}

describe('determinism', () => {
  it('yields identical results for identical feeds across runs', () => {
    const a = snapshot(feedScenario(false));
    const b = snapshot(feedScenario(false));
    expect(a).toEqual(b);
  });

  it('reaches the same final state when stale playlists arrive out of order', () => {
    const inOrder = snapshot(feedScenario(false));
    const shuffled = snapshot(feedScenario(true));
    expect(shuffled.ids).toEqual(inOrder.ids);
    expect(shuffled.ranges).toEqual(inOrder.ranges);
    // Gap/diagnostic content is identical; ordering stays stable.
    expect(
      shuffled.diagnostics.map((d) => `${d.code}:${d.rendition}`),
    ).toEqual(
      inOrder.diagnostics.map((d) => `${d.code}:${d.rendition}`),
    );
    expect(shuffled.alignment.points.map((p) => p.msn)).toEqual(
      inOrder.alignment.points.map((p) => p.msn),
    );
    expect(shuffled.refresh.nextRefreshAt).toEqual(
      inOrder.refresh.nextRefreshAt,
    );
    expect(shuffled.catchup.mode).toBe(inOrder.catchup.mode);
  });

  it('does not depend on absolute fetch timestamps, only their sequence', () => {
    const run = (offset: number) => {
      const t = new HlsWindowTracker();
      t.ingestMedia(media(HIGH, 0, 3), offset);
      t.ingestMedia(media(HIGH, 0, 4), offset + 2000);
      t.ingestMedia(media(HIGH, 1, 4), offset + 4000);
      return {
        range: [
          t.getPlayableRanges()[0]!.firstMsn,
          t.getPlayableRanges()[0]!.lastMsn,
        ],
        diagnostics: t.getDiagnostics().map((d) => d.code),
      };
    };
    expect(run(0)).toEqual(run(12_345_678));
  });

  it('sorts every output collection by a stable key', () => {
    const t = feedScenario(false);
    const ids = t.getRenditionIds();
    expect([...ids].sort()).toEqual(ids);
    const missing = t.getMissingSegments();
    const sorted = [...missing].sort((a, b) =>
      a.rendition === b.rendition
        ? a.fromMsn - b.fromMsn
        : a.rendition < b.rendition
          ? -1
          : 1,
    );
    expect(missing).toEqual(sorted);
  });
});

describe('ad pod end-to-end scenario', () => {
  /**
   * Live content runs MSN 0..3, an ad pod occupies MSN 4..5 (with a
   * discontinuity and restarted PDT), content resumes at MSN 6. Both
   * renditions must agree; the player must be able to switch at the pod
   * boundary and must not be told to poll aggressively afterwards.
   */
  function playlist(uri: string, firstMsn: number) {
    const segments: SegmentSpec[] = [];
    for (let msn = 0; msn < 10; msn++) {
      const inAd = msn >= 4 && msn <= 5;
      segments.push({
        uri: `${inAd ? 'ad' : 'content'}-${msn}.ts`,
        durationSec: 2,
        discontinuity: msn === 4 || msn === 6 ? true : undefined,
        pdtMs: inAd
          ? Date.parse('2030-01-01T00:00:00.000Z') + (msn - 4) * 2000
          : Date.parse('2026-01-01T00:00:00.000Z') + msn * 2000,
      });
    }
    return parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        mediaSequence: firstMsn,
        segments: segments.slice(firstMsn),
      }),
      uri,
    );
  }

  it('keeps window, alignment and refresh sane around the discontinuity', () => {
    const t = new HlsWindowTracker();
    t.ingestMaster(
      parseMasterPlaylist(
        buildMasterPlaylist([
          { uri: 'high/index.m3u8', bandwidth: 2000 },
          { uri: 'low/index.m3u8', bandwidth: 400 },
        ]),
        `${ORIGIN}index.m3u8`,
      ),
    );
    // Before the ad.
    t.ingestMedia(playlist(HIGH, 0), 0);
    t.ingestMedia(playlist(LOW, 0), 0);
    // Window slides and the ad pod enters.
    t.ingestMedia(playlist(HIGH, 2), 4000);
    t.ingestMedia(playlist(LOW, 2), 4000);

    const ranges = t.getPlayableRanges();
    for (const r of ranges) {
      expect([r.firstMsn, r.lastMsn]).toEqual([2, 9]);
    }

    const alignment = getAlignment(ranges);
    expect(alignment.diagnostics).toEqual([]);
    const boundaries = alignment.points
      .filter((p) => p.discontinuity)
      .map((p) => p.msn);
    expect(boundaries).toEqual([4, 6]);
    // Safe switches: the two pod boundaries only.
    expect(
      alignment.points.filter((p) => p.safeToSwitch).map((p) => p.msn),
    ).toEqual([4, 6]);
    // PDT restarted inside the pod but stayed aligned.
    const ad = alignment.points.find((p) => p.msn === 4)!;
    const pdts = Object.values(ad.programDateTimes);
    expect(pdts[0]).toBe(pdts[1]);

    // Refresh stays paced by target duration, not aggressive.
    const refresh = planRefreshAll(ranges);
    expect(refresh.nextRefreshAt).toBe(6000); // 4000 fetched + 2000
  });

  it('does not misreport gaps when the window slides at the ad boundary', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(playlist(HIGH, 0), 0);
    t.ingestMedia(playlist(LOW, 0), 0);
    t.ingestMedia(playlist(HIGH, 2), 4000);
    t.ingestMedia(playlist(LOW, 2), 4000);
    // Pure slide: 2,3 dropped one at a time sequence; no holes.
    expect(t.getMissingSegments()).toEqual([]);
    // Discontinuity sequence headers still agree with observed markers.
    expect(
      t.getDiagnostics().filter(
        (d) => d.code === 'discontinuity-sequence-mismatch',
      ),
    ).toEqual([]);
  });
});
