/**
 * Catch-up plan builder.
 *
 * Walks the reference rendition from a starting msn (or the window tail) to
 * the live edge, emitting:
 *   play             - contiguous playable runs with cross-rendition mapping
 *   gap              - confirmed holes
 *   discontinuity    - dseq boundaries (timestamps reset here)
 *   catch-live-edge  - how far the player may fast-forward on a long backlog
 *   end-of-play      - closed playlists / ended live
 *   wait             - nothing new yet; delay recommended by refresh schedule
 */
import { Catalog } from './catalog.js';
import {
  AlignmentReport,
  CatchUpPlan,
  CatchUpStep,
  Gap,
  RefreshReport
} from './types.js';

export interface CatchUpOptions {
  /** Reference rendition to walk; defaults to the alignment reference. */
  referenceRenditionId?: string;
  /** Where to start; defaults to the reference window tail. */
  startsAtMsn?: number;
  /**
   * If the backlog exceeds this many segments, jump to within this many
   * segments of the live edge instead of walking the whole backlog.
   */
  maxWalkSegments?: number;
  nowMs?: number;
}

export function buildCatchUpPlan(
  catalog: Catalog,
  alignment: AlignmentReport,
  refresh: RefreshReport,
  options: CatchUpOptions = {}
): CatchUpPlan | null {
  const referenceId =
    options.referenceRenditionId ?? alignment.referenceRenditionId ?? null;
  if (referenceId === null) return null;
  const ref = catalog.renditions.get(referenceId);
  if (!ref || ref.windowTailMsn === null || ref.windowHeadMsn === null) return null;

  const tail = ref.windowTailMsn;
  const head = ref.windowHeadMsn;
  const startsAtMsn = options.startsAtMsn ?? tail;
  const steps: CatchUpStep[] = [];

  // Cross-rendition lookup: (refMsn) -> map renditionId -> msn.
  const pointAtRefMsn = new Map<number, (typeof alignment.eras)[number]['points'][number]>();
  for (const era of alignment.eras) {
    for (const point of era.points) pointAtRefMsn.set(point.referenceMsn, point);
  }
  const atFor = (msn: number): Record<string, number> => pointAtRefMsn.get(msn)?.at ?? {};

  // Active gaps on the reference inside the window.
  const activeGaps = collectActiveGaps(catalog, referenceId);

  // Long-backlog fast-forward.
  const backlog = head - startsAtMsn + 1;
  const maxWalk = options.maxWalkSegments ?? 0;
  if (maxWalk > 0 && backlog > maxWalk) {
    const target = Math.max(tail, head - maxWalk + 1);
    const seg = ref.segments.get(target);
    if (seg) {
      steps.push({ kind: 'catch-live-edge', targetMsn: target, at: atFor(target) });
    }
  }

  const walkFrom = steps.length > 0 && steps[steps.length - 1]!.kind === 'catch-live-edge'
    ? (steps[steps.length - 1] as { kind: 'catch-live-edge'; targetMsn: number }).targetMsn
    : Math.min(startsAtMsn, head);

  let runStart: number | null = null;
  let runDseq = 0;

  const flushPlay = (toMsn: number) => {
    if (runStart !== null) {
      steps.push({
        kind: 'play',
        fromMsn: runStart,
        toMsn,
        dseq: runDseq,
        at: atFor(toMsn)
      });
      runStart = null;
    }
  };

  for (let msn = walkFrom; msn <= head; msn += 1) {
    const gap = activeGaps.find((g) => g.fromMsn <= msn && msn <= g.toMsn);
    const seg = ref.latestMsns.has(msn) ? ref.segments.get(msn) : undefined;

    if (gap) {
      flushPlay(msn - 1);
      if (gap.fromMsn === msn) steps.push({ kind: 'gap', gap });
      msn = gap.toMsn;
      continue;
    }
    if (!seg) continue;

    if (seg.discontinuity) {
      flushPlay(msn - 1);
      const prevDseq = seg.dseq - 1;
      steps.push({ kind: 'discontinuity', msn, fromDseq: prevDseq, toDseq: seg.dseq });
    }
    if (runStart === null) {
      runStart = msn;
      runDseq = seg.dseq;
    }
  }
  flushPlay(head);

  if (ref.everEnded) {
    steps.push({ kind: 'end-of-play', msn: head });
  } else if (options.nowMs !== undefined) {
    // Nothing new past the current position: recommend waiting for the
    // rendition's scheduled reload rather than busy-refreshing.
    const r = refresh.renditions.find((x) => x.renditionId === referenceId);
    if (r && r.nextFetchMs !== null) {
      steps.push({
        kind: 'wait',
        delayMs: Math.max(0, r.nextFetchMs - options.nowMs),
        untilMs: r.nextFetchMs
      });
    }
  }

  return {
    generation: catalog.generation,
    referenceRenditionId: referenceId,
    startsAtMsn,
    steps
  };
}

function collectActiveGaps(catalog: Catalog, referenceId: string): Gap[] {
  const report = catalog.playableReport();
  const r = report.renditions.find((x) => x.renditionId === referenceId);
  return r ? r.gaps : [];
}
