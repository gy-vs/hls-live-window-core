import { describe, expect, it } from 'vitest';
import { HlsWindowTracker } from '../src/index.js';
import { buildAdPodPlaylist, buildMediaPlaylist } from './helpers/playlists.js';

const URI = 'http://example.com/live/low.m3u8';

function feed(tracker: HlsWindowTracker, text: string, at: number) {
  tracker.ingest(text, { uri: URI, fetchedAtMs: at });
}

const kinds = (plan: NonNull<ReturnType<HlsWindowTracker['catchUpPlan']>>['steps']) =>
  plan.steps.map((s) => s.kind);

type NonNull<T> = Exclude<T, null>;

describe('catch-up plan', () => {
  it('walks a contiguous window as a single play step to the live edge', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: 0,
        segments: [0, 1, 2, 3, 4].map((msn) => ({ msn, durationSec: 6 }))
      }),
      1000
    );
    const plan = tracker.catchUpPlan()!;
    expect(plan.startsAtMsn).toBe(0);
    expect(kinds(plan)).toEqual(['play', 'wait']);
    const play = plan.steps[0]!;
    expect(play).toMatchObject({ kind: 'play', fromMsn: 0, toMsn: 4, dseq: 0 });
  });

  it('emits discontinuity steps and separate play runs around an ad pod', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      buildAdPodPlaylist({
        mainFrom: 0,
        adStart: 5,
        adEnd: 8,
        to: 12,
        durationSec: 6
      }),
      1000
    );
    const plan = tracker.catchUpPlan({ startsAtMsn: 0 })!;
    const ks = kinds(plan);
    expect(ks).toEqual(['play', 'discontinuity', 'play', 'discontinuity', 'play', 'wait']);

    const plays = plan.steps.filter((s) => s.kind === 'play');
    expect(plays.map((p) => (p as { fromMsn: number; toMsn: number; dseq: number }).dseq)).toEqual([
      0,
      1,
      2
    ]);
    const boundaries = plan.steps.filter((s) => s.kind === 'discontinuity') as {
      msn: number;
      fromDseq: number;
      toDseq: number;
    }[];
    expect(boundaries.map((b) => [b.msn, b.fromDseq, b.toDseq])).toEqual([
      [5, 0, 1],
      [8, 1, 2]
    ]);
  });

  it('fast-forwards to the live edge when the backlog exceeds maxWalkSegments', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: 0,
        segments: Array.from({ length: 20 }, (_, msn) => ({ msn, durationSec: 6 }))
      }),
      1000
    );
    const plan = tracker.catchUpPlan({ startsAtMsn: 0, maxWalkSegments: 5 })!;
    expect(plan.steps[0]).toMatchObject({ kind: 'catch-live-edge' });
    const jump = plan.steps[0] as { targetMsn: number };
    expect(jump.targetMsn).toBe(15);
    const play = plan.steps.find((s) => s.kind === 'play') as {
      fromMsn: number;
      toMsn: number;
    };
    expect(play.fromMsn).toBe(15);
    expect(play.toMsn).toBe(19);
  });

  it('includes a gap step when a sequence jump skipped segments', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: 0,
        segments: [0, 1, 2, 3, 4].map((msn) => ({ msn, durationSec: 6 }))
      }),
      1000
    );
    feed(
      tracker,
      buildMediaPlaylist({
        targetDurationSec: 6,
        mediaSequence: 10,
        segments: [10, 11, 12].map((msn) => ({ msn, durationSec: 6 }))
      }),
      2000
    );
    // Start before the jump so the plan walks into it.
    const plan = tracker.catchUpPlan({ startsAtMsn: 0, nowMs: 2000 })!;
    const gapStep = plan.steps.find((s) => s.kind === 'gap') as {
      gap: { fromMsn: number; toMsn: number };
    };
    expect(gapStep.gap).toMatchObject({ fromMsn: 5, toMsn: 9 });
  });

  it('ends with end-of-play for a closed stream', () => {
    const tracker = new HlsWindowTracker();
    feed(
      tracker,
      buildMediaPlaylist({
        targetDurationSec: 6,
        endList: true,
        segments: [0, 1, 2].map((msn) => ({ msn, durationSec: 6 }))
      }),
      1000
    );
    const plan = tracker.catchUpPlan({ nowMs: 1000 })!;
    expect(plan.steps[plan.steps.length - 1]).toMatchObject({
      kind: 'end-of-play',
      msn: 2
    });
  });
});
