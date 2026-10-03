/**
 * Catalog: ingest master/media playlists, merge windows per rendition,
 * detect confirmed gaps and locatable diagnostics, answer playable queries.
 *
 * Monotonicity guarantee: an out-of-order (older) playlist can never move a
 * rendition's window backwards; it is rejected with a 'stale-playlist'
 * diagnostic instead.
 */
import {
  Diagnostic,
  Gap,
  MasterPlaylist,
  MediaPlaylist,
  PlayableRendition,
  PlayableReport,
  Segment,
  VariantStream
} from './types.js';
import { ParseWarning } from './parser.js';
import { sortedMapEntries } from './util.js';

export type RenditionKind = PlayableRendition['kind'];

export interface RenditionDescriptor {
  id: string;
  uri: string;
  kind: RenditionKind;
  label: string;
  /** Variant ids (v0, ...) served by this rendition's media playlist. */
  variantRefs: string[];
}

export interface RenditionState {
  descriptor: RenditionDescriptor;
  /** Monotonic per accepted snapshot. */
  revision: number;
  segments: Map<number, Segment>;
  /**
   * msns listed by the most recently accepted snapshot. This is the
   * authoritative "what can play right now" set: the cumulative `segments`
   * map is retained only for history/recovery and dseq context.
   */
  latestMsns: Set<number>;
  windowTailMsn: number | null;
  windowHeadMsn: number | null;
  latest: MediaPlaylist | null;
  firstSeenMs: number | null;
  lastIngestMs: number | null;
  /** msn -> gap record, for msns that were confirmed missing. */
  gaps: Map<number, GapRecord>;
  /** Consecutive identical ingest count (for reload backoff). */
  unchangedCount: number;
  everEnded: boolean;
  /** Generations in which each snapshot was accepted (index by revision-1). */
  acceptedGenerations: number[];
  /** Generations in which unchanged ingests arrived. */
  unchangedGenerations: number[];
}

interface GapRecord {
  msn: number;
  detectedInGeneration: number;
  recoveredInGeneration: number | null;
  reason: Gap['reason'];
  severity: Gap['severity'];
  dseqBefore: number | null;
  dseqAfter: number | null;
}

export interface MergeInput {
  playlist: MediaPlaylist;
  fetchedAtMs: number;
  generation: number;
}

export interface MergeOutcome {
  state: RenditionState;
  diagnostics: Diagnostic[];
  accepted: boolean;
  changed: boolean;
}

const KIND_PREFIX: Record<RenditionKind, string> = {
  variant: 'v',
  audio: 'a',
  video: 'd',
  subtitles: 's',
  'closed-captions': 'c'
};

function variantLabel(v: VariantStream): string {
  const parts: string[] = [];
  if (v.resolution) parts.push(`${v.resolution.height}p`);
  if (v.frameRate) parts.push(`${v.frameRate}`);
  parts.push(`${v.bandwidth}`);
  return parts.join('@');
}

export class Catalog {
  readonly renditions = new Map<string, RenditionState>();
  private byUri = new Map<string, RenditionState>();
  private standaloneCounters: Partial<Record<RenditionKind, number>> = {};

  generation = 0;
  masterUri: string | null = null;
  latestMaster: MasterPlaylist | null = null;
  /** URIs of every media playlist referenced by the most recent master. */
  masterReferencedUris: Set<string> = new Set();

  ingestMaster(master: MasterPlaylist, generation: number, fetchedAtMs: number): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const previous = this.latestMaster;
    this.generation = generation;
    this.masterUri = master.resolvedUri;
    this.latestMaster = master;

    const next = new Map<string, RenditionDescriptor>();
    const variantCounters = new Map<RenditionKind, number>();

    const nextId = (kind: RenditionKind): string => {
      const n = variantCounters.get(kind) ?? 0;
      variantCounters.set(kind, n + 1);
      return `${KIND_PREFIX[kind]}${n}`;
    };

    const referenced = new Set<string>();

