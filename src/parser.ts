/**
 * Deterministic HLS playlist parser (RFC 8216).
 *
 * Only parsing: no network, no clock, no assumptions about fetch timing.
 * Unknown tags are ignored (forward compatibility per RFC 8216 §4);
 * malformed known lines are collected as parse warnings instead of throwing.
 */
import {
  AttrValue,
  attrEnum,
  attrNumber,
  attrString,
  msOfSeconds,
  normalizeIv,
  parseAttrList,
  parseByteRange,
  parseIsoDate,
  resolveUri
} from './util.js';
import {
  KeyInfo,
  MapInfo,
  MasterPlaylist,
  MediaPlaylist,
  MediaRenditionSpec,
  Segment,
  VariantStream,
  ByteRange
} from './types.js';

export interface ParseWarning {
  lineNumber: number;
  line: string;
  message: string;
}

export type ParsedPlaylist =
  | { kind: 'master'; baseUri: string; master: MasterPlaylist; warnings: ParseWarning[] }
  | { kind: 'media'; baseUri: string; media: MediaPlaylist; warnings: ParseWarning[] };

export class PlaylistParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistParseError';
  }
}

export function parsePlaylist(text: string, baseUri: string): ParsedPlaylist {
  const lines = splitLines(text);
  if (lines.length === 0 || lines[0]!.body.trim() !== '#EXTM3U') {
    throw new PlaylistParseError(`not an HLS playlist (missing #EXTM3U): ${baseUri}`);
  }

  const warnings: ParseWarning[] = [];

  let sawStreamInf = false;
  let sawTargetDuration = false;
  let sawExtinf = false;
  for (const { body } of lines) {
    if (body === '#EXT-X-STREAM-INF' || body.startsWith('#EXT-X-STREAM-INF:')) sawStreamInf = true;
    if (body === '#EXT-X-TARGETDURATION' || body.startsWith('#EXT-X-TARGETDURATION:'))
      sawTargetDuration = true;
    if (body === '#EXTINF' || body.startsWith('#EXTINF:')) sawExtinf = true;
  }
  if (sawStreamInf && !sawTargetDuration && !sawExtinf) {
    return { kind: 'master', baseUri, master: parseMaster(lines, baseUri, warnings), warnings };
  }
  return { kind: 'media', baseUri, media: parseMedia(lines, baseUri, warnings), warnings };
}

function splitLines(text: string): { number: number; body: string }[] {
  const out: { number: number; body: string }[] = [];
  const raw = text.split(/\r\n|\n|\r/);
  for (let i = 0; i < raw.length; i += 1) {
    const body = (raw[i] ?? '').trim();
    if (body === '') continue;
    out.push({ number: i + 1, body });
  }
  return out;
}

function tagOf(body: string): { name: string; value: string | null } {
  if (!body.startsWith('#')) return { name: '', value: null };
  const colon = body.indexOf(':');
  if (colon === -1) return { name: body, value: null };
  // Attribute values never contain a colon inside the tag name, but quoted
  // values can; splitting at the first colon is exactly what the spec does.
  return { name: body.slice(0, colon), value: body.slice(colon + 1) };
}

