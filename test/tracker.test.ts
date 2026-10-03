import { describe, it, expect } from 'vitest';
import {
  HlsWindowTracker,
  parseMasterPlaylist,
  parseMediaPlaylist,
  renditionId,
} from '../src/index.js';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  plainSegments,
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

function masterWith(uris: string[], bandwidths: number[] = [1000]) {
  return parseMasterPlaylist(
    buildMasterPlaylist(
      uris.map((uri, i) => ({
        uri: uri.slice(ORIGIN.length),
        bandwidth: bandwidths[i] ?? 1000,
      })),
    ),
    `${ORIGIN}index.m3u8`,
  );
}

describe('basic window tracking', () => {
  it('reports the playable MSN range per rendition', () => {
    const t = new HlsWindowTracker();
    t.ingestMaster(masterWith([HIGH]));
    t.ingestMedia(media(HIGH, 0, 5), 0);
    const ranges = t.getPlayableRanges();
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.firstMsn).toBe(0);
    expect(ranges[0]!.lastMsn).toBe(4);
    expect(ranges[0]!.mode).toBe('live');
    expect(ranges[0]!.ended).toBe(false);
  });

  it('extends the window forward as segments append', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(HIGH, 0, 4), 2000);
    const r = t.getRendition(renditionId(HIGH))!;
    expect(r.firstMsn).toBe(0);
    expect(r.lastMsn).toBe(3);
    expect(r.frontierFeedSeq).toBeGreaterThan(0);
  });

  it('slides the head forward when old segments leave the window', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 4), 0);
    t.ingestMedia(media(HIGH, 2, 4), 4000);
    const r = t.getRendition(renditionId(HIGH))!;
    expect([r.firstMsn, r.lastMsn]).toEqual([2, 5]);
  });
});

describe('out-of-order delivery', () => {
  it('does not move the window backwards when an older playlist arrives late', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(HIGH, 0, 4), 2000);
    // Late re-delivery of the older snapshot with a "newer" fetch timestamp.
    const result = t.ingestMedia(media(HIGH, 0, 3), 9000);
    expect(result.accepted).toBe(false);
    const r = t.getRendition(renditionId(HIGH))!;
    expect([r.firstMsn, r.lastMsn]).toEqual([0, 3]);
  });

  it('still accepts a genuinely newer snapshot after rejecting a stale one', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(HIGH, 0, 4), 2000);
    t.ingestMedia(media(HIGH, 0, 3), 9000);
    t.ingestMedia(media(HIGH, 1, 4), 12000);
    const r = t.getRendition(renditionId(HIGH))!;
    expect([r.firstMsn, r.lastMsn]).toEqual([1, 4]);
  });

  it('rejects an identical copy carrying an older fetch timestamp', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 5000);
    const res = t.ingestMedia(media(HIGH, 0, 3), 1000);
    expect(res.accepted).toBe(false);
    // Anchor stays at the newer fetch time, streak untouched.
    const r = t.getRendition(renditionId(HIGH))!;
    expect(r.frontierFetchedAt).toBe(5000);
    expect(r.unchangedStreak).toBe(0);
  });

  it('counts an identical but newer poll as an unchanged reload', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3), 0);
    const res = t.ingestMedia(media(HIGH, 0, 3), 2000);
    expect(res.accepted).toBe(true);
    expect(res.changed).toBe(false);
    expect(t.getRendition(renditionId(HIGH))!.unchangedStreak).toBe(1);
  });

  it('a snapshot that slid further but has a shorter tail is still newer', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 6), 0);
    // Newer: dropped 0..3 AND appended 6..7, window is 4..7.
    t.ingestMedia(media(HIGH, 4, 4), 4000);
    // Stale: 3..6 overlaps but tail 6 < 7.
    const result = t.ingestMedia(media(HIGH, 3, 4), 8000);
    expect(result.accepted).toBe(false);
    const r = t.getRendition(renditionId(HIGH))!;
    expect([r.firstMsn, r.lastMsn]).toEqual([4, 7]);
  });

  it('treats signed-query token rotation as the same rendition', () => {
    const t = new HlsWindowTracker();
    const a = `${ORIGIN}high/index.m3u8?token=aaa`;
    const b = `${ORIGIN}high/index.m3u8?token=bbb`;
    t.ingestMedia(media(a, 0, 3), 0);
    const result = t.ingestMedia(media(b, 0, 4), 2000);
    expect(result.accepted).toBe(true);
    expect(t.getRenditionIds()).toHaveLength(1);
  });
});

