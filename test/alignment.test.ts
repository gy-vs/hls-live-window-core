import { describe, it, expect } from 'vitest';
import {
  HlsWindowTracker,
  getAlignment,
  parseMediaPlaylist,
  renditionId,
} from '../src/index.js';
import { buildMediaPlaylist, SegmentSpec } from './helpers/fixtures.js';

const ORIGIN = 'https://cdn.example.com/live/';
const HIGH = `${ORIGIN}high/index.m3u8`;
const LOW = `${ORIGIN}low/index.m3u8`;
const MID = `${ORIGIN}mid/index.m3u8`;

/**
 * Build renditions with the same MSN layout; optionally put an ad pod
 * (discontinuity block with restarted timestamps) at the same place.
 */
function renditionsWithAd(
  uris: string[],
  opts: {
    firstMsn: number;
    adStart: number; // MSN at which the ad discontinuity begins
    adLength: number;
    total: number;
    omitDiscoOn?: string; // simulate a rendition missing the marker
  },
) {
  const { firstMsn, adStart, adLength, total, omitDiscoOn } = opts;
  return uris.map((uri) => {
    const segments: SegmentSpec[] = [];
    for (let msn = firstMsn; msn < firstMsn + total; msn++) {
      const inAd = msn >= adStart && msn < adStart + adLength;
      segments.push({
        uri: `seg${msn}.ts`,
        durationSec: 2,
        discontinuity:
          msn === adStart && uri !== omitDiscoOn ? true : undefined,
        pdtMs: inAd
          ? Date.parse('2030-01-01T00:00:00.000Z') +
            (msn - adStart) * 2000
          : Date.parse('2026-01-01T00:00:00.000Z') +
            (msn - firstMsn) * 2000,
      });
    }
    return parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        mediaSequence: firstMsn,
        segments,
      }),
      uri,
    );
  });
}

describe('cross-rendition alignment', () => {
  it('reports the common MSN window', () => {
    const t = new HlsWindowTracker();
    const [h, l] = renditionsWithAd([HIGH, LOW], {
      firstMsn: 0,
      adStart: 5,
      adLength: 2,
      total: 8,
    });
    t.ingestMedia(h, 0);
    t.ingestMedia(parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        mediaSequence: 2,
        segments: h.segments.slice(2).map((s) => ({
          uri: s.uri.split('/').pop()!,
          durationSec: s.durationSec,
          discontinuity: s.discontinuity || undefined,
        })),
      }),
      LOW,
    ), 0);
    const alignment = getAlignment(t.getPlayableRanges());
    expect(alignment.commonFirstMsn).toBe(2);
    expect(alignment.commonLastMsn).toBe(7);
  });

  it('marks the shared ad-pod discontinuity as a safe switch point', () => {
    const t = new HlsWindowTracker();
    const [h, l] = renditionsWithAd([HIGH, LOW], {
      firstMsn: 0,
      adStart: 4,
      adLength: 3,
      total: 8,
    });
    t.ingestMedia(h, 0);
    t.ingestMedia(l, 0);
    const alignment = getAlignment(t.getPlayableRanges());
    const discoPoints = alignment.points.filter((p) => p.discontinuity);
    expect(discoPoints.map((p) => p.msn)).toEqual([4]);
    // Without INDEPENDENT-SEGMENTS only the discontinuity point is safe.
    expect(alignment.points.filter((p) => p.safeToSwitch).map((p) => p.msn)).toEqual([4]);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('treats every point as safe under EXT-X-INDEPENDENT-SEGMENTS', () => {
    const t = new HlsWindowTracker();
    const [h, l] = renditionsWithAd([HIGH, LOW], {
      firstMsn: 0,
      adStart: 4,
      adLength: 2,
      total: 6,
    });
    const withIndep = (p: typeof h) =>
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: p.mediaSequence,
          independentSegments: true,
          segments: p.segments.map((s) => ({
            uri: s.uri.split('/').pop()!,
            durationSec: s.durationSec,
            discontinuity: s.discontinuity || undefined,
          })),
        }),
        p.uri,
      );
    t.ingestMedia(withIndep(h), 0);
    t.ingestMedia(withIndep(l), 0);
    const alignment = getAlignment(t.getPlayableRanges());
    expect(alignment.points.every((p) => p.safeToSwitch)).toBe(true);
  });

  it('diagnoses a rendition whose ad marker is at a different MSN', () => {
    const t = new HlsWindowTracker();
    const [h] = renditionsWithAd([HIGH], {
      firstMsn: 0,
      adStart: 4,
      adLength: 2,
      total: 8,
    });
    const [l] = renditionsWithAd([LOW], {
      firstMsn: 0,
      adStart: 4,
      adLength: 2,
      total: 8,
      omitDiscoOn: LOW,
    });
    t.ingestMedia(h, 0);
    t.ingestMedia(l, 0);
    const alignment = getAlignment(t.getPlayableRanges());
    const mismatch = alignment.diagnostics;
    expect(mismatch.length).toBeGreaterThan(0);
    expect(mismatch[0]).toMatchObject({
      rendition: renditionId(LOW),
      msn: 4,
      actualDiscontinuity: false,
      expectedDiscontinuity: true,
    });
    // And the point must not be advertised as a valid switch point.
    expect(
      alignment.points.find((p) => p.msn === 4)!.safeToSwitch,
    ).toBe(false);
  });

  it('returns empty points for a single rendition', () => {
    const t = new HlsWindowTracker();
    const [h] = renditionsWithAd([HIGH], {
      firstMsn: 0,
      adStart: 2,
      adLength: 1,
      total: 4,
    });
    t.ingestMedia(h, 0);
    const alignment = getAlignment(t.getPlayableRanges());
    expect(alignment.points).toEqual([]);
    expect(alignment.renditions).toEqual([renditionId(HIGH)]);
  });

  it('orders diagnostics deterministically and includes three renditions', () => {
    const t = new HlsWindowTracker();
    const [h, m, l] = renditionsWithAd([HIGH, MID, LOW], {
      firstMsn: 0,
      adStart: 3,
      adLength: 1,
      total: 5,
      omitDiscoOn: LOW,
    });
    t.ingestMedia(h, 0);
    t.ingestMedia(m, 0);
    t.ingestMedia(l, 0);
    const alignment = getAlignment(t.getPlayableRanges());
    const msns = alignment.diagnostics.map((d) => d.msn);
    expect([...msns].sort((a, b) => a - b)).toEqual(msns);
  });
});