function parseResolution(raw: string | null): { width: number; height: number } | null {
  if (!raw) return null;
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseMaster(
  lines: { number: number; body: string }[],
  baseUri: string,
  warnings: ParseWarning[]
): MasterPlaylist {
  const warn = (lineNumber: number, line: string, message: string) =>
    warnings.push({ lineNumber, line, message });
  const variants: VariantStream[] = [];
  const media: MediaRenditionSpec[] = [];
  let independentSegments = false;
  let pending: { attrs: Record<string, AttrValue>; lineNumber: number } | null = null;

  for (const { number: lineNumber, body } of lines) {
    if (body === '#EXTM3U') continue;
    const { name, value } = tagOf(body);
    switch (name) {
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        independentSegments = true;
        break;
      case '#EXT-X-MEDIA': {
        if (value === null) {
          warn(lineNumber, body, '#EXT-X-MEDIA without attribute list');
          break;
        }
        const attrs = parseAttrList(value);
        const typeRaw = attrEnum(attrs, 'TYPE');
        const groupId = attrString(attrs, 'GROUP-ID');
        const label = attrString(attrs, 'NAME');
        if (!typeRaw || !groupId || !label) {
          warn(lineNumber, body, '#EXT-X-MEDIA missing TYPE/GROUP-ID/NAME');
          break;
        }
        const type =
          typeRaw === 'AUDIO'
            ? 'audio'
            : typeRaw === 'VIDEO'
              ? 'video'
              : typeRaw === 'SUBTITLES'
                ? 'subtitles'
                : typeRaw === 'CLOSED-CAPTIONS'
                  ? 'closed-captions'
                  : null;
        if (!type) {
          warn(lineNumber, body, `unknown #EXT-X-MEDIA TYPE=${typeRaw}`);
          break;
        }
        const uri = attrString(attrs, 'URI');
        media.push({
          type,
          groupId,
          name: label,
          uri,
          resolvedUri: uri === null ? null : resolveUri(baseUri, uri),
          language: attrString(attrs, 'LANGUAGE'),
          assocLanguage: attrString(attrs, 'ASSOC-LANGUAGE'),
          isDefault: attrEnum(attrs, 'DEFAULT') === 'YES',
          autoselect: attrEnum(attrs, 'AUTOSELECT') === 'YES',
          forced: attrEnum(attrs, 'FORCED') === 'YES',
          instreamId: attrString(attrs, 'INSTREAM-ID'),
          characteristics: attrString(attrs, 'CHARACTERISTICS'),
          channels: attrString(attrs, 'CHANNELS')
        });
        break;
      }
      case '#EXT-X-STREAM-INF': {
        if (value === null) {
          warn(lineNumber, body, '#EXT-X-STREAM-INF without attribute list');
          pending = null;
          break;
        }
        pending = { attrs: parseAttrList(value), lineNumber };
        break;
      }
      case '': {
        // URI line
        if (!body.startsWith('#')) {
          if (pending) {
            const a = pending.attrs;
            const bandwidth = attrNumber(a, 'BANDWIDTH');
            if (bandwidth === null) {
              warn(pending.lineNumber, body, '#EXT-X-STREAM-INF missing BANDWIDTH');
            }
            const range = attrString(a, 'VIDEO-RANGE');
            variants.push({
              uri: body,
              resolvedUri: resolveUri(baseUri, body),
              bandwidth: bandwidth ?? -1,
              averageBandwidth: attrNumber(a, 'AVERAGE-BANDWIDTH'),
              codecs: attrString(a, 'CODECS'),
              resolution: parseResolution(attrString(a, 'RESOLUTION')),
              frameRate: attrNumber(a, 'FRAME-RATE'),
              hdcpLevel: attrString(a, 'HDCP-LEVEL'),
              videoRange:
                range === 'HLG'
                  ? 'hlg'
                  : range === 'PQ'
                    ? 'dolby-vision'
                    : range === 'SDR' || range === null
                      ? 'sdr'
                      : 'unknown',
              audioGroup: attrString(a, 'AUDIO'),
              videoGroup: attrString(a, 'VIDEO'),
              subtitlesGroup: attrString(a, 'SUBTITLES'),
              closedCaptionsGroup: attrString(a, 'CLOSED-CAPTIONS'),
              variantId: ''
            });
            pending = null;
          }
        }
        break;
      }
      default:
        // Unknown master tags are ignored.
        break;
    }
  }
  if (pending) {
    warn(pending.lineNumber, '#EXT-X-STREAM-INF', 'variant without following URI line');
  }

  return { resolvedUri: baseUri, independentSegments, variants, media };
}

function parseMedia(
  lines: { number: number; body: string }[],
  baseUri: string,
  warnings: ParseWarning[]
): MediaPlaylist {
  const warn = (lineNumber: number, line: string, message: string) =>
    warnings.push({ lineNumber, line, message });
  let version = 1;
  let targetDurationSec: number | null = null;
  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let allowCache = true;
  let iFrameOnly = false;
  let independentSegments = false;
  let playlistType: 'EVENT' | 'VOD' | null = null;
  let endList = false;
  let serverCanBlockReload = false;
  let serverCanSkipUntil: number | null = null;
  let serverHoldBack: number | null = null;
  let serverPartHoldBack: number | null = null;

  const segments: Segment[] = [];

  let currentKey: KeyInfo | null = null;
  let currentMap: MapInfo | null = null;
  let pendingDurationSec: number | null = null;
  let pendingDiscontinuity = false;
  let pendingByteRange: string | null = null;
  let dseqCursor: number | null = null;
  let msnCursor: number | null = null;
  let currentPdt: number | null = null;
  let lastByteRange: ByteRange | null = null;

  for (const { number: lineNumber, body } of lines) {
    if (body === '#EXTM3U') continue;
    if (!body.startsWith('#')) {
      // Segment URI
      if (msnCursor === null) {
        msnCursor = mediaSequence;
        dseqCursor = discontinuitySequence + (pendingDiscontinuity ? 1 : 0);
      } else if (pendingDiscontinuity) {
        dseqCursor = (dseqCursor ?? discontinuitySequence) + 1;
      }
      const msn: number = msnCursor;
      const dseq: number = dseqCursor ?? discontinuitySequence;
      if (pendingDurationSec === null) {
        warn(lineNumber, body, 'segment URI without preceding #EXTINF duration');
      }
      let range: ByteRange | null = null;
      if (pendingByteRange !== null) {
        const parsed = parseByteRange(
          pendingByteRange,
          lastByteRange?.offset ?? null,
          lastByteRange?.length ?? null
        );
        if (parsed.start === null || !Number.isFinite(parsed.length) || parsed.length < 0) {
          warn(lineNumber, body, `invalid #EXT-X-BYTERANGE: ${pendingByteRange}`);
        } else {
          range = { offset: parsed.start, length: parsed.length };
          lastByteRange = range;
        }
        pendingByteRange = null;
      }
      const durationSec = pendingDurationSec ?? 0;
      const durationMs = msOfSeconds(durationSec);
      const pdtStart = currentPdt;
      const pdtEnd = currentPdt === null ? null : currentPdt + durationMs;
      segments.push({
        msn,
        uri: resolveUri(baseUri, body),
        byteRange: range,
        durationMs,
        pdtStart,
        pdtEnd,
        key: currentKey,
        map: currentMap,
        discontinuity: pendingDiscontinuity,
        dseq
      });
      if (currentPdt !== null) currentPdt = currentPdt + durationMs;
      pendingDurationSec = null;
      pendingDiscontinuity = false;
      msnCursor = msn + 1;
      dseqCursor = dseq;
      continue;
    }

    const { name, value } = tagOf(body);
    switch (name) {
      case '#EXT-X-VERSION': {
        const v = value === null ? NaN : Number(value);
        if (Number.isInteger(v)) version = v;
        else warn(lineNumber, body, 'invalid #EXT-X-VERSION');
        break;
      }
      case '#EXT-X-TARGETDURATION': {
        const d = value === null ? NaN : Number(value);
        if (Number.isInteger(d) && d >= 0) targetDurationSec = d;
        else warn(lineNumber, body, 'invalid #EXT-X-TARGETDURATION');
        break;
      }
      case '#EXT-X-MEDIA-SEQUENCE': {
        const s = value === null ? NaN : Number(value);
        if (Number.isInteger(s) && s >= 0) mediaSequence = s;
        else warn(lineNumber, body, 'invalid #EXT-X-MEDIA-SEQUENCE');
        break;
      }
      case '#EXT-X-DISCONTINUITY-SEQUENCE': {
        const s = value === null ? NaN : Number(value);
        if (Number.isInteger(s) && s >= 0) discontinuitySequence = s;
        else warn(lineNumber, body, 'invalid #EXT-X-DISCONTINUITY-SEQUENCE');
        break;
      }
      case '#EXT-X-ALLOW-CACHE':
        allowCache = value === 'YES';
        break;
      case '#EXT-X-I-FRAMES-ONLY':
        iFrameOnly = true;
        break;
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        independentSegments = true;
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        if (value === 'EVENT') playlistType = 'EVENT';
        else if (value === 'VOD') playlistType = 'VOD';
        else if (value !== null) warn(lineNumber, body, `unknown #EXT-X-PLAYLIST-TYPE=${value}`);
        break;
      case '#EXT-X-ENDLIST':
        endList = true;
        break;
      case '#EXT-X-SERVER-CONTROL': {
        if (value !== null) {
          const a = parseAttrList(value);
          serverCanBlockReload = attrEnum(a, 'CAN-BLOCK-RELOAD') === 'YES';
          const skip = attrNumber(a, 'CAN-SKIP-UNTIL');
          serverCanSkipUntil = skip === null ? null : skip;
          const hb = attrNumber(a, 'HOLD-BACK');
          serverHoldBack = hb === null ? null : hb;
          const phb = attrNumber(a, 'PART-HOLD-BACK');
          serverPartHoldBack = phb === null ? null : phb;
        }
        break;
      }
      case '#EXTINF': {
        if (value === null) {
          warn(lineNumber, body, '#EXTINF without value');
          break;
        }
        const comma = value.indexOf(',');
        const durRaw = comma === -1 ? value : value.slice(0, comma);
        const d = Number(durRaw);
        if (!Number.isFinite(d) || d < 0) {
          warn(lineNumber, body, `invalid #EXTINF duration: ${durRaw}`);
          pendingDurationSec = null;
        } else {
          pendingDurationSec = d;
        }
        break;
      }
      case '#EXT-X-DISCONTINUITY':
        pendingDiscontinuity = true;
        break;
      case '#EXT-X-PROGRAM-DATE-TIME': {
        const t = value === null ? null : parseIsoDate(value);
        if (t === null) warn(lineNumber, body, 'invalid #EXT-X-PROGRAM-DATE-TIME');
        else currentPdt = t;
        break;
      }
      case '#EXT-X-BYTERANGE':
        if (value === null) warn(lineNumber, body, '#EXT-X-BYTERANGE without value');
        else pendingByteRange = value;
        break;
      case '#EXT-X-KEY': {
        if (value === null) {
          warn(lineNumber, body, '#EXT-X-KEY without attribute list');
          break;
        }
        const a = parseAttrList(value);
        const method = attrEnum(a, 'METHOD') ?? '';
        if (method === '' ) {
          warn(lineNumber, body, '#EXT-X-KEY missing METHOD');
          break;
        }
        if (method === 'NONE') {
          currentKey = null;
        } else {
          const uri = attrString(a, 'URI');
          const ivRaw = attrString(a, 'IV');
          currentKey = {
            method,
            uri,
            iv: ivRaw === null ? null : normalizeIv(ivRaw),
            keyFormat: attrString(a, 'KEYFORMAT'),
            keyFormatVersions: attrString(a, 'KEYFORMATVERSIONS')
          };
        }
        break;
      }
      case '#EXT-X-MAP': {
        if (value === null) {
          warn(lineNumber, body, '#EXT-X-MAP without attribute list');
          break;
        }
        const a = parseAttrList(value);
        const uri = attrString(a, 'URI');
        if (uri === null) {
          warn(lineNumber, body, '#EXT-X-MAP missing URI');
          break;
        }
        const br = attrString(a, 'BYTERANGE');
        let mapRange: ByteRange | null = null;
        if (br !== null) {
          const parsed = parseByteRange(br, null, null);
          if (parsed.start !== null && Number.isFinite(parsed.length)) {
            mapRange = { offset: parsed.start, length: parsed.length };
          } else {
            warn(lineNumber, body, `invalid #EXT-X-MAP BYTERANGE: ${br}`);
          }
        }
        currentMap = { uri: resolveUri(baseUri, uri), byteRange: mapRange };
        break;
      }
      default:
        // #EXT-X-DATERANGE, #EXT-X-SKIP, part tags, etc. are not needed to
        // determine playable windows and are intentionally ignored.
        break;
    }
  }
  if (targetDurationSec === null) {
    warn(0, '', 'media playlist is missing #EXT-X-TARGETDURATION');
  }

  const type: MediaPlaylist['type'] =
    playlistType === 'EVENT' ? 'event' : playlistType === 'VOD' ? 'vod' : 'live';

  return {
    resolvedUri: baseUri,
    version,
    targetDurationSec,
    mediaSequence,
    discontinuitySequence,
    allowCache,
    iFrameOnly,
    independentSegments,
    type,
    endList,
    serverControl: {
      canBlockReload: serverCanBlockReload,
      canSkipUntil: serverCanSkipUntil,
      holdBack: serverHoldBack,
      partHoldBack: serverPartHoldBack
    },
    segments
  };
}