describe('gap detection', () => {
  it('confirms missing segments when the window jumps over MSNs', () => {
    const t = new HlsWindowTracker();
    t.ingestMaster(masterWith([HIGH]));
    t.ingestMedia(media(HIGH, 0, 4), 0);
    const res = t.ingestMedia(media(HIGH, 6, 4), 4000);
    const gaps = res.diagnostics.filter((d) => d.code === 'window-slide');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      rendition: renditionId(HIGH),
      fromMsn: 4,
      toMsn: 5,
      count: 2,
      previousMsn: 3,
      nextMsn: 6,
    });
    expect(t.getMissingSegments()).toHaveLength(1);
  });

  it('classifies a jump as large as the window as a sequence jump', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 4), 0);
    const res = t.ingestMedia(media(HIGH, 20, 4), 4000);
    const d = res.diagnostics.find((x) => x.code === 'sequence-jump');
    expect(d).toBeDefined();
    expect(d).toMatchObject({ fromMsn: 4, toMsn: 19 });
    // Message points at the playlist and the exact MSNs.
    expect(d!.message).toContain(renditionId(HIGH));
    expect(d!.message).toContain('4..19');
  });

  it('does not invent gaps from overlapping or stale snapshots', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 4), 0);
    t.ingestMedia(media(HIGH, 2, 4), 2000);
    // Stale snapshot arriving late must not create a "gap".
    const res = t.ingestMedia(media(HIGH, 0, 3), 9000);
    expect(res.diagnostics.filter((d) => d.code.includes('slide') || d.code.includes('jump'))).toEqual([]);
    expect(t.getMissingSegments()).toEqual([]);
  });

  it('deduplicates identical gap diagnostics', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 4), 0);
    t.ingestMedia(media(HIGH, 6, 4), 2000);
    // Same gap region reported again from another snapshot.
    t.ingestMedia(media(HIGH, 6, 5), 4000);
    expect(t.getMissingSegments()).toHaveLength(1);
  });

  it('tracks the discontinuity sequence header across contiguous overlaps', () => {
    const t = new HlsWindowTracker();
    // MSN 3 carries the discontinuity; header 0.
    t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 0,
          discontinuitySequence: 0,
          segments: [
            { uri: 'seg0.ts' },
            { uri: 'seg1.ts' },
            { uri: 'seg2.ts' },
            { uri: 'seg3.ts', discontinuity: true },
            { uri: 'seg4.ts' },
          ],
        }),
        HIGH,
      ),
      0,
    );
    // Window slides 0..1 out, but server now claims header 5 (MSN 2 is still
    // in section 0, so it should be 0).
    const res = t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 2,
          discontinuitySequence: 5,
          segments: plainSegments(4, 2),
        }),
        HIGH,
      ),
      2000,
    );
    expect(
      res.diagnostics.find((d) => d.code === 'discontinuity-sequence-mismatch'),
    ).toMatchObject({
      expected: 0,
      actual: 5,
      atMsn: 2,
    });
  });

  it('expects the header to advance when a marked segment slides out', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 0,
          discontinuitySequence: 0,
          segments: [
            { uri: 'seg0.ts' },
            { uri: 'seg1.ts', discontinuity: true },
            { uri: 'seg2.ts' },
            { uri: 'seg3.ts' },
          ],
        }),
        HIGH,
      ),
      0,
    );
    // MSN 1 (marked) slides out; the new first segment MSN 2 is section 1.
    const ok = t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 2,
          discontinuitySequence: 1,
          segments: plainSegments(3, 2),
        }),
        HIGH,
      ),
      2000,
    );
    expect(
      ok.diagnostics.filter(
        (d) => d.code === 'discontinuity-sequence-mismatch',
      ),
    ).toEqual([]);
  });

  it('does not flag discontinuity sequence changes across a real gap', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 0,
          segments: [{ uri: 'seg0.ts', discontinuity: true }, { uri: 'seg1.ts' }],
        }),
        HIGH,
      ),
      0,
    );
    const res = t.ingestMedia(media(HIGH, 20, 2), 2000);
    expect(
      res.diagnostics.filter(
        (d) => d.code === 'discontinuity-sequence-mismatch',
      ),
    ).toEqual([]);
    expect(res.diagnostics.some((d) => d.code === 'sequence-jump')).toBe(true);
  });
});

