import {
  Diagnostic,
  RenditionDiscontinuityMismatchDiagnostic,
} from './types.js';
import { RenditionStateView } from './tracker.js';

/**
 * Cross-rendition alignment.
 *
 * Segments of the same content across renditions share the same media
 * sequence number, and EXT-X-DISCONTINUITY markers (e.g. an inserted ad pod
 * after which timestamps restart) must line up at the same MSNs.
 *
 * A point is a *safe* switch point when the target segment starts a new
 * encoded sequence: either it carries a discontinuity, or every rendition
 * declares EXT-X-INDEPENDENT-SEGMENTS.
 */

export interface AlignmentPoint {
  msn: number;
  discontinuitySequence: number;
  discontinuity: boolean;
  safeToSwitch: boolean;
  independent: boolean;
  /** Per-rendition start time (PDT), when known, keyed by rendition id. */
  programDateTimes: Record<string, number | null>;
}

export interface RenditionAlignmentResult {
  renditions: string[];
  /** MSNs present on every rendition, ascending. */
  commonFirstMsn: number | null;
  commonLastMsn: number | null;
  points: AlignmentPoint[];
  diagnostics: RenditionDiscontinuityMismatchDiagnostic[];
}

export function getAlignment(
  renditions: RenditionStateView[],
): RenditionAlignmentResult {
  const sorted = renditions
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const diagnostics: RenditionDiscontinuityMismatchDiagnostic[] = [];
  const ids = sorted.map((r) => r.id);

  if (sorted.length < 2) {
    return {
      renditions: ids,
      commonFirstMsn: null,
      commonLastMsn: null,
      points: [],
      diagnostics,
    };
  }

  let commonFirst: number | null = null;
  let commonLast: number | null = null;
  for (const r of sorted) {
    if (r.firstMsn === null || r.lastMsn === null) {
      commonFirst = null;
      commonLast = null;
      break;
    }
    commonFirst = commonFirst === null ? r.firstMsn : Math.max(commonFirst, r.firstMsn);
    commonLast = commonLast === null ? r.lastMsn : Math.min(commonLast, r.lastMsn);
  }

  if (commonFirst === null || commonLast === null || commonLast < commonFirst) {
    return {
      renditions: ids,
      commonFirstMsn: null,
      commonLastMsn: null,
      points: [],
      diagnostics,
    };
  }

  // Index segments for quick lookup.
  const tables = sorted.map((r) => {
    const byMsn = new Map<number, (typeof r.segments)[number]>();
    for (const seg of r.segments) byMsn.set(seg.msn, seg);
    return { r, byMsn };
  });

  const points: AlignmentPoint[] = [];
  const allIndependent = sorted.every((r) => r.independentSegments);

  for (let msn = commonFirst; msn <= commonLast; msn++) {
    let dseq: number | null = null;
    let discoVotes = 0;
    let dseqMismatch = false;
    const pdts: Record<string, number | null> = {};
    let allPresent = true;

    for (const { r, byMsn } of tables) {
      const seg = byMsn.get(msn);
      if (!seg) {
        allPresent = false;
        break;
      }
      pdts[r.id] = seg.programDateTime;
      if (seg.discontinuity) discoVotes += 1;
      if (dseq === null) dseq = seg.discontinuitySequence;
      else if (seg.discontinuitySequence !== dseq) dseqMismatch = true;
    }
    if (!allPresent) continue;

    const discontinuityAll = discoVotes === sorted.length;
    const discontinuitySome = discoVotes > 0 && !discontinuityAll;

    if (discontinuitySome || dseqMismatch) {
      for (const { r, byMsn } of tables) {
        const seg = byMsn.get(msn)!;
        if (!seg.discontinuity && discontinuityAll === false) {
          diagnostics.push({
            code: 'rendition-discontinuity-mismatch',
            message:
              `discontinuity at MSN ${msn} is not aligned across renditions: ` +
              `${r.id}${seg.discontinuity ? ' carries it' : ' does not'}`,
            rendition: r.id,
            msn,
            expectedDiscontinuity: discoVotes * 2 >= sorted.length,
            actualDiscontinuity: seg.discontinuity,
          });
        }
      }
    }

    points.push({
      msn,
      discontinuitySequence: dseq as number,
      discontinuity: discontinuityAll,
      safeToSwitch: discontinuityAll || allIndependent,
      independent: allIndependent,
      programDateTimes: pdts,
    });
  }

  dedupeDiagnostics(diagnostics);
  return {
    renditions: ids,
    commonFirstMsn: commonFirst,
    commonLastMsn: commonLast,
    points,
    diagnostics,
  };
}

function dedupeDiagnostics(
  ds: RenditionDiscontinuityMismatchDiagnostic[],
): void {
  const seen = new Set<string>();
  for (let i = ds.length - 1; i >= 0; i--) {
    const d = ds[i]!;
    const key = `${d.rendition}:${d.msn}:${d.actualDiscontinuity}`;
    if (seen.has(key)) {
      ds.splice(i, 1);
    } else {
      seen.add(key);
    }
  }
  ds.sort((a, b) => {
    if (a.msn !== b.msn) return a.msn - b.msn;
    return a.rendition < b.rendition ? -1 : 1;
  });
}

export type { Diagnostic };
