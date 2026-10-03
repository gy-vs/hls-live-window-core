import { describe, it, expect } from 'vitest';
import {
  parsePlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  PlaylistParseError,
} from '../src/index.js';
import {
  buildMasterPlaylist,
  buildMediaPlaylist,
  plainSegments,
} from './helpers/fixtures.js';

const BASE = 'https://cdn.example.com/live/index.m3u8';

describe('media playlist parsing', () => {
  it('parses media sequence, target duration and segments', () => {
    const text = buildMediaPlaylist({
      targetDuration: 4,
      mediaSequence: 100,
      segments: plainSegments(3, 100),
    });
    const p = parseMediaPlaylist(text, BASE);
    expect(p.kind).toBe('media');
    expect(p.targetDurationSec).toBe(4);
    expect(p.mediaSequence).toBe(100);
    expect(p.mode).toBe('live');
    expect(p.endlist).toBe(false);
    expect(p.segments.map((s) => s.msn)).toEqual([100, 101, 102]);
    expect(p.segments.map((s) => s.durationMs)).toEqual([2000, 2000, 2000]);
    expect(p.segments[0]!.uri).toBe(
      'https://cdn.example.com/live/seg100.ts',
    );
  });

  it('defaults media sequence and discontinuity sequence to zero', () => {
    const p = parseMediaPlaylist(
      buildMediaPlaylist({ targetDuration: 2, segments: plainSegments(1, 0) }),
      BASE,
    );
    expect(p.mediaSequence).toBe(0);
    expect(p.discontinuitySequence).toBe(0);
    expect(p.segments[0]!.discontinuitySequence).toBe(0);
  });

  it('increments discontinuity sequence only at the marker', () => {
    const text = buildMediaPlaylist({
      targetDuration: 2,
      discontinuitySequence: 5,
      segments: [
        { uri: 'a.ts' },
        { uri: 'b.ts', discontinuity: true },
        { uri: 'c.ts' },
      ],
    });
    const p = parseMediaPlaylist(text, BASE);
    expect(p.segments.map((s) => s.discontinuitySequence)).toEqual([5, 6, 6]);
    expect(p.segments.map((s) => s.discontinuity)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('recognizes EVENT, VOD and ended-live modes distinctly', () => {
    const event = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        playlistType: 'EVENT',
        segments: plainSegments(1, 0),
      }),
      BASE,
    );
    expect(event.mode).toBe('event');
    expect(event.endlist).toBe(false);

    const vod = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        playlistType: 'VOD',
        endlist: true,
        segments: plainSegments(1, 0),
      }),
      BASE,
    );
    expect(vod.mode).toBe('vod');
    expect(vod.endlist).toBe(true);

    const endedLive = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        endlist: true,
        segments: plainSegments(1, 0),
      }),
      BASE,
    );
    expect(endedLive.mode).toBe('live');
    expect(endedLive.endlist).toBe(true);
  });

  it('parses and resolves byte ranges with continuation offsets', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:1000@0',
      'seg.ts',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:500',
      'seg.ts',
      '#EXTINF:2,',
      '#EXT-X-BYTERANGE:250',
      'seg.ts',
    ].join('\n');
    const p = parseMediaPlaylist(text, BASE);
    expect(p.segments.map((s) => s.byteRange)).toEqual([
      { length: 1000, offset: 0 },
      { length: 500, offset: 1000 },
      { length: 250, offset: 1500 },
    ]);
  });

  it('parses EXT-X-KEY including IV and NONE reset', () => {
    const text = buildMediaPlaylist({
      targetDuration: 2,
      segments: [
        {
          uri: 'a.ts',
          key: {
            method: 'AES-128',
            uri: 'key.php?id=1',
            iv: '0X1234ABCD',
          },
        },
        { uri: 'b.ts', key: null },
      ],
    });
    const p = parseMediaPlaylist(text, BASE);
    expect(p.segments[0]!.key.method).toBe('AES-128');
    expect(p.segments[0]!.key.uri).toBe(
      'https://cdn.example.com/live/key.php?id=1',
    );
    expect(p.segments[0]!.key.iv).toBe('1234abcd');
    expect(p.segments[1]!.key.method).toBe('NONE');
  });

  it('propagates key and map until changed and parses EXT-X-MAP ranges', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"',
      '#EXTINF:2,',
      'a.m4s',
      '#EXTINF:2,',
      'b.m4s',
    ].join('\n');
    const p = parseMediaPlaylist(text, BASE);
    expect(p.segments[0]!.initMap).toEqual({
      uri: 'https://cdn.example.com/live/init.mp4',
      byteRange: { length: 800, offset: 0 },
    });
    expect(p.segments[1]!.initMap?.uri).toBe(
      'https://cdn.example.com/live/init.mp4',
    );
  });

  it('computes program date times per segment and advances them', () => {
    const text = buildMediaPlaylist({
      targetDuration: 2,
      segments: [
        { uri: 'a.ts', pdtMs: Date.parse('2026-01-01T00:00:00.000Z') },
        { uri: 'b.ts' },
        { uri: 'c.ts', discontinuity: true, pdtMs: Date.parse('2026-01-01T03:00:00.000Z') },
      ],
    });
    const p = parseMediaPlaylist(text, BASE);
    expect(p.segments[0]!.programDateTime).toBe(
      Date.parse('2026-01-01T00:00:00.000Z'),
    );
    expect(p.segments[1]!.programDateTime).toBe(
      Date.parse('2026-01-01T00:00:02.000Z'),
    );
    expect(p.segments[2]!.programDateTime).toBe(
      Date.parse('2026-01-01T03:00:00.000Z'),
    );
  });

  it('parses server control hold-back in milliseconds', () => {
    const p = parseMediaPlaylist(
      buildMediaPlaylist({
        targetDuration: 2,
        serverControl: {
          'CAN-BLOCK-RELOAD': 'YES',
          'HOLD-BACK': '6.0',
          'PART-HOLD-BACK': '0.5',
        },
        segments: plainSegments(1, 0),
      }),
      BASE,
    );
    expect(p.serverControl.canBlockReload).toBe(true);
    expect(p.serverControl.holdBackMs).toBe(6000);
    expect(p.serverControl.partHoldBackMs).toBe(500);
  });

  it('resolves relative URIs against the playlist URI', () => {
    const p = parseMediaPlaylist(
      buildMediaPlaylist({ targetDuration: 2, segments: [{ uri: '../x/a.ts' }] }),
      'https://cdn.example.com/live/nested/index.m3u8',
    );
    expect(p.segments[0]!.uri).toBe('https://cdn.example.com/live/x/a.ts');
  });

  it('rejects malformed playlists', () => {
    expect(() => parsePlaylist('not a playlist', BASE)).toThrow(PlaylistParseError);
    expect(() =>
      parseMediaPlaylist(
        '#EXTM3U\n#EXTINF:2,\na.ts\n',
        BASE,
      ),
    ).toThrow(/TARGETDURATION/);
  });
});