describe('segment identity', () => {
  it('flags same MSN with a different byte range', () => {
    const t = new HlsWindowTracker();
    const first = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        mediaSequence: 0,
        segments: [
          { uri: 'packed.ts', byteRange: '1000@0' },
          { uri: 'packed.ts', byteRange: '1000@1000' },
        ],
      }),
      HIGH,
    );
    const second = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        mediaSequence: 0,
        segments: [
          { uri: 'packed.ts', byteRange: '1000@0' },
          { uri: 'packed.ts', byteRange: '2500@1000' },
          { uri: 'seg2.ts' },
        ],
      }),
      HIGH,
    );
    t.ingestMedia(first, 0);
    const res = t.ingestMedia(second, 2000);
    const conflict = res.diagnostics.find(
      (d) => d.code === 'segment-identity-conflict',
    );
    expect(conflict).toBeDefined();
    expect(conflict).toMatchObject({ msn: 1, difference: 'byte-range' });
  });

  it('flags same MSN with a different encryption key URI or IV', () => {
    const make = (id: string) =>
      parseMediaPlaylist(
        buildMediaPlaylist({
          targetDuration: 2,
          mediaSequence: 0,
          segments: [
            {
              uri: 'a.ts',
              key: { method: 'AES-128', uri: `key-${id}.bin`, iv: '0x1' },
            },
            { uri: 'b.ts' },
          ],
        }),
        HIGH,
      );
    const t = new HlsWindowTracker();
    t.ingestMedia(make('a'), 0);
    const res = t.ingestMedia(make('b'), 2000);
    expect(
      res.diagnostics.find((d) => d.code === 'segment-identity-conflict'),
    ).toMatchObject({ msn: 0, difference: 'key' });
  });

  it('ignores rotating signed query parameters on segment and key URIs', () => {
    const make = (token: string) =>
      parseMediaPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:2',
          `#EXT-X-KEY:METHOD=AES-128,URI="key.bin?token=${token}"`,
          '#EXTINF:2,',
          `seg0.ts?token=${token}`,
        ].join('\n'),
        HIGH,
      );
    const t = new HlsWindowTracker();
    t.ingestMedia(make('aaa'), 0);
    const res = t.ingestMedia(make('bbb'), 2000);
    expect(res.diagnostics).toEqual([]);
  });

  it('flags same MSN with a different init map', () => {
    const make = (mapUri: string) =>
      parseMediaPlaylist(
        [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:2',
          `#EXT-X-MAP:URI="${mapUri}"`,
          '#EXTINF:2,',
          'a.m4s',
        ].join('\n'),
        HIGH,
      );
    const t = new HlsWindowTracker();
    t.ingestMedia(make('init-a.mp4'), 0);
    const res = t.ingestMedia(make('init-b.mp4'), 2000);
    expect(
      res.diagnostics.find((d) => d.code === 'segment-identity-conflict'),
    ).toMatchObject({ difference: 'init-map' });
  });
});