    // Variants first (they define the main media playlists).
    master.variants.forEach((v, index) => {
      const stableId = `v${index}`;
      v.variantId = stableId;
      referenced.add(v.resolvedUri);
      const existing = this.byUri.get(v.resolvedUri);
      if (existing) {
        existing.descriptor.variantRefs = uniqueSorted(
          existing.descriptor.variantRefs.concat(stableId)
        );
        next.set(v.resolvedUri, existing.descriptor);
      } else {
        const descriptor: RenditionDescriptor = {
          id: nextId('variant'),
          uri: v.resolvedUri,
          kind: 'variant',
          label: variantLabel(v),
          variantRefs: [stableId]
        };
        next.set(v.resolvedUri, descriptor);
        this.register(descriptor);
      }
    });

    // EXT-X-MEDIA renditions.
    for (const m of master.media) {
      if (m.resolvedUri === null) continue; // CLOSED-CAPTIONS without URI
      referenced.add(m.resolvedUri);
      const existing = this.byUri.get(m.resolvedUri);
      if (existing) {
        next.set(m.resolvedUri, existing.descriptor);
      } else {
        const descriptor: RenditionDescriptor = {
          id: nextId(m.type),
          uri: m.resolvedUri,
          kind: m.type,
          label: m.name,
          variantRefs: []
        };
        next.set(m.resolvedUri, descriptor);
        this.register(descriptor);
      }
    }

    // Diagnostics for URIs that vanished compared with the previous master.
    if (previous) {
      const previousUris = new Set<string>();
      for (const v of previous.variants) previousUris.add(v.resolvedUri);
      for (const m of previous.media) if (m.resolvedUri) previousUris.add(m.resolvedUri);
      const removed: string[] = [];
      for (const u of previousUris) if (!referenced.has(u)) removed.push(u);
      removed.sort();
      for (const uri of removed) {
        diagnostics.push({
          code: 'master-variant-uri-changed',
          severity: 'warning',
          playlistUri: master.resolvedUri,
          msn: null,
          message: `rendition playlist ${uri} is no longer referenced by the master playlist`,
          details: { removedUri: uri, fetchedAtMs },
          generation
        });
      }
    }

