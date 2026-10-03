import {
  ByteRange,
  KeyDescriptor,
  MapDescriptor,
  MasterPlaylist,
  MediaPlaylist,
  ParseWarning,
  PlaylistParseError,
  Segment,
  ServerControl,
  VariantRendition,
} from './types.js';

/**
 * Parse the body of either a master or a media playlist.
 *
 * @param text the raw playlist bytes decoded as UTF-8.
 * @param baseUri absolute URI used to resolve relative segment/playlist URIs.
 */
export function parsePlaylist(
  text: string,
  baseUri: string,
): MasterPlaylist | MediaPlaylist {
  const body = text.replace(/^﻿/, '');
  const lines = body
    .split(/\r\n|\n|\r/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const warnings: ParseWarning[] = [];

  if (lines.length === 0 || lines[0]!.trim() !== '#EXTM3U') {
    throw new PlaylistParseError('playlist must start with #EXTM3U', 0);
  }

  const isMaster = lines.some(
    (line) =>
      line.startsWith('#EXT-X-STREAM-INF') ||
      line.startsWith('#EXT-X-I-FRAME-STREAM-INF') ||
      line.startsWith('#EXT-X-MEDIA:'),
  );
  const isMedia = lines.some(
    (line) =>
      line.startsWith('#EXTINF:') ||
      line === '#EXT-X-TARGETDURATION' ||
      line.startsWith('#EXT-X-TARGETDURATION:'),
  );

  if (isMaster && isMedia) {
    throw new PlaylistParseError(
      'playlist mixes master and media playlist tags',
      null,
    );
  }

  return isMedia || !isMaster
    ? parseMedia(lines, baseUri, warnings)
    : parseMaster(lines, baseUri, warnings);
}

export function parseMasterPlaylist(
  text: string,
  baseUri: string,
): MasterPlaylist {
  const parsed = parsePlaylist(text, baseUri);
  if (parsed.kind !== 'master') {
    throw new PlaylistParseError('expected a master playlist', null);
  }
  return parsed;
}

export function parseMediaPlaylist(
  text: string,
  baseUri: string,
): MediaPlaylist {
  const parsed = parsePlaylist(text, baseUri);
  if (parsed.kind !== 'media') {
    throw new PlaylistParseError('expected a media playlist', null);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Attribute list parsing
// ---------------------------------------------------------------------------

type AttrValue = string | number;

export function parseAttributes(raw: string): Record<string, AttrValue> {
  const attrs: Record<string, AttrValue> = {};
  let i = 0;
  const n = raw.length;
  while (i < n) {
    while (i < n && raw[i] === ',') i++;
    const nameStart = i;
    while (i < n && raw[i] !== '=') i++;
    if (i >= n) break;
    const name = raw.slice(nameStart, i).trim().toUpperCase();
    i++; // skip '='
    let value: AttrValue;
    if (raw[i] === '"') {
      i++;
      let str = '';
      while (i < n && raw[i] !== '"') {
        if (raw[i] === '\\' && i + 1 < n) {
          str += raw[i + 1];
          i += 2;
        } else {
          str += raw[i];
          i++;
        }
      }
      i++; // skip closing quote
      value = str;
    } else {
      const start = i;
      while (i < n && raw[i] !== ',') i++;
      const token = raw.slice(start, i).trim();
      value = token;
      // Keep numeric-looking tokens as numbers for convenience.
      if (name !== 'CODECS' && /^-?\d+(?:\.\d+)?$/.test(token)) {
        value = Number(token);
      }
    }
    if (name.length > 0) attrs[name] = value;
  }
  return attrs;
}

function strAttr(
  attrs: Record<string, AttrValue>,
  name: string,
): string | null {
  const v = attrs[name];
  return typeof v === 'string' ? v : null;
}

function boolAttr(
  attrs: Record<string, AttrValue>,
  name: string,
): boolean | null {
  const v = attrs[name];
  if (v === undefined) return null;
  return String(v).toUpperCase() === 'YES';
}

function numAttr(
  attrs: Record<string, AttrValue>,
  name: string,
): number | null {
  const v = attrs[name];
  if (v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Master playlist
// ---------------------------------------------------------------------------

function parseMaster(
  lines: string[],
  baseUri: string,
  warnings: ParseWarning[],
): MasterPlaylist {
  const renditions: VariantRendition[] = [];
  let independentSegments = false;
  let pending: Record<string, AttrValue> | null = null;
  let pendingIframe: Record<string, AttrValue> | null = null;

  const applyMediaCommon = (
    r: VariantRendition,
    attrs: Record<string, AttrValue>,
  ): void => {
    r.name = strAttr(attrs, 'NAME');
    r.language = strAttr(attrs, 'LANGUAGE');
    r.assocLanguage = strAttr(attrs, 'ASSOC-LANGUAGE');
    r.groupId = strAttr(attrs, 'GROUP-ID');
    r.isDefault = boolAttr(attrs, 'DEFAULT');
    r.autoselect = boolAttr(attrs, 'AUTOSELECT');
    r.forced = boolAttr(attrs, 'FORCED');
    r.instreamId = strAttr(attrs, 'INSTREAM-ID');
    r.characteristics = strAttr(attrs, 'CHARACTERISTICS');
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line === '#EXTM3U') continue;

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      pendingIframe = parseAttributes(
        line.slice('#EXT-X-I-FRAME-STREAM-INF:'.length),
      );
      const uri = strAttr(pendingIframe, 'URI');
      if (uri !== null) {
        const r = newRendition('iframe', resolveUri(baseUri, uri));
        applyStreamAttrs(r, pendingIframe);
        renditions.push(r);
      } else {
        warnings.push(warn('invalid-attr', 'I-FRAME-STREAM-INF without URI', li));
      }
      pendingIframe = null;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = strAttr(attrs, 'TYPE');
      const uri = strAttr(attrs, 'URI');
      if (uri === null) {
        // Renditions without a URI (e.g. audio muxed into variants) need no
        // tracking — they are selectable through their containing variant.
        continue;
      }
      const r = newRendition(
        type === 'CLOSED-CAPTIONS' ? 'variant' : 'variant',
        resolveUri(baseUri, uri),
      );
      applyMediaCommon(r, attrs);
      renditions.push(r);
      continue;
    }
    if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      independentSegments = true;
      continue;
    }
    if (line.startsWith('#EXT-X-VERSION') || line.startsWith('#EXT-X-DEFINE')) {
      continue;
    }
    if (line.startsWith('#EXT-X-')) {
      warnings.push(warn('unrecognized-tag', `ignored tag ${line}`, li));
      continue;
    }
    if (line.startsWith('#')) continue;

    // A bare URI closes a pending STREAM-INF.
    if (pending !== null) {
      const r = newRendition('variant', resolveUri(baseUri, line));
      applyStreamAttrs(r, pending);
      renditions.push(r);
      pending = null;
      continue;
    }
    warnings.push(warn('unexpected-tag', `URI without STREAM-INF: ${line}`, li));
  }

  if (pending !== null) {
    warnings.push(warn('unexpected-tag', 'STREAM-INF without URI', -1));
  }

  // Deterministic ordering: resolved URI, then bandwidth.
  renditions.sort((a, b) => {
    if (a.uri !== b.uri) return a.uri < b.uri ? -1 : 1;
    return (a.bandwidth ?? -1) - (b.bandwidth ?? -1);
  });

  return {
    kind: 'master',
    uri: baseUri,
    renditions: dedupeRenditions(renditions),
    independentSegments,
    warnings,
  };
}

function newRendition(
  type: VariantRendition['type'],
  uri: string,
): VariantRendition {
  return {
    type,
    uri,
    bandwidth: null,
    averageBandwidth: null,
    codecs: null,
    resolution: null,
    frameRate: null,
    hdcpLevel: null,
    videoRange: null,
    name: null,
    language: null,
    assocLanguage: null,
    groupId: null,
    isDefault: null,
    autoselect: null,
    forced: null,
    instreamId: null,
    characteristics: null,
  };
}

function applyStreamAttrs(
  r: VariantRendition,
  attrs: Record<string, AttrValue>,
): void {
  r.bandwidth = numAttr(attrs, 'BANDWIDTH');
  r.averageBandwidth = numAttr(attrs, 'AVERAGE-BANDWIDTH');
  r.codecs = strAttr(attrs, 'CODECS');
  const res = strAttr(attrs, 'RESOLUTION');
  if (res !== null) {
    const m = /^(\d+)x(\d+)$/.exec(res);
    if (m) {
      r.resolution = { width: Number(m[1]), height: Number(m[2]) };
    }
  }
  r.frameRate = numAttr(attrs, 'FRAME-RATE');
  r.hdcpLevel = strAttr(attrs, 'HDCP-LEVEL');
  r.videoRange = strAttr(attrs, 'VIDEO-RANGE');
  // AUDIO/VIDEO/SUBTITLES/CLOSED-CAPTIONS group names — keep the video group
  // reference via groupId for convenience.
  r.groupId = strAttr(attrs, 'VIDEO') ?? strAttr(attrs, 'AUDIO');
  r.name = null;
  r.language = null;
  r.assocLanguage = null;
  r.isDefault = null;
  r.autoselect = null;
  r.forced = null;
  r.instreamId = null;
  r.characteristics = null;
}

function dedupeRenditions(rs: VariantRendition[]): VariantRendition[] {
  const seen = new Set<string>();
  const out: VariantRendition[] = [];
  for (const r of rs) {
    if (seen.has(r.uri)) continue;
    seen.add(r.uri);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Media playlist
// ---------------------------------------------------------------------------

function parseMedia(
  lines: string[],
  baseUri: string,
  warnings: ParseWarning[],
): MediaPlaylist {
  let targetDurationSec: number | null = null;
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let endlist = false;
  let independentSegments = false;
  let playlistType: 'EVENT' | 'VOD' | null = null;
  let serverControl: ServerControl = {
    canSkipUntil: null,
    canSkipDateRanges: false,
    holdBackMs: null,
    partHoldBackMs: null,
    canBlockReload: false,
  };

  let mediaSequenceSeen = false;
  let discontinuitySequenceSeen = false;
  let firstSegmentLine = -1;

  const segments: Segment[] = [];
  let currentKey: KeyDescriptor = {
    method: 'NONE',
    uri: null,
    iv: null,
    keyFormat: null,
    keyFormatVersions: null,
  };
  let currentMap: MapDescriptor | null = null;
  let pendingDiscontinuity = false;
  let pendingProgramDateTime: number | null = null;
  let pendingByteRange: ByteRange | null = null;
  let lastByteRange: ByteRange | null = null;
  let pendingDurationSec: number | null = null;
  let runningDisco = 0;
  let runningPdt: number | null = null;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line === '#EXTM3U') continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const v = Number(line.slice('#EXT-X-TARGETDURATION:'.length).trim());
      if (!Number.isFinite(v) || v <= 0) {
        throw new PlaylistParseError('invalid TARGETDURATION', li);
      }
      targetDurationSec = v;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (firstSegmentLine !== -1) {
        warnings.push(warn('late-tag', 'MEDIA-SEQUENCE after first segment', li));
      }
      mediaSequence = Number(
        line.slice('#EXT-X-MEDIA-SEQUENCE:'.length).trim(),
      );
      mediaSequenceSeen = true;
      continue;
    }
    if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      if (firstSegmentLine !== -1) {
        warnings.push(
          warn('late-tag', 'DISCONTINUITY-SEQUENCE after first segment', li),
        );
      }
      discontinuitySequence = Number(
        line.slice('#EXT-X-DISCONTINUITY-SEQUENCE:'.length).trim(),
      );
      discontinuitySequenceSeen = true;
      runningDisco = discontinuitySequence;
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endlist = true;
      continue;
    }
    if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      independentSegments = true;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      const t = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
      if (t === 'EVENT') playlistType = 'EVENT';
      else if (t === 'VOD') playlistType = 'VOD';
      else warnings.push(warn('invalid-value', `unknown PLAYLIST-TYPE ${t}`, li));
      continue;
    }
    if (line.startsWith('#EXT-X-SERVER-CONTROL:')) {
      serverControl = parseServerControl(
        parseAttributes(line.slice('#EXT-X-SERVER-CONTROL:'.length)),
        li,
        warnings,
      );
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      currentKey = parseKey(
        parseAttributes(line.slice('#EXT-X-KEY:'.length)),
        baseUri,
        li,
        warnings,
      );
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      currentMap = parseMap(
        parseAttributes(line.slice('#EXT-X-MAP:'.length)),
        baseUri,
        li,
        warnings,
      );
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const t = Date.parse(
        line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim(),
      );
      if (Number.isNaN(t)) {
        warnings.push(warn('invalid-value', 'invalid PROGRAM-DATE-TIME', li));
      } else {
        pendingProgramDateTime = t;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(
        line.slice('#EXT-X-BYTERANGE:'.length).trim(),
        lastByteRange,
        li,
      );
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const d = Number(line.slice('#EXTINF:'.length).split(',')[0]);
      if (!Number.isFinite(d) || d < 0) {
        throw new PlaylistParseError('invalid EXTINF duration', li);
      }
      pendingDurationSec = d;
      continue;
    }
    if (
      line.startsWith('#EXT-X-VERSION') ||
      line.startsWith('#EXT-X-DEFINE') ||
      line.startsWith('#EXT-X-PART:') ||
      line === '#EXT-X-PART-INF' ||
      line.startsWith('#EXT-X-PART-INF:') ||
      line.startsWith('#EXT-X-SKIP:') ||
      line.startsWith('#EXT-X-DATERANGE:') ||
      line.startsWith('#EXT-X-PRELOAD-HINT:') ||
      line.startsWith('#EXT-X-RENDITION-REPORT:')
    ) {
      continue;
    }
    if (line.startsWith('#EXT-X-')) {
      warnings.push(warn('unrecognized-tag', `ignored tag ${line}`, li));
      continue;
    }
    if (line.startsWith('#')) continue;

    // Segment URI line.
    if (pendingDurationSec === null) {
      throw new PlaylistParseError('segment URI without EXTINF', li);
    }
    if (firstSegmentLine === -1) {
      firstSegmentLine = li;
      if (!discontinuitySequenceSeen) runningDisco = discontinuitySequence;
    }

    const msn = mediaSequence + segments.length;
    if (pendingDiscontinuity) {
      runningDisco += 1;
    }
    let pdt: number | null;
    if (pendingProgramDateTime !== null) {
      pdt = pendingProgramDateTime;
      runningPdt = pendingProgramDateTime;
    } else if (runningPdt !== null) {
      pdt = runningPdt;
    } else {
      pdt = null;
    }

    const durationSec = pendingDurationSec;
    const durationMs = Math.round(durationSec * 1000);

    segments.push({
      msn,
      discontinuitySequence: runningDisco,
      uri: resolveUri(baseUri, line),
      durationMs,
      durationSec,
      discontinuity: pendingDiscontinuity,
      independent: independentSegments,
      byteRange: pendingByteRange,
      key: currentKey,
      initMap: currentMap,
      programDateTime: pdt,
    });

    if (runningPdt !== null) runningPdt += durationMs;
    pendingDiscontinuity = false;
    pendingProgramDateTime = null;
    lastByteRange = pendingByteRange;
    pendingByteRange = null;
    pendingDurationSec = null;
  }

  // TARGETDURATION is mandatory for a media playlist (RFC 8216 §4.3.3.1).
  if (targetDurationSec === null) {
    throw new PlaylistParseError('media playlist has no TARGETDURATION', null);
  }

  // PLAYLIST-TYPE selects the mode; ENDLIST alone (on a plain live stream)
  // keeps mode "live" with ended=true — that is a live stream that finished.
  const mode: MediaPlaylist['mode'] =
    playlistType === 'EVENT'
      ? 'event'
      : playlistType === 'VOD'
        ? 'vod'
        : 'live';

  return {
    kind: 'media',
    uri: baseUri,
    targetDurationSec,
    mediaSequence: mediaSequenceSeen ? mediaSequence : 0,
    discontinuitySequence,
    endlist,
    mode,
    independentSegments,
    serverControl,
    segments,
    warnings,
  };
}