describe('EVENT, VOD and ended live', () => {
  it('allows EVENT playlists to append but not truncate', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3, { playlistType: 'EVENT' }), 0);
    const ok = t.ingestMedia(
      media(HIGH, 0, 4, { playlistType: 'EVENT' }),
      2000,
    );
    expect(ok.accepted).toBe(true);
    const bad = t.ingestMedia(
      media(HIGH, 1, 4, { playlistType: 'EVENT' }),
      4000,
    );
    const trunc = bad.diagnostics.find((d) => d.code === 'event-truncated');
    expect(trunc).toBeDefined();
    expect(trunc).toMatchObject({ previousFirstMsn: 0, incomingFirstMsn: 1 });
  });

  it('accepts the ENDLIST transition for EVENT and then freezes the window', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3, { playlistType: 'EVENT' }), 0);
    t.ingestMedia(
      media(HIGH, 0, 4, { playlistType: 'EVENT', endlist: true }),
      2000,
    );
    const view = t.getRendition(renditionId(HIGH))!;
    expect(view.ended).toBe(true);
    expect(view.mode).toBe('event');
    // Identical re-delivery is tolerated.
    const again = t.ingestMedia(
      media(HIGH, 0, 4, { playlistType: 'EVENT', endlist: true }),
      4000,
    );
    expect(again.accepted).toBe(true);
    // A changed terminal playlist is rejected with a diagnostic.
    const changed = t.ingestMedia(
      media(HIGH, 0, 5, { playlistType: 'EVENT', endlist: true }),
      6000,
    );
    expect(changed.accepted).toBe(false);
    expect(
      changed.diagnostics.some((d) => d.code === 'vod-content-changed'),
    ).toBe(true);
  });

  it('handles VOD playlists as terminal', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 3, { playlistType: 'VOD', endlist: true }), 0);
    const res = t.ingestMedia(
      media(HIGH, 5, 3, { playlistType: 'VOD', endlist: true }),
      2000,
    );
    expect(res.accepted).toBe(false);
    expect(res.diagnostics[0]).toMatchObject({
      code: 'vod-content-changed',
      difference: 'sequence',
    });
  });

  it('marks a plain live stream that ends with ENDLIST', () => {
    const t = new HlsWindowTracker();
    t.ingestMedia(media(HIGH, 0, 6), 0);
    t.ingestMedia(media(HIGH, 0, 6, { endlist: true }), 2000);
    const view = t.getRendition(renditionId(HIGH))!;
    expect(view.mode).toBe('live');
    expect(view.ended).toBe(true);
  });
});

describe('rendition declarations', () => {
  it('warns once about an undeclared media playlist', () => {
    const t = new HlsWindowTracker();
    const first = t.ingestMedia(media(HIGH, 0, 3), 0);
    expect(
      first.diagnostics.some((d) => d.code === 'undeclared-rendition'),
    ).toBe(true);
    const second = t.ingestMedia(media(HIGH, 0, 4), 2000);
    expect(
      second.diagnostics.some((d) => d.code === 'undeclared-rendition'),
    ).toBe(false);
    // Declaring it later keeps the same tracked rendition.
    t.ingestMaster(masterWith([HIGH]));
    const view = t.getRendition(renditionId(HIGH))!;
    expect(view.declared).not.toBeNull();
    expect(view.lastMsn).toBe(3);
  });

  it('tracks multiple renditions independently and sorts views by id', () => {
    const t = new HlsWindowTracker();
    t.ingestMaster(masterWith([HIGH, LOW], [2000, 400]));
    t.ingestMedia(media(HIGH, 0, 3), 0);
    t.ingestMedia(media(LOW, 0, 3), 0);
    const ids = t.getPlayableRanges().map((r) => r.id);
    expect(ids).toEqual([renditionId(HIGH), renditionId(LOW)].sort());
  });
});