    this.masterReferencedUris = referenced;
    return diagnostics;
  }

  private register(descriptor: RenditionDescriptor): void {
    const state: RenditionState = {
      descriptor,
      revision: 0,
      segments: new Map(),
      latestMsns: new Set(),
      windowTailMsn: null,
      windowHeadMsn: null,
      latest: null,
      firstSeenMs: null,
      lastIngestMs: null,
      gaps: new Map(),
      unchangedCount: 0,
      everEnded: false,
      acceptedGenerations: [],
      unchangedGenerations: []
    };
    this.renditions.set(descriptor.id, state);
    this.byUri.set(descriptor.uri, state);
  }

  private standaloneId(uri: string): RenditionState {
    const existing = this.byUri.get(uri);
    if (existing) return existing;
    const n = this.standaloneCounters.variant ?? 0;
    this.standaloneCounters.variant = n + 1;
    const descriptor: RenditionDescriptor = {
      id: `pl${n}`,
      uri,
      kind: 'variant',
      label: uri,
      variantRefs: []
    };
    this.register(descriptor);
    return this.byUri.get(uri)!;
  }

  ingestMedia(input: MergeInput): MergeOutcome {
    const { playlist, fetchedAtMs, generation } = input;
    this.generation = generation;
    const state = this.byUri.get(playlist.resolvedUri) ?? this.standaloneId(playlist.resolvedUri);
    const diagnostics: Diagnostic[] = [];

    if (state.firstSeenMs === null) state.firstSeenMs = fetchedAtMs;
    state.lastIngestMs = fetchedAtMs;

    // A closed VOD playlist never changes.
    if (state.everEnded && state.latest?.type === 'vod') {
      diagnostics.push(staleDiagnostic(playlist.resolvedUri, generation, fetchedAtMs, 'vod replay'));
      state.unchangedCount += 1;
      state.unchangedGenerations.push(generation);
      return { state, diagnostics, accepted: false, changed: false };
    }

    const prevTail = state.windowTailMsn;
    const prevHead = state.windowHeadMsn;
    const newSegments = playlist.segments;
    const newTail = newSegments.length > 0 ? newSegments[0]!.msn : null;
    const newHead = newSegments.length > 0 ? newSegments[newSegments.length - 1]!.msn : null;

    if (newSegments.length === 0) {
      if (state.revision === 0) {
        diagnostics.push({
          code: 'empty-media-playlist',
          severity: 'warning',
          playlistUri: playlist.resolvedUri,
          msn: null,
          message: 'media playlist contains no segments',
          details: { fetchedAtMs },
          generation
        });
      }
      state.unchangedCount += 1;
      state.unchangedGenerations.push(generation);
      return { state, diagnostics, accepted: false, changed: false };
    }

    // Monotonicity: windows never move backwards.
    if (state.revision > 0 && prevHead !== null) {
      if (newTail !== null && prevTail !== null && newTail < prevTail) {
        diagnostics.push(
          staleDiagnostic(
            playlist.resolvedUri,
            generation,
            fetchedAtMs,
            `tail moved backwards ${prevTail} -> ${newTail}`
          )
        );
        state.unchangedCount += 1;
        state.unchangedGenerations.push(generation);
        return { state, diagnostics, accepted: false, changed: false };
      }
      if ((newHead ?? -1) < prevHead) {
        diagnostics.push(
          staleDiagnostic(
            playlist.resolvedUri,
            generation,
            fetchedAtMs,
            `head moved backwards ${prevHead} -> ${newHead ?? -1}`
          )
        );
        state.unchangedCount += 1;
        state.unchangedGenerations.push(generation);
        return { state, diagnostics, accepted: false, changed: false };
      }
      // EVENT playlists grow from the same tail; a shrinking EVENT window is
      // illegal (RFC 8216 §6.2.1) even though its head advanced.
      if (
        state.latest?.type === 'event' &&
        !state.everEnded &&
        newTail !== null &&
        prevTail !== null &&
        newTail > prevTail
      ) {
        diagnostics.push({
          code: 'event-window-shrank',
          severity: 'error',
          playlistUri: playlist.resolvedUri,
          msn: newTail,
          message: `EVENT playlist tail advanced ${prevTail} -> ${newTail}; earlier segments must not be removed`,
          details: { prevTail, newTail, fetchedAtMs },
          generation
        });
        // Merge anyway, but remember the violation.
      }
    }

    // Content identity checks on overlapping msns + dseq sanity.
    let dseqError: { actual: number; expected: number; msn: number } | null = null;
    for (const seg of newSegments) {
      const old = state.segments.get(seg.msn);
      if (old && !sameContent(old, seg)) {
        diagnostics.push({
          code: 'same-msn-conflict',
          severity: 'error',
          playlistUri: playlist.resolvedUri,
          msn: seg.msn,
          message: `segment ${seg.msn} changed identity (uri/byte-range/key/map) between reloads`,
          details: {
            previousUri: old.uri,
            uri: seg.uri,
            previousByteRange: formatRange(old.byteRange),
            byteRange: formatRange(seg.byteRange)
          },
          generation
        });
        continue;
      }
      if (old && old.dseq !== seg.dseq && dseqError === null) {
        dseqError = { actual: seg.dseq, expected: old.dseq, msn: seg.msn };
      }
    }
    if (dseqError) {
      diagnostics.push({
        code: 'dseq-mismatch',
        severity: 'error',
        playlistUri: playlist.resolvedUri,
        msn: dseqError.msn,
        message: `discontinuity sequence for msn ${dseqError.msn} changed ${dseqError.expected} -> ${dseqError.actual} between reloads`,
        details: {
          msn: dseqError.msn,
          expectedDseq: dseqError.expected,
          actualDseq: dseqError.actual
        },
        generation
      });
    }

    // Merge into cumulative history; the latest snapshot's msn set is the
    // authoritative playable set.
    let added = 0;
    for (const seg of newSegments) {
      if (!state.segments.has(seg.msn)) added += 1;
      state.segments.set(seg.msn, seg);
    }
    state.latestMsns = new Set(newSegments.map((s) => s.msn));
    state.windowTailMsn = newTail;
    state.windowHeadMsn = newHead;
    state.latest = playlist;
    const newlyEnded = playlist.endList && !state.everEnded;
    if (playlist.endList) state.everEnded = true;

    // Confirmed-gap bookkeeping over the new snapshot.
    this.refreshGaps(state, newSegments, generation);

    const changed = added > 0 || newlyEnded;
    state.revision += 1;
    state.acceptedGenerations.push(generation);
    if (changed) state.unchangedCount = 0;
    else {
      state.unchangedCount += 1;
      state.unchangedGenerations.push(generation);
    }

    // Sequence-jump / window-slide diagnostics for skipped msns.
    if (prevHead !== null && newTail !== null && newTail > prevHead + 1) {
      const count = newTail - prevHead - 1;
      diagnostics.push({
        code: 'sequence-jump',
        severity: 'error',
        playlistUri: playlist.resolvedUri,
        msn: newTail,
        message: `media sequence jumped from ${prevHead} to ${newTail}: ${count} segment(s) skipped`,
        details: { prevHead, newTail, missing: count, reason: 'sequence-jump' },
        generation
      });
      this.recordJumpGap(state, prevHead, newTail, newSegments, generation);
    } else if (prevTail !== null && newTail !== null && newTail > prevTail) {
      const slidOff = newTail - prevTail;
      diagnostics.push({
        code: 'window-slide',
        severity: 'info',
        playlistUri: playlist.resolvedUri,
        msn: newTail - 1,
        message: `sliding window advanced: ${slidOff} segment(s) left the playable window`,
        details: { prevTail, newTail, slidOff },
        generation
      });
    }

    return { state, diagnostics, accepted: true, changed };
  }

  /**
   * Record the confirmed-missing run (prevHead+1 .. newTail-1) created by a
   * reload that jumped over sequence numbers. These sit before the new
   * window tail and are kept as permanent confirmed-gap records.
   */
  private recordJumpGap(
    state: RenditionState,
    prevHead: number,
    newTail: number,
    newSegments: Segment[],
    generation: number
  ): void {
    const afterSeg = newSegments[0] ?? null;
    const beforeSeg = state.segments.get(prevHead) ?? null;
    for (let msn = prevHead + 1; msn <= newTail - 1; msn += 1) {
      const existing = state.gaps.get(msn);
      if (existing && existing.recoveredInGeneration === null) continue;
      state.gaps.set(msn, {
        msn,
        detectedInGeneration: generation,
        recoveredInGeneration: null,
        reason: 'sequence-jump',
        severity: 'error',
        dseqBefore: beforeSeg?.dseq ?? null,
        dseqAfter: afterSeg?.dseq ?? null
      });
    }
  }

  /**
   * A gap is CONFIRMED only when sequence numbers are missing *inside* a
   * single complete playlist snapshot — i.e. the msn is bracketed by listed
   * segments on both sides. Numbers absent past the head or before the tail
   * are ordinary live-window movement and are never guessed as gaps.
   */
  private refreshGaps(
    state: RenditionState,
    newSegments: Segment[],
    generation: number
  ): void {
    const tail = newSegments[0]!.msn;
    const head = newSegments[newSegments.length - 1]!.msn;
    const have = state.latestMsns;

    // Interior gaps expire once filled. Jump gaps (before tail) are retained
    // as permanent records, so only positions beyond the new head expire.
    for (const rec of state.gaps.values()) {
      if (rec.recoveredInGeneration === null && (rec.msn > head || have.has(rec.msn))) {
        rec.recoveredInGeneration = generation;
      }
    }

    // Find maximal missing runs; a run is a confirmed gap only when it is
    // strictly bracketed by listed segments inside this snapshot.
    let msn = tail;
    while (msn <= head) {
      if (have.has(msn)) {
        msn += 1;
        continue;
      }
      const runStart = msn;
      while (msn <= head && !have.has(msn)) msn += 1;
      const runEnd = msn - 1;
      const bracketed = have.has(runStart - 1) && have.has(runEnd + 1);
      if (!bracketed) continue;

      const beforeSeg = state.segments.get(runStart - 1) ?? null;
      const afterSeg = state.segments.get(runEnd + 1) ?? null;
      const reason: Gap['reason'] =
        beforeSeg && afterSeg && afterSeg.dseq < beforeSeg.dseq
          ? 'dseq-mismatch'
          : 'sequence-jump';

      for (let m = runStart; m <= runEnd; m += 1) {
        const existing = state.gaps.get(m);
        if (existing && existing.recoveredInGeneration === null) continue;
        state.gaps.set(m, {
          msn: m,
          detectedInGeneration: generation,
          recoveredInGeneration: null,
          reason,
          severity: 'error',
          dseqBefore: beforeSeg?.dseq ?? null,
          dseqAfter: afterSeg?.dseq ?? null
        });
      }
    }
  }

  warningsToDiagnostics(warnings: ParseWarning[], generation: number, uri: string): Diagnostic[] {
    return warnings.map((w) => ({
      code: 'unparseable-line',
      severity: 'warning' as const,
      playlistUri: uri,
      msn: null,
      message: w.message,
      details: { lineNumber: w.lineNumber, line: w.line },
      generation
    }));
  }

  playableReport(): PlayableReport {
    const renditions: PlayableRendition[] = [];
    for (const [id, state] of sortedMapEntries(this.renditions)) {
      const playlist = state.latest;
      let status: PlayableRendition['status'];
      if (playlist?.type === 'vod') status = 'vod';
      else if (state.everEnded) status = 'ended';
      else if (playlist?.type === 'event') status = 'event';
      else if (state.revision === 0) status = 'unknown';
      else status = 'live';

      const playable: PlayableRendition['playable'] = [];
      if (state.windowTailMsn !== null && state.windowHeadMsn !== null) {
        let runStart: number | null = null;
        let runDseq = 0;
        for (let msn = state.windowTailMsn; msn <= state.windowHeadMsn; msn += 1) {
          const seg = state.latestMsns.has(msn) ? state.segments.get(msn) : undefined;
          if (seg) {
            if (runStart === null) {
              runStart = msn;
              runDseq = seg.dseq;
            }
          } else if (runStart !== null) {
            playable.push({ fromMsn: runStart, toMsn: msn - 1, dseq: runDseq });
            runStart = null;
          }
        }
        if (runStart !== null) {
          playable.push({ fromMsn: runStart, toMsn: state.windowHeadMsn, dseq: runDseq });
        }
      }

      const gaps: Gap[] = [];
      if (state.windowHeadMsn !== null) {
        const active = [...state.gaps.values()]
          .filter((g) => g.recoveredInGeneration === null && g.msn <= state.windowHeadMsn!)
          .sort((a, b) => a.msn - b.msn);
        for (let i = 0; i < active.length; i += 1) {
          const first = active[i]!;
          let to = first.msn;
          while (i + 1 < active.length && active[i + 1]!.msn === to + 1) {
            to = active[i + 1]!.msn;
            i += 1;
          }
          gaps.push({
            playlistUri: state.descriptor.uri,
            fromMsn: first.msn,
            toMsn: to,
            dseqBefore: first.dseqBefore,
            dseqAfter: first.dseqAfter,
            reason: first.reason,
            severity: first.severity,
            detectedInGeneration: first.detectedInGeneration,
            recoveredInGeneration: null
          });
        }
      }

      renditions.push({
        renditionId: id,
        uri: state.descriptor.uri,
        kind: state.descriptor.kind,
        label: state.descriptor.label,
        status,
        windowHeadMsn: state.windowHeadMsn,
        windowTailMsn: state.windowTailMsn,
        playable,
        gaps
      });
    }
    return { generation: this.generation, renditions };
  }
}