function parseServerControl(
  attrs: Record<string, AttrValue>,
  line: number,
  warnings: ParseWarning[],
): ServerControl {
  const sc: ServerControl = {
    canSkipUntil: null,
    canSkipDateRanges: boolAttr(attrs, 'CAN-SKIP-DATERANGES') ?? false,
    holdBackMs: null,
    partHoldBackMs: null,
    canBlockReload: boolAttr(attrs, 'CAN-BLOCK-RELOAD') ?? false,
  };
  const skip = numAttr(attrs, 'CAN-SKIP-UNTIL');
  if (skip !== null) sc.canSkipUntil = skip;
  const hb = numAttr(attrs, 'HOLD-BACK');
  if (hb !== null) {
    if (hb < 0) warnings.push(warn('invalid-value', 'negative HOLD-BACK', line));
    else sc.holdBackMs = Math.round(hb * 1000);
  }
  const phb = numAttr(attrs, 'PART-HOLD-BACK');
  if (phb !== null) {
    if (phb < 0)
      warnings.push(warn('invalid-value', 'negative PART-HOLD-BACK', line));
    else sc.partHoldBackMs = Math.round(phb * 1000);
  }
  return sc;
}

function parseKey(
  attrs: Record<string, AttrValue>,
  baseUri: string,
  line: number,
  warnings: ParseWarning[],
): KeyDescriptor {
  const method = strAttr(attrs, 'METHOD') ?? '';
  if (method.length === 0) {
    warnings.push(warn('invalid-attr', 'EXT-X-KEY without METHOD', line));
    return {
      method: 'NONE',
      uri: null,
      iv: null,
      keyFormat: null,
      keyFormatVersions: null,
    };
  }
  if (method === 'NONE') {
    return {
      method: 'NONE',
      uri: null,
      iv: null,
      keyFormat: null,
      keyFormatVersions: null,
    };
  }
  const uriRaw = strAttr(attrs, 'URI');
  if (uriRaw === null) {
    warnings.push(warn('invalid-attr', `EXT-X-KEY ${method} without URI`, line));
  }
  return {
    method,
    uri: uriRaw === null ? null : resolveUri(baseUri, uriRaw),
    iv: normalizeIv(strAttr(attrs, 'IV')),
    keyFormat: strAttr(attrs, 'KEYFORMAT'),
    keyFormatVersions: strAttr(attrs, 'KEYFORMATVERSIONS'),
  };
}

