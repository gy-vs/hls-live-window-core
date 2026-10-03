/**
 * Cross-rendition alignment.
 *
 * Renditions are split into eras by discontinuity sequence number, so an ad
 * pod (its own dseq region, timestamps reset) never pollutes the main
 * timeline. Inside an era, matching prefers absolute PROGRAM-DATE-TIME; when
 * playlists carry no PDT, matching falls back to relative position within the
 * era (media sequence numbers across renditions are not assumed equal).
 */
import { Catalog, RenditionState } from './catalog.js';
import { AlignmentPoint, AlignmentReport, EraAlignment } from './types.js';
import { sortedMapEntries } from './util.js';

interface OrderedSeg {
  msn: number;
  dseq: number;
  durationMs: number;
  pdtStart: number | null;
  discontinuity: boolean;
}

function orderedSegments(state: RenditionState): OrderedSeg[] {
  if (state.windowTailMsn === null || state.windowHeadMsn === null) return [];
  const out: OrderedSeg[] = [];
  for (let msn = state.windowTailMsn!; msn <= state.windowHeadMsn!; msn += 1) {
    if (!state.latestMsns.has(msn)) continue;
    const seg = state.segments.get(msn);
    if (seg) {
      out.push({
        msn: seg.msn,
        dseq: seg.dseq,
        durationMs: seg.durationMs,
        pdtStart: seg.pdtStart,
        discontinuity: seg.discontinuity
      });
    }
  }
  return out;
}

function cumulativeOffsets(segs: OrderedSeg[]): Map<number, number> {
  const map = new Map<number, number>();
  let acc = 0;
  for (const s of segs) {
    map.set(s.msn, acc);
    acc += s.durationMs;
  }
  return map;
}

function chooseReference(catalog: Catalog): RenditionState | null {
  const candidates: RenditionState[] = [];
  for (const [, state] of sortedMapEntries(catalog.renditions)) {
    if (state.windowTailMsn !== null && state.windowHeadMsn !== null) candidates.push(state);
  }
  if (candidates.length === 0) return null;
  // Prefer variants; among variants the longest window; tie-break on id.
  candidates.sort((a, b) => {
    const ka = a.descriptor.kind === 'variant' ? 0 : 1;
    const kb = b.descriptor.kind === 'variant' ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const lenA = a.windowHeadMsn! - a.windowTailMsn!;
    const lenB = b.windowHeadMsn! - b.windowTailMsn!;
    if (lenA !== lenB) return lenB - lenA;
    return a.descriptor.id < b.descriptor.id ? -1 : 1;
  });
  return candidates[0]!;
}

export function buildAlignment(catalog: Catalog): AlignmentReport {
  const generation = catalog.generation;
  const ref = chooseReference(catalog);
  const renditionIds = sortedMapEntries(catalog.renditions).map(([id]) => id);
  if (!ref) {
    return { generation, referenceRenditionId: null, renditionIds, eras: [] };
  }

  // Only renditions that currently carry data participate in matching.
  // Renditions advertised by the master but not yet ingested must not
  // suppress alignment points for the ones that are populated.
  const all = sortedMapEntries(catalog.renditions)
    .map(([, s]) => s)
    .filter((s) => s.windowTailMsn !== null && s.windowHeadMsn !== null);
  const refSegs = orderedSegments(ref);

  // Era list in reference order.
  const eraDseqs: number[] = [];
  for (const s of refSegs) {
    if (eraDseqs.length === 0 || eraDseqs[eraDseqs.length - 1] !== s.dseq) {
      eraDseqs.push(s.dseq);
    }
  }

  const eras: EraAlignment[] = [];
  for (const dseq of eraDseqs) {
    const rEra = refSegs.filter((s) => s.dseq === dseq);
    if (rEra.length === 0) continue;

    const usePdt = rEra.every((s) => s.pdtStart !== null);
    const refOffsets = cumulativeOffsets(rEra);

    const matches: Map<number, Map<string, number>> = new Map();
    let modeUsed: 'pdt' | 'sequence' = usePdt ? 'pdt' : 'sequence';

    for (const state of all) {
      const segs = orderedSegments(state);
      const era = segs.filter((s) => s.dseq === dseq);
      const offsets = cumulativeOffsets(era);

      for (const rSeg of rEra) {
        let matchedMsn: number | null = null;
        if (usePdt) {
          const t = rSeg.pdtStart!;
          matchedMsn = bestPdtMatch(era, t);
        }
        if (matchedMsn === null) {
          const refOff = refOffsets.get(rSeg.msn)!;
          matchedMsn = bestDurationMatch(era, offsets, refOff);
          if (modeUsed === 'pdt') modeUsed = 'sequence';
        }
        if (matchedMsn !== null) {
          let row = matches.get(rSeg.msn);
          if (!row) {
            row = new Map();
            matches.set(rSeg.msn, row);
          }
          row.set(state.descriptor.id, matchedMsn);
        }
      }
    }

    const points: AlignmentPoint[] = [];
    for (const rSeg of rEra) {
      const row = matches.get(rSeg.msn);
      if (!row) continue;
      // Point is usable only when every populated rendition covers it.
      if (row.size !== all.length) continue;
      const at: Record<string, number> = {};
      at[ref.descriptor.id] = rSeg.msn;
      for (const state of all) {
        if (state.descriptor.id === ref.descriptor.id) continue;
        at[state.descriptor.id] = row.get(state.descriptor.id)!;
      }
      points.push({
        referenceMsn: rSeg.msn,
        at,
        pdtMs: rSeg.pdtStart,
        discontinuityBoundary:
          rSeg.discontinuity &&
          all.every((state) => {
            const msn = row.get(state.descriptor.id);
            if (msn === undefined) return false;
            return state.segments.get(msn)?.discontinuity ?? false;
          })
      });
    }

    const commonPlayable: Record<string, { fromMsn: number; toMsn: number }> = {};
    for (const state of all) {
      const era2 = orderedSegments(state).filter((s) => s.dseq === dseq);
      if (era2.length > 0) {
        commonPlayable[state.descriptor.id] = {
          fromMsn: era2[0]!.msn,
          toMsn: era2[era2.length - 1]!.msn
        };
      }
    }

    eras.push({ dseq, mode: modeUsed, points, commonPlayable });
  }

  return {
    generation,
    referenceRenditionId: ref.descriptor.id,
    renditionIds,
    eras
  };
}

function bestPdtMatch(era: OrderedSeg[], t: number): number | null {
  if (era.length === 0) return null;
  let best: OrderedSeg | null = null;
  let bestDelta = Infinity;
  for (const s of era) {
    if (s.pdtStart === null) continue;
    const delta = Math.abs(s.pdtStart - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best ? best.msn : null;
}

function bestDurationMatch(
  era: OrderedSeg[],
  offsets: Map<number, number>,
  targetOffset: number
): number | null {
  if (era.length === 0) return null;
  let best: OrderedSeg | null = null;
  let bestDelta = Infinity;
  for (const s of era) {
    const delta = Math.abs(offsets.get(s.msn)! - targetOffset);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return best ? best.msn : null;
}
