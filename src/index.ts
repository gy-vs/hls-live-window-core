/**
 * hls-window-tracker public API.
 *
 * Typical server-side loop:
 *
 *   const tracker = new HlsWindowTracker();
 *   // whenever a playlist download finishes (in any order):
 *   tracker.ingest(text, { uri, fetchedAtMs: Date.now() });
 *   // then query:
 *   tracker.playable();
 *   tracker.alignment();
 *   tracker.refreshPlans(Date.now());
 *   tracker.catchUpPlan({ referenceRenditionId: 'v0' });
 *
 * The tracker never performs IO and never reads the clock itself: all times
 * are passed in by the caller, so identical inputs always yield identical,
 * identically ordered outputs.
 */
import { buildAlignment } from './alignment.js';
import { Catalog } from './catalog.js';
import { buildCatchUpPlan, CatchUpOptions } from './catchup.js';
import { parsePlaylist } from './parser.js';
import { buildRefresh } from './refresh.js';
import {
  AlignmentReport,
  CatchUpPlan,
  Diagnostic,
  PlayableReport,
  RefreshReport
} from './types.js';

export * from './types.js';
export { parsePlaylist, PlaylistParseError } from './parser.js';
export type { ParseWarning } from './parser.js';
export type { CatchUpOptions } from './catchup.js';

export interface IngestOptions {
  /** Absolute URL the text was fetched from; used as the base for relative URIs. */
  uri: string;
  /**
   * Wall-clock-ish fetch timestamp in epoch ms. Caller-supplied on purpose:
   * the library itself never reads the clock.
   */
  fetchedAtMs: number;
}

export interface IngestResult {
  kind: 'master' | 'media';
  /** Monotonic update counter assigned to this ingest. */
  generation: number;
  /** false when a media playlist was rejected as stale (n/a for masters). */
  accepted: boolean;
  /** Whether the ingest changed any known state. */
  changed: boolean;
  diagnostics: Diagnostic[];
}

export class HlsWindowTracker {
  private catalog = new Catalog();
  private generation = 0;
  private diagnostics: Diagnostic[] = [];
  private lastFetchedAtMs: number | null = null;

  /**
   * Hand a freshly downloaded playlist (master or media) to the tracker.
   * Playlist kind is auto-detected. Throws PlaylistParseError only when the
   * text is not an HLS playlist at all; malformed individual lines become
   * diagnostics instead.
   */
  ingest(text: string, options: IngestOptions): IngestResult {
    const { uri, fetchedAtMs } = options;
    this.generation += 1;
    const generation = this.generation;
    this.lastFetchedAtMs = fetchedAtMs;

    const parsed = parsePlaylist(text, uri);
    const diagnostics = this.catalog.warningsToDiagnostics(
      parsed.warnings,
      generation,
      uri
    );

    if (parsed.kind === 'master') {
      diagnostics.push(...this.catalog.ingestMaster(parsed.master, generation, fetchedAtMs));
      this.diagnostics.push(...diagnostics);
      return { kind: 'master', generation, accepted: true, changed: true, diagnostics };
    }

    const outcome = this.catalog.ingestMedia({
      playlist: parsed.media,
      fetchedAtMs,
      generation
    });
    diagnostics.push(...outcome.diagnostics);
    this.diagnostics.push(...diagnostics);
    return {
      kind: 'media',
      generation,
      accepted: outcome.accepted,
      changed: outcome.changed,
      diagnostics
    };
  }

  /** All diagnostics seen so far, deterministically ordered. */
  getDiagnostics(): Diagnostic[] {
    return [...this.diagnostics].sort(compareDiagnostics);
  }

  /** What each rendition can play right now, and which holes are confirmed. */
  playable(): PlayableReport {
    return this.catalog.playableReport();
  }

  /** Where renditions can be aligned/switched, split by discontinuity era. */
  alignment(): AlignmentReport {
    return buildAlignment(this.catalog);
  }

  /** When each rendition should be re-fetched. */
  refreshPlans(nowMs: number = this.lastFetchedAtMs ?? 0): RefreshReport {
    return buildRefresh(this.catalog, nowMs);
  }

  /**
   * Ordered catch-up plan from a starting msn (default: window tail) to the
   * live edge of the reference rendition, with cross-rendition mappings.
   */
  catchUpPlan(options: CatchUpOptions = {}): CatchUpPlan | null {
    const nowMs = options.nowMs ?? this.lastFetchedAtMs ?? 0;
    return buildCatchUpPlan(this.catalog, this.alignment(), this.refreshPlans(nowMs), {
      ...options,
      nowMs
    });
  }

  get currentGeneration(): number {
    return this.generation;
  }

  reset(): void {
    this.catalog = new Catalog();
    this.generation = 0;
    this.diagnostics = [];
    this.lastFetchedAtMs = null;
  }
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  if (a.generation !== b.generation) return a.generation - b.generation;
  if (a.playlistUri !== b.playlistUri) return a.playlistUri < b.playlistUri ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const am = a.msn ?? -1;
  const bm = b.msn ?? -1;
  return am - bm;
}

export default HlsWindowTracker;