function staleDiagnostic(
  uri: string,
  generation: number,
  fetchedAtMs: number,
  reason: string
): Diagnostic {
  return {
    code: 'stale-playlist',
    severity: 'info',
    playlistUri: uri,
    msn: null,
    message: `ignored out-of-order or repeated playlist: ${reason}`,
    details: { fetchedAtMs },
    generation
  };
}

function formatRange(range: Segment['byteRange']): string | null {
  if (!range) return null;
  return `${range.offset}@${range.length}`;
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/**
 * Content identity (RFC 8216): a segment is the same segment only when URI,
 * byte range, encryption key and initialization section all agree.
 */
export function sameContent(a: Segment, b: Segment): boolean {
  return (
    a.uri === b.uri &&
    sameByteRange(a.byteRange, b.byteRange) &&
    sameKey(a.key, b.key) &&
    sameMap(a.map, b.map)
  );
}

function sameByteRange(a: Segment['byteRange'], b: Segment['byteRange']): boolean {
  if (a === null || b === null) return a === b;
  return a.offset === b.offset && a.length === b.length;
}

function sameKey(a: Segment['key'], b: Segment['key']): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.method === b.method &&
    a.uri === b.uri &&
    a.iv === b.iv &&
    a.keyFormat === b.keyFormat &&
    a.keyFormatVersions === b.keyFormatVersions
  );
}

function sameMap(a: Segment['map'], b: Segment['map']): boolean {
  if (a === null || b === null) return a === b;
  return a.uri === b.uri && sameByteRange(a.byteRange, b.byteRange);
}
