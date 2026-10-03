import {
  Diagnostic,
  EventTruncatedDiagnostic,
  GapDiagnostic,
  IdentityConflictDiagnostic,
  MasterPlaylist,
  MediaPlaylist,
  PlaylistMode,
  Segment,
  ServerControl,
  UndeclaredRenditionDiagnostic,
  VariantRendition,
  VodChangedDiagnostic,
  DiscontinuitySequenceMismatchDiagnostic,
} from './types.js';
import { identityDifference, renditionId } from './identity.js';

export interface TrackerOptions {
  /**
   * How many past snapshots to retain per rendition (including the current
   * frontier) for conflict analysis. Older ones are dropped FIFO.
   */
  maxSnapshotsPerRendition?: number;
  /** Hard cap on retained diagnostics. Earliest entries are dropped first. */
  maxDiagnostics?: number;
}

export interface IngestResult {
  rendition: string;
  /** Whether this ingest became (or refreshed) the current frontier. */
  accepted: boolean;
  /** True when the accepted frontier exposed new media (reload streak reset). */
  changed: boolean;
  diagnostics: Diagnostic[];
}

interface StoredSnapshot {
  feedSeq: number;
  fetchedAt: number;
  playlist: MediaPlaylist;
}

export interface RenditionStateView {
  id: string;
  uri: string;
  declared: VariantRendition | null;
  mode: PlaylistMode;
  ended: boolean;
  independentSegments: boolean;
  serverControl: ServerControl;
  targetDurationMs: number | null;
  firstMsn: number | null;
  lastMsn: number | null;
  frontierFeedSeq: number;
  frontierFetchedAt: number;
  unchangedStreak: number;
  segments: Segment[];
}

class RenditionState {
  readonly id: string;
  latestUri: string;
  declared: VariantRendition | null = null;
  frontier: StoredSnapshot | null = null;
  history: StoredSnapshot[] = [];
  streak = 0;
  undeclaredReported = false;

  constructor(id: string, uri: string) {
    this.id = id;
    this.latestUri = uri;
  }
}

export class HlsWindowTracker {
  private readonly renditions = new Map<string, RenditionState>();
  private readonly declared = new Map<string, VariantRendition>();
  private readonly diagnostics: Diagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  private feedCounter = 0;
  private latestMaster: MasterPlaylist | null = null;
  private readonly maxSnapshots: number;
  private readonly maxDiagnostics: number;

