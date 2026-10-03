import { describe, expect, it } from 'vitest';
import { parsePlaylist, PlaylistParseError } from '../src/parser.js';
import {
  buildAdPodPlaylist,
  buildMasterPlaylist,
  buildMediaPlaylist,
  segmentRun
} from './helpers/playlists.js';

describe('parser: media playlists', () => {
  it('parses a basic live sliding window', () => {
    const text = buildMediaPlaylist({
      targetDurationSec: 6,
      mediaSequence: 100,
      segments: segmentRun(100, 104, 6)
    });
    const parsed = parsePlaylist(text, 'http://example.com/live/low.m3u8');
    expect(parsed.kind).toBe('media');
    if (parsed.kind !== 'media') return;
    const m = parsed.media;
    expect(m.type).toBe('live');
    expect(m.endList).toBe(false);
    expect(m.mediaSequence).toBe(100);
    expect(m.targetDurationSec).toBe(6);
    expect(m.segments).toHaveLength(5);
    expect(m.segments[0]!.msn).toBe(100);
    expect(m.segments[4]!.msn).toBe(104);
    expect(m.segments[0]!.dseq).toBe(0);
    expect(m.segments[0]!.durationMs).toBe(6000);
    expect(m.segments[0]!.uri).toBe('http://example.com/live/seg-100.ts');
    expect(parsed.warnings).toEqual([]);
  });

  it('assigns dseq from discontinuity markers and bumping across them', () => {
    const text = buildAdPodPlaylist({
      mainFrom: 0,
      adStart: 5,
      adEnd: 8,
      to: 10,
      durationSec: 6
    });
    const parsed = parsePlaylist(text, 'http://x/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    const byMsn = new Map(parsed.media.segments.map((s) => [s.msn, s]));
    expect(byMsn.get(4)!.dseq).toBe(0);
    expect(byMsn.get(5)!.dseq).toBe(1);
    expect(byMsn.get(5)!.discontinuity).toBe(true);
    expect(byMsn.get(7)!.dseq).toBe(1);
    expect(byMsn.get(8)!.dseq).toBe(2);
    expect(byMsn.get(10)!.dseq).toBe(2);
  });

  it('honors EXT-X-DISCONTINUITY-SEQUENCE for windows starting mid-era', () => {
    const text = buildAdPodPlaylist({
      mainFrom: 9,
      adStart: 5,
      adEnd: 8,
      to: 10,
      durationSec: 6,
      discontinuitySequence: 2
    });
    const parsed = parsePlaylist(text, 'http://x/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    expect(parsed.media.segments[0]!.msn).toBe(9);
    expect(parsed.media.segments[0]!.dseq).toBe(2);
    expect(parsed.media.segments[1]!.discontinuity).toBe(false);
  });

  it('parses PROGRAM-DATE-TIME into start/end epoch ms', () => {
    const base = Date.UTC(2025, 0, 1, 0, 0, 0);
    const text = buildMediaPlaylist({
      targetDurationSec: 6,
      mediaSequence: 0,
      segments: [
        { msn: 0, durationSec: 6, pdtMs: base },
        { msn: 1, durationSec: 6 },
        { msn: 2, durationSec: 4 }
      ]
    });
    const parsed = parsePlaylist(text, 'http://x/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    expect(parsed.media.segments[0]!.pdtStart).toBe(base);
    expect(parsed.media.segments[0]!.pdtEnd).toBe(base + 6000);
    expect(parsed.media.segments[1]!.pdtStart).toBe(base + 6000);
    expect(parsed.media.segments[2]!.pdtEnd).toBe(base + 16000);
  });

  it('parses byte ranges, keys and maps as content identity', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-VERSION:5',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="120@0"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://kms/key",IV=0x0A',
      '#EXTINF:6,',
      '#EXT-X-BYTERANGE:1000@1000',
      'frag.mp4',
      '#EXTINF:6,',
      '#EXT-X-BYTERANGE:1000',
      'frag.mp4',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:6,',
      'plain.ts',
      ''
    ].join('\n');
    const parsed = parsePlaylist(text, 'http://example.com/path/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    const s0 = parsed.media.segments[0]!;
    expect(s0.byteRange).toEqual({ offset: 1000, length: 1000 });
    expect(s0.map).toEqual({ uri: 'http://example.com/path/init.mp4', byteRange: { offset: 0, length: 120 } });
    expect(s0.key?.method).toBe('AES-128');
    expect(s0.key?.uri).toBe('https://kms/key');
    expect(s0.key?.iv).toBe('a'.padStart(32, '0'));
    // implicit byte range start follows previous range
    expect(parsed.media.segments[1]!.byteRange).toEqual({ offset: 2000, length: 1000 });
    expect(parsed.media.segments[2]!.key).toBeNull();
  });

  it('parses EVENT and VOD types with ENDLIST', () => {
    for (const type of ['event', 'vod'] as const) {
      const text = buildMediaPlaylist({
        targetDurationSec: 6,
        type,
        endList: true,
        segments: segmentRun(0, 2, 6)
      });
      const parsed = parsePlaylist(text, `http://x/${type}.m3u8`);
      if (parsed.kind !== 'media') throw new Error('expected media');
      expect(parsed.media.type).toBe(type);
      expect(parsed.media.endList).toBe(true);
    }
  });

  it('collects malformed lines as warnings instead of throwing', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=',
      '#EXTINF:6,',
      'seg-0.ts',
      ''
    ].join('\n');
    const parsed = parsePlaylist(text, 'http://x/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('throws PlaylistParseError when #EXTM3U is missing', () => {
    expect(() => parsePlaylist('not a playlist\n', 'http://x/x.m3u8')).toThrow(PlaylistParseError);
  });

  it('parses server control attributes', () => {
    const text = buildMediaPlaylist({
      targetDurationSec: 2,
      serverControl: { canBlockReload: true, canSkipUntil: 12, holdBack: 6, partHoldBack: 0.6 },
      segments: segmentRun(0, 3, 2)
    });
    const parsed = parsePlaylist(text, 'http://x/low.m3u8');
    if (parsed.kind !== 'media') throw new Error('expected media');
    expect(parsed.media.serverControl.canBlockReload).toBe(true);
    expect(parsed.media.serverControl.canSkipUntil).toBe(12);
    expect(parsed.media.serverControl.holdBack).toBe(6);
    expect(parsed.media.serverControl.partHoldBack).toBeCloseTo(0.6);
  });
});

describe('parser: master playlists', () => {
  it('parses variants and EXT-X-MEDIA with resolved URIs', () => {
    const text = buildMasterPlaylist({
      variants: [
        { uri: 'low.m3u8', bandwidth: 100_000, resolution: { width: 640, height: 360 }, audio: 'aud' },
        { uri: 'high.m3u8', bandwidth: 500_000, resolution: { width: 1920, height: 1080 }, audio: 'aud' }
      ],
      media: [
        { type: 'AUDIO', groupId: 'aud', name: 'English', uri: 'audio/en.m3u8', language: 'en', default: true }
      ]
    });
    const parsed = parsePlaylist(text, 'http://example.com/live/master.m3u8');
    expect(parsed.kind).toBe('master');
    if (parsed.kind !== 'master') return;
    expect(parsed.master.variants).toHaveLength(2);
    expect(parsed.master.variants[0]!.resolvedUri).toBe('http://example.com/live/low.m3u8');
    expect(parsed.master.variants[0]!.resolution).toEqual({ width: 640, height: 360 });
    expect(parsed.master.variants[0]!.audioGroup).toBe('aud');
    expect(parsed.master.media[0]!.resolvedUri).toBe('http://example.com/live/audio/en.m3u8');
    expect(parsed.master.media[0]!.isDefault).toBe(true);
  });

  it('distinguishes master from media even with a target duration present', () => {
    const text = buildMediaPlaylist({ targetDurationSec: 6, segments: segmentRun(0, 0, 6) });
    const parsed = parsePlaylist(text, 'http://x/m.m3u8');
    expect(parsed.kind).toBe('media');
  });
});
