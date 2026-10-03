import { describe, it, expect } from 'vitest';
import {
  HlsWindowTracker,
  planRefresh,
  planRefreshAll,
  unchangedReloadMultiplier,
  parseMediaPlaylist,
  renditionId,
} from '../src/index.js';
import { buildMediaPlaylist, plainSegments } from './helpers/fixtures.js';

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
      targetDuration: 6,
      mediaSequence: firstMsn,
      segments: plainSegments(count, firstMsn, { durationSec: 6 }),
      ...extra,
    }),
    uri,
  );
}

describe('unchanged reload multiplier', () => {
  it('is 1x for the first two polls then 1.5x then caps at 2x', () => {
    expect(unchangedReloadMultiplier(0)).toBe(1);
    expect(unchangedReloadMultiplier(1)).toBe(1);
    expect(unchangedReloadMultiplier(2)).toBe(1.5);
    expect(unchangedReloadMultiplier(3)).toBe(2);
    expect(unchangedReloadMultiplier(99)).toBe(2);
  });
});

describe('refresh planning per rendition', () => {
  it('schedules the first reload one target duration after fetch', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 10_000);
    const plan = planRefresh(t.getRendition(renditionId(HIGH))!);
    expect(plan.intervalMs).toBe(6000);
    expect(plan.nextRefreshAt).toBe(16_000);
  });

  it('backs off while the playlist keeps coming back unchanged', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(HIGH, 0, 3), 6000);
    expect(planRefresh(t.getPlayableRanges()[0]!).intervalMs).toBe(6000);
    t.ingestMedia(media(HIGH, 0, 3), 12_000);
    expect(planRefresh(t.getPlayableRanges()[0]!).intervalMs).toBe(9000);
    t.ingestMedia(media(HIGH, 0, 3), 21_000);
    expect(planRefresh(t.getPlayableRanges()[0]!).intervalMs).toBe(12_000);
    // Cap holds.
    t.ingestMedia(media(HIGH, 0, 3), 33_000);
    expect(planRefresh(t.getPlayableRanges()[0]!).intervalMs).toBe(12_000);
  });

  it('resets backoff as soon as new media appears', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(HIGH, 0, 3), 6000);
    t.ingestMedia(media(HIGH, 0, 3), 12_000);
    expect(t.getPlayableRanges()[0]!.unchangedStreak).toBe(2);
    t.ingestMedia(media(HIGH, 0, 4), 21_000);
    expect(t.getPlayableRanges()[0]!.unchangedStreak).toBe(0);
    expect(planRefresh(t.getPlayableRanges()[0]!).intervalMs).toBe(6000);
  });

  it('never refreshes a VOD or ended playlist', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(
      media(HIGH, 0, 3, { playlistType: 'VOD', endlist: true }),
      0,
    );
    const plan = planRefresh(t.getPlayableRanges()[0]!);
    expect(plan.nextRefreshAt).toBeNull();
    expect(plan.ended).toBe(true);
  });

  it('stops refreshing a live stream once ENDLIST arrives', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 6), 0);
    t.ingestMedia(media(HIGH, 0, 6, { endlist: true }), 6000);
    expect(planRefresh(t.getPlayableRanges()[0]!).nextRefreshAt).toBeNull();
  });

  it('allows immediate poll when CAN-BLOCK-RELOAD is supported', () => {
    const t = new HlsWindowTracker();
    const p = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 1,
        serverControl: { 'CAN-BLOCK-RELOAD': 'YES' },
        segments: plainSegments(2, 0, { durationSec: 1 }),
      }),
      HIGH,
    );
    t.ingestMedia(p, 5_000);
    const view = t.getPlayableRanges()[0]!;
    expect(planRefresh(view, true).intervalMs).toBe(0);
    expect(planRefresh(view, true).nextRefreshAt).toBe(5_000);
    // Explicit opt-off paces normally.
    expect(planRefresh(view, false).intervalMs).toBe(1000);
  });
});

describe('refresh planning across renditions', () => {
  it('returns the earliest refresh and sorts renditions by id', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 10_000);
    t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          segments: plainSegments(3, 0, { durationSec: 2 }),
        }),
        LOW,
      ),
      10_000,
    );
    const schedule = planRefreshAll(t.getPlayableRanges());
    expect(schedule.renditions.map((p) => p.rendition)).toEqual([
      renditionId(HIGH),
      renditionId(LOW),
    ]);
    // Earliest: LOW with 2s target duration.
    expect(schedule.nextRefreshAt).toBe(12_000);
    expect(schedule.waitMs).toBe(12_000);
  });

  it('reports no refresh when every rendition has ended', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 1, { endlist: true }), 0);
    t.ingestMedia(media(LOW, 0, 1, { endlist: true }), 0);
    const schedule = planRefreshAll(t.getPlayableRanges());
    expect(schedule.nextRefreshAt).toBeNull();
    expect(schedule.waitMs).toBe(-1);
  });
});
