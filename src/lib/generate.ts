import JSZip from 'jszip';
import { buildPdf, compressPdf, formatBytes, safeFileName } from './pdf';
import type { Group, GroupResult, PageItem, Source } from './types';

const MB = 1024 * 1024;
export const COMPRESSION_DPI = 150;

export function resolveLimitBytes(group: Group, defaultLimitMb: number | null): number | null {
  const mb = group.limit === 'default' ? defaultLimitMb : group.limit;
  return mb == null ? null : Math.round(mb * MB);
}

/** Gives each group a unique, filesystem-safe file name. */
export function fileNamesFor(groups: Group[]) {
  const used = new Map<string, number>();
  const names = new Map<string, string>();
  for (const g of groups) {
    const base = safeFileName(g.name);
    const key = base.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    names.set(g.id, n === 1 ? `${base}.pdf` : `${base} (${n}).pdf`);
  }
  return names;
}

/**
 * Three-step pipeline for one group:
 *  1. Lossless build (original page content, structure compression only).
 *  2. If over the limit: recompress images at 150 DPI; text and vectors untouched.
 *  3. If still over: keep the smallest version and warn, never degrade further.
 */
export async function generateGroup(
  group: Group,
  fileName: string,
  pages: Map<string, PageItem>,
  sources: Map<string, Source>,
  defaultLimitMb: number | null,
  onStep: (step: string) => void,
): Promise<GroupResult> {
  const limitBytes = resolveLimitBytes(group, defaultLimitMb);
  const base = { groupId: group.id, fileName, limitBytes };
  try {
    onStep('Building');
    const raw = await buildPdf(group.pageIds, pages, sources, group.name);
    const asBlob = (b: Uint8Array) => new Blob([b as BlobPart], { type: 'application/pdf' });

    if (limitBytes == null || raw.byteLength <= limitBytes) {
      return { ...base, blob: asBlob(raw), originalSize: raw.byteLength, finalSize: raw.byteLength, status: 'ok' };
    }

    onStep('Compressing');
    let compressed: Uint8Array | null = null;
    let compressError = '';
    try {
      compressed = await compressPdf(raw, COMPRESSION_DPI);
    } catch (e) {
      compressError = (e as Error).message;
    }
    const best = compressed && compressed.byteLength < raw.byteLength ? compressed : raw;
    const within = best.byteLength <= limitBytes;
    return {
      ...base,
      blob: asBlob(best),
      originalSize: raw.byteLength,
      finalSize: best.byteLength,
      status: within ? 'compressed' : 'over-limit',
      message: within
        ? undefined
        : compressError
          ? `Compression could not run (${compressError}). Original file kept.`
          : `Smallest readable size is ${formatBytes(best.byteLength)}, above the ${formatBytes(limitBytes)} limit. Raise the limit or split this group.`,
    };
  } catch (e) {
    return { ...base, originalSize: 0, finalSize: 0, status: 'error', message: (e as Error).message };
  }
}

export async function zipResults(results: GroupResult[]) {
  const zip = new JSZip();
  for (const r of results) if (r.blob) zip.file(r.fileName, r.blob);
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