  constructor(options: TrackerOptions = {}) {
    this.maxSnapshots = options.maxSnapshotsPerRendition ?? 12;
    this.maxDiagnostics = options.maxDiagnostics ?? 1000;
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  /**
   * Feed the latest master playlist. Returns the parse warnings the parser
   * tolerated. Rendition declarations are merged by stable identity.
   */
  ingestMaster(playlist: MasterPlaylist): { diagnostics: Diagnostic[] } {
    this.feedCounter += 1;
    this.latestMaster = playlist;
    const next = new Map<string, VariantRendition>();
    for (const r of playlist.renditions) {
      const id = renditionId(r.uri);
      next.set(id, r);
      const state = this.getOrCreate(r.uri);
      state.declared = r;
    }
    this.declared.clear();
    for (const [id, r] of next) this.declared.set(id, r);
    return { diagnostics: [] };
  }

  /**
   * Feed a media playlist snapshot.
   *
   * @param playlist parsed media playlist.
   * @param fetchedAtMs when the caller finished fetching it (integer ms).
   *   Drives refresh scheduling; never read from the system clock.
   */
  ingestMedia(playlist: MediaPlaylist, fetchedAtMs: number): IngestResult {
    if (playlist.kind !== 'media') {
      throw new TypeError('ingestMedia expects a media playlist');
    }
    const fetchedAt = Math.trunc(fetchedAtMs);
    this.feedCounter += 1;
    const id = renditionId(playlist.uri);
    const state = this.getOrCreate(playlist.uri);
    state.latestUri = playlist.uri;

    const produced: Diagnostic[] = [];

    if (state.declared === null && !state.undeclaredReported) {
      state.undeclaredReported = true;
      const d: UndeclaredRenditionDiagnostic = {
        code: 'undeclared-rendition',
        message: `media playlist ${id} is not declared by any master playlist`,
        rendition: id,
      };
      produced.push(d);
    }

    const incoming: StoredSnapshot = {
      feedSeq: this.feedCounter,
      fetchedAt,
      playlist,
    };
    const frontier = state.frontier;

    if (frontier === null) {
      state.frontier = incoming;
      state.streak = 0;
      return {
        rendition: id,
        accepted: true,
        changed: playlist.segments.length > 0 || playlist.endlist,
        diagnostics: this.commitDiagnostics(produced),
      };
    }

    // A playlist that carried ENDLIST is terminal. Anything arriving later
    // that does not match it byte-for-identity is a contradiction.
    if (frontier.playlist.endlist) {
      const contradiction = this.findVodDifference(
        frontier.playlist,
        playlist,
      );
      if (contradiction === null) {
        // Identical re-delivery of the terminal playlist. A copy that is
        // older than the frontier's fetch time is a stale duplicate and must
        // not move the scheduling anchor.
        if (fetchedAt < frontier.fetchedAt) {
          return {
            rendition: id,
            accepted: false,
            changed: false,
            diagnostics: this.commitDiagnostics(produced),
          };
        }
        state.streak += 1;
        state.frontier = { ...frontier, fetchedAt, feedSeq: this.feedCounter };
        return {
          rendition: id,
          accepted: true,
          changed: false,
          diagnostics: this.commitDiagnostics(produced),
        };
      }
      produced.push(contradiction);
      return {
        rendition: id,
        accepted: false,
        changed: false,
        diagnostics: this.commitDiagnostics(produced),
      };
    }

    const cmp = compareSnapshots(incoming, frontier);

    if (cmp < 0) {
      // An older snapshot arrived late (network reordering). It must never
      // move the playable window backwards; still inspect it for conflicting
      // observations of shared MSNs.
      produced.push(...this.findIdentityConflicts(id, frontier.playlist, playlist));
      return {
        rendition: id,
        accepted: false,
        changed: false,
        diagnostics: this.commitDiagnostics(produced),
      };
    }

    const sameContent =
      cmp === 0 &&
      playlist.mediaSequence === frontier.playlist.mediaSequence &&
      playlist.segments.length === frontier.playlist.segments.length &&
      playlist.endlist === frontier.playlist.endlist &&
      playlist.discontinuitySequence ===
        frontier.playlist.discontinuitySequence &&
      this.findIdentityConflicts(id, frontier.playlist, playlist).length === 0;

    if (sameContent && fetchedAt < frontier.fetchedAt) {
      // Byte-for-byte identical copy that is older by fetch time too: a
      // duplicated delivery of an older response. Drop it without touching
      // the streak or the refresh anchor.
      return {
        rendition: id,
        accepted: false,
        changed: false,
        diagnostics: this.commitDiagnostics(produced),
      };
    }

    // cmp >= 0: candidate becomes the new frontier. Run every check first so
    // a single ingest can report several problems atomically.
    const conflicts = this.findIdentityConflicts(
      id,
      frontier.playlist,
      playlist,
    );
    produced.push(
      ...this.checkGap(id, frontier.playlist, playlist),
      ...this.checkEventTruncation(id, frontier.playlist, playlist),
      ...this.checkDiscontinuitySequence(id, frontier.playlist, playlist),
      ...conflicts,
    );

    const unchanged =
      playlist.mediaSequence === frontier.playlist.mediaSequence &&
      playlist.segments.length === frontier.playlist.segments.length &&
      playlist.endlist === frontier.playlist.endlist &&
      playlist.discontinuitySequence ===
        frontier.playlist.discontinuitySequence &&
      conflicts.length === 0;

    this.pushHistory(state, frontier);
    state.frontier = incoming;
    state.streak = unchanged ? state.streak + 1 : 0;

    return {
      rendition: id,
      accepted: true,
      changed: !unchanged,
      diagnostics: this.commitDiagnostics(produced),
    };
  }

  // -------------------------------------------------------------------------
  // Merge checks
  // -------------------------------------------------------------------------

  private checkGap(
    id: string,
    prev: MediaPlaylist,
    next: MediaPlaylist,
  ): GapDiagnostic[] {
    if (prev.segments.length === 0 || next.segments.length === 0) return [];
    const prevLast = prev.segments[prev.segments.length - 1]!.msn;
    const nextFirst = next.segments[0]!.msn;
    const missingStart = prevLast + 1;
    if (nextFirst <= missingStart) return [];

    const fromMsn = missingStart;
    const toMsn = nextFirst - 1;
    // The server removed more segments at once than the previous window even
    // contained: that is not ordinary sliding, call it a sequence jump.
    const jumpLike = toMsn - fromMsn + 1 >= prev.segments.length;
    const code = jumpLike ? 'sequence-jump' : 'window-slide';
    const d: GapDiagnostic = {
      code,
      message:
        `${code === 'sequence-jump' ? 'media sequence jumped' : 'live window slid before refresh'}: ` +
        `MSN ${fromMsn}..${toMsn} (${toMsn - fromMsn + 1} segments) ` +
        `confirmed missing on ${id} between MSN ${prevLast} and ${nextFirst}`,
      rendition: id,
      fromMsn,
      toMsn,
      count: toMsn - fromMsn + 1,
      previousMsn: prevLast,
      nextMsn: nextFirst,
    };
    return [d];
  }

  private checkEventTruncation(
    id: string,
    prev: MediaPlaylist,
    next: MediaPlaylist,
  ): EventTruncatedDiagnostic[] {
    if (prev.mode !== 'event' || prev.endlist) return [];
    const prevFirst = prev.mediaSequence;
    const nextFirst = next.mediaSequence;
    if (nextFirst <= prevFirst) return [];
    return [
      {
        code: 'event-truncated',
        message:
          `EVENT playlist ${id} dropped MSN ${prevFirst}..${nextFirst - 1}; ` +
          'EVENT playlists must only append',
        rendition: id,
        previousFirstMsn: prevFirst,
        incomingFirstMsn: nextFirst,
      },
    ];
  }

  private checkDiscontinuitySequence(
    id: string,
    prev: MediaPlaylist,
    next: MediaPlaylist,
  ): DiscontinuitySequenceMismatchDiagnostic[] {
    if (prev.segments.length === 0 || next.segments.length === 0) return [];
    const prevLast = prev.segments[prev.segments.length - 1]!.msn;
    const nextFirst = next.segments[0]!.msn;
    // Across a real gap the server may have inserted discontinuities we never
    // saw; the gap diagnostic already covers the uncertainty.
    if (nextFirst > prevLast + 1) return [];

    // The header counts sections that start before the first segment. When
    // the new first MSN is inside the previous window we know its section
    // directly; on a pure append it is the previous tail's section plus a
    // marker the new playlist carries on its own first segment.
    let expected: number;
    const known = prev.segments.find((s) => s.msn === nextFirst);
    if (known !== undefined) {
      expected = known.discontinuitySequence;
    } else {
      const prevTail = prev.segments[prev.segments.length - 1]!;
      expected =
        prevTail.discontinuitySequence +
        (next.segments[0]!.discontinuity ? 1 : 0);
    }

    const actual = next.discontinuitySequence;
    if (expected === actual) return [];
    return [
      {
        code: 'discontinuity-sequence-mismatch',
        message:
          `discontinuity sequence of ${id} changed to ${actual} at MSN ${nextFirst}; ` +
          `expected ${expected} from contiguous history`,
        rendition: id,
        expected,
        actual,
        atMsn: nextFirst,
      },
    ];
  }

  private findIdentityConflicts(
    id: string,
    prev: MediaPlaylist,
    next: MediaPlaylist,
  ): IdentityConflictDiagnostic[] {
    const out: IdentityConflictDiagnostic[] = [];
    if (prev.segments.length === 0 || next.segments.length === 0) return out;
    const byMsn = new Map<number, Segment>();
    for (const seg of prev.segments) byMsn.set(seg.msn, seg);
    for (const inc of next.segments) {
      const existing = byMsn.get(inc.msn);
      if (existing === undefined) continue;
      const diff = identityDifference(existing, inc);
      if (diff === null) continue;
      out.push({
        code: 'segment-identity-conflict',
        message:
          `MSN ${inc.msn} on ${id} appears with a different ${diff}: ` +
          `${existing.uri} vs ${inc.uri}`,
        rendition: id,
        msn: inc.msn,
        existingUri: existing.uri,
        incomingUri: inc.uri,
        difference: diff,
      });
    }
    return out;
  }

  private findVodDifference(
    terminal: MediaPlaylist,
    incoming: MediaPlaylist,
  ): VodChangedDiagnostic | null {
    const id = renditionId(incoming.uri);
    const termFirst = terminal.mediaSequence;
    const termLast =
      terminal.segments.length === 0
        ? termFirst - 1
        : terminal.segments[terminal.segments.length - 1]!.msn;
    const incFirst = incoming.mediaSequence;
    const incLast =
      incoming.segments.length === 0
        ? incFirst - 1
        : incoming.segments[incoming.segments.length - 1]!.msn;

    if (incFirst !== termFirst || incLast !== termLast) {
      return {
        code: 'vod-content-changed',
        message:
          `terminal playlist ${id} changed its sequence range ` +
          `[${termFirst}..${termLast}] -> [${incFirst}..${incLast}]`,
        rendition: id,
        msn: null,
        difference: 'sequence',
      };
    }
    const conflicts = this.findIdentityConflicts(id, terminal, incoming);
    if (conflicts.length > 0) {
      return {
        code: 'vod-content-changed',
        message:
          `terminal playlist ${id} republished MSN ${conflicts[0]!.msn} ` +
          `with a different ${conflicts[0]!.difference}`,
        rendition: id,
        msn: conflicts[0]!.msn,
        difference: 'segment-identity',
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getRenditionIds(): string[] {
    return [...this.renditions.keys()].sort();
  }

  getMaster(): MasterPlaylist | null {
    return this.latestMaster;
  }

  getRendition(id: string): RenditionStateView | null {
    const s = this.renditions.get(id);
    if (!s || !s.frontier) return null;
    return this.toView(s);
  }

  /** Playable state for every rendition that has produced a frontier. */
  getPlayableRanges(): RenditionStateView[] {
    return this.getRenditionIds()
      .map((id) => this.renditions.get(id)!)
      .filter((s) => s.frontier !== null)
      .map((s) => this.toView(s));
  }

  /** Confirmed missing MSN runs, oldest first per rendition. */
  getMissingSegments(): GapDiagnostic[] {
    return this.diagnostics
      .filter((d): d is GapDiagnostic => d.code === 'window-slide' || d.code === 'sequence-jump')
      .slice()
      .sort((a, b) => {
        if (a.rendition !== b.rendition) return a.rendition < b.rendition ? -1 : 1;
        return a.fromMsn - b.fromMsn;
      });
  }

  /** Every diagnostic accumulated so far in deterministic insertion order. */
  getDiagnostics(): Diagnostic[] {
    return this.diagnostics.slice();
  }

  private toView(s: RenditionState): RenditionStateView {
    const snap = s.frontier!;
    const p = snap.playlist;
    const last =
      p.segments.length === 0
        ? null
        : p.segments[p.segments.length - 1]!.msn;
    return {
      id: s.id,
      uri: s.latestUri,
      declared: s.declared,
      mode: p.mode,
      ended: p.endlist,
      independentSegments: p.independentSegments,
      serverControl: p.serverControl,
      targetDurationMs:
        p.targetDurationSec === null
          ? null
          : Math.round(p.targetDurationSec * 1000),
      firstMsn: p.segments.length === 0 ? null : p.segments[0]!.msn,
      lastMsn: last,
      frontierFeedSeq: snap.feedSeq,
      frontierFetchedAt: snap.fetchedAt,
      unchangedStreak: s.streak,
      segments: p.segments.map((seg) => ({ ...seg })),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getOrCreate(uri: string): RenditionState {
    const id = renditionId(uri);
    let s = this.renditions.get(id);
    if (!s) {
      s = new RenditionState(id, uri);
      this.renditions.set(id, s);
    }
    return s;
  }

  private pushHistory(
    state: RenditionState,
    snapshot: StoredSnapshot,
  ): void {
    state.history.push(snapshot);
    const limit = Math.max(1, this.maxSnapshots - 1);
    while (state.history.length > limit) state.history.shift();
  }

  private commitDiagnostics(fresh: Diagnostic[]): Diagnostic[] {
    const committed: Diagnostic[] = [];
    for (const d of fresh) {
      const key = diagnosticKey(d);
      if (this.diagnosticKeys.has(key)) continue;
      this.diagnosticKeys.add(key);
      this.diagnostics.push(d);
      committed.push(d);
      if (this.diagnostics.length > this.maxDiagnostics) {
        const dropped = this.diagnostics.shift()!;
        this.diagnosticKeys.delete(diagnosticKey(dropped));
      }
    }
    return committed;
  }
}

/**
 * Order snapshots by content, NOT by arrival time.
 *
 * Tuple: latest tail MSN, endlist presence, furthest slid head, feed sequence.
 * This makes a late-arriving older playlist compare as older regardless of
 * network order.
 */
/**
 * Order snapshots by content, NOT by arrival time or fetch timestamp.
 *
 * Tuple: latest tail MSN, endlist presence, furthest slid head. Returns 0
 * when the two snapshots describe the same window — arrival order must never
 * break that tie (a late duplicate is still a duplicate).
 */
function compareSnapshots(
  a: StoredSnapshot,
  b: StoredSnapshot,
): number {
  const aLast = lastMsnOf(a.playlist);
  const bLast = lastMsnOf(b.playlist);
  if (aLast !== bLast) return aLast > bLast ? 1 : -1;
  if (a.playlist.endlist !== b.playlist.endlist) {
    return a.playlist.endlist ? 1 : -1;
  }
  if (a.playlist.mediaSequence !== b.playlist.mediaSequence) {
    return a.playlist.mediaSequence > b.playlist.mediaSequence ? 1 : -1;
  }
  return 0;
}

function lastMsnOf(p: MediaPlaylist): number {
  if (p.segments.length === 0) return p.mediaSequence - 1;
  return p.segments[p.segments.length - 1]!.msn;
}

function diagnosticKey(d: Diagnostic): string {
  switch (d.code) {
    case 'window-slide':
    case 'sequence-jump':
      return `${d.code}:${d.rendition}:${d.fromMsn}:${d.toMsn}`;
    case 'segment-identity-conflict':
      return `${d.code}:${d.rendition}:${d.msn}:${d.difference}`;
    case 'discontinuity-sequence-mismatch':
      return `${d.code}:${d.rendition}:${d.atMsn}:${d.actual}`;
    case 'event-truncated':
      return `${d.code}:${d.rendition}:${d.previousFirstMsn}:${d.incomingFirstMsn}`;
    case 'vod-content-changed':
      return `${d.code}:${d.rendition}:${d.difference}:${d.msn ?? '-'}`;
    case 'undeclared-rendition':
      return `${d.code}:${d.rendition}`;
    case 'rendition-discontinuity-mismatch':
      return `${d.code}:${d.rendition}:${d.msn}:${d.actualDiscontinuity}`;
  }
}