describe('master playlist parsing', () => {
  it('parses variants sorted by URI and resolves rendition URIs', () => {
    const text = buildMasterPlaylist([
      { uri: 'high/index.m3u8', bandwidth: 2_000_000, resolution: '1280x720' },
      { uri: 'low/index.m3u8', bandwidth: 400_000 },
    ]);
    const m = parseMasterPlaylist(text, BASE);
    expect(m.kind).toBe('master');
    expect(m.renditions.map((r) => r.uri)).toEqual([
      'https://cdn.example.com/live/high/index.m3u8',
      'https://cdn.example.com/live/low/index.m3u8',
    ]);
    expect(m.renditions[0]!.bandwidth).toBe(2_000_000);
    expect(m.renditions[0]!.resolution).toEqual({ width: 1280, height: 720 });
  });

  it('parses I-FRAME variants and EXT-X-MEDIA with URIs', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a0",NAME="en",URI="audio.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a0",NAME="muxed"',
    ].join('\n');
    const m = parseMasterPlaylist(text, BASE);
    const uris = m.renditions.map((r) => r.uri).sort();
    expect(uris).toEqual([
      'https://cdn.example.com/live/audio.m3u8',
      'https://cdn.example.com/live/iframe.m3u8',
    ]);
    expect(m.renditions.find((r) => r.uri.endsWith('audio.m3u8'))!.name).toBe(
      'en',
    );
  });

  it('records independent segments flag', () => {
    const m = parseMasterPlaylist(
      buildMasterPlaylist([
        { uri: 'a.m3u8', bandwidth: 1, independentSegments: true },
      ]),
      BASE,
    );
    expect(m.independentSegments).toBe(true);
  });
});