function normalizeIv(iv: string | null): string | null {
  if (iv === null) return null;
  const hex = iv.replace(/^0[xX]/, '').toLowerCase();
  return /^[0-9a-f]+$/.test(hex) ? hex : iv.toLowerCase();
}

function parseMap(
  attrs: Record<string, AttrValue>,
  baseUri: string,
  line: number,
  warnings: ParseWarning[],
): MapDescriptor {
  const uriRaw = strAttr(attrs, 'URI');
  if (uriRaw === null) {
    warnings.push(warn('invalid-attr', 'EXT-X-MAP without URI', line));
    return { uri: '', byteRange: null };
  }
  return {
    uri: resolveUri(baseUri, uriRaw),
    byteRange: parseByteRange(strAttr(attrs, 'BYTERANGE'), null, line),
  };
}

function parseByteRange(
  raw: string | null,
  previous: ByteRange | null,
  line: number,
): ByteRange | null {
  if (raw === null) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(raw.trim());
  if (!m) {
    throw new PlaylistParseError(`invalid byte range "${raw}"`, line);
  }
  const length = Number(m[1]);
  if (m[2] !== undefined) {
    return { length, offset: Number(m[2]) };
  }
  if (previous === null) {
    throw new PlaylistParseError('byte range without offset', line);
  }
  return { length, offset: previous.offset + previous.length };
}

function warn(
  code: ParseWarning['code'],
  message: string,
  line: number,
): ParseWarning {
  return { code, message, line: line < 0 ? -1 : line };
}

// ---------------------------------------------------------------------------
// URI resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a possibly relative URI. Uses the WHATWG URL when the base is
 * absolute, otherwise a deterministic path-style fallback so file names and
 * non-URL identifiers still behave consistently.
 */
export function resolveUri(baseUri: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  try {
    return new URL(ref, baseUri).toString();
  } catch {
    // Non-URL base (e.g. a synthetic id) — resolve by path segments only.
    const basePath = baseUri.includes('/')
      ? baseUri.slice(0, baseUri.lastIndexOf('/') + 1)
      : '';
    return (basePath + ref).replace(/([^/])\/\.\//g, '$1/');
  }
}
