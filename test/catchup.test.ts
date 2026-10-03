import { describe, it, expect } from 'vitest';
import {
  HlsWindowTracker,
  getCatchupPlan,
  parseMediaPlaylist,
  renditionId,
} from '../src/index.js';
import { buildMediaPlaylist, plainSegments, SegmentSpec } from './helpers/fixtures.js';

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

describe('cold start', () => {
  it('starts 3 target durations back from the live edge', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 10), 0);
    const plan = getCatchupPlan(t.getPlayableRanges());
    expect(plan.mode).toBe('cold-start');
    const r = plan.renditions[0]!;
    expect(r.startMsn).toBe(7); // last 9 - 3 + 1
    expect(r.endMsn).toBe(9);
    expect(r.behindSegments).toBe(2);
    expect(r.behindMs).toBe(6000); // segments 7,8,9 from start to edge
  });

  it('starts at the head when the window is shorter than hold-back', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 2), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      holdBackSegments: 3,
    });
    expect(plan.renditions[0]!.startMsn).toBe(0);
  });

  it('reports waiting when a rendition has published nothing yet', () => {
    const t = new HlsWindowTracker();
    const empty = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n',
      HIGH,
    );
    t.ingestMedia(empty, 0);
    const plan = getCatchupPlan(t.getPlayableRanges());
    expect(plan.mode).toBe('waiting');
    expect(plan.renditions[0]!.mode).toBe('waiting');
    expect(plan.nextRefreshAt).not.toBeNull();
  });
});

describe('resume and catching up', () => {
  it('continues directly from the last buffered MSN when contiguous', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 8), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 4, renderedAtMs: null },
      nowMs: 1000,
    });
    const r = plan.renditions[0]!;
    expect(r.startMsn).toBe(5);
    expect(r.missedFromMsn).toBeNull();
    expect(['live', 'behind']).toContain(r.mode);
  });

  it('reports exactly which MSNs were already gone on resume', () => {
    const t = new HlsWindowTracker();
    // Player buffered through 3; window has slid to 6..13.
    t.ingestMedia(media(HIGH, 6, 8), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 3, renderedAtMs: null },
    });
    const r = plan.renditions[0]!;
    expect(r.missedFromMsn).toBe(4);
    expect(r.missedToMsn).toBe(5);
    expect(r.startMsn).toBe(6);
    expect(r.mode).toBe('catching-up');
  });

  it('reports live when close to the edge and catching-up when far', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 12), 0);
    const close = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 8, renderedAtMs: null },
    });
    expect(close.renditions[0]!.mode).toBe('live'); // 3 behind = holdBack

    const far = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 2, renderedAtMs: null },
    });
    expect(far.renditions[0]!.mode).toBe('catching-up'); // 9 behind
  });

  it('reports waiting when caught up with no new segment yet', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 5), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 4, renderedAtMs: null },
    });
    expect(plan.renditions[0]!.mode).toBe('waiting');
    expect(plan.renditions[0]!.startMsn).toBe(5);
    expect(plan.renditions[0]!.safeStartMsn).toBeNull();
  });

  it('reports ended when the playlist carries ENDLIST and player is at tail', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 5, { endlist: true }), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      position: { lastBufferedMsn: 4, renderedAtMs: null },
    });
    expect(plan.renditions[0]!.mode).toBe('ended');
    expect(plan.nextRefreshAt).toBeNull();
  });
});

describe('safe start and discontinuities', () => {
  it('moves the start forward to the next discontinuity when not independent', () => {
    const segments: SegmentSpec[] = [];
    for (let msn = 0; msn < 8; msn++) {
      segments.push({
        uri: `seg${msn}.ts`,
        durationSec: 2,
        discontinuity: msn === 5 || undefined,
      });
    }
    const t = new HlsWindowTracker();
    t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({ targetDuration: 2, mediaSequence: 0, segments }),
        HIGH,
      ),
      0,
    );
    const plan = getCatchupPlan(t.getPlayableRanges());
    const r = plan.renditions[0]!;
    // Cold start wants 5, which itself is the discontinuity.
    expect(r.startMsn).toBe(5);
    expect(r.safeStartMsn).toBe(5);
  });

  it('uses INDEPENDENT-SEGMENTS so every start is safe', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 10, { independentSegments: true }), 0);
    const plan = getCatchupPlan(t.getPlayableRanges());
    const r = plan.renditions[0]!;
    expect(r.safeStartMsn).toBe(r.startMsn);
  });
});

describe('multi-rendition catch-up', () => {
  it('produces a per-rendition plan sorted by id with shared refresh time', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 8, { independentSegments: true }), 0);
    t.ingestMedia(media(LOW, 2, 6, { independentSegments: true }), 0);
    const plan = getCatchupPlan(t.getPlayableRanges(), {
      primaryRendition: renditionId(LOW),
      nowMs: 0,
    });
    expect(plan.renditions.map((p) => p.rendition)).toEqual([
      renditionId(HIGH),
      renditionId(LOW),
    ]);
    expect(plan.primaryRendition).toBe(renditionId(LOW));
    expect(plan.safeAlignmentPoints.length).toBeGreaterThan(0);
    expect(plan.nextRefreshAt).toBe(2000);
  });
});
