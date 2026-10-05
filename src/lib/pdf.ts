import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFJS_WORKER } from './pdfjs-worker';
import { pdfjsResources } from './pdfjs-options';
import type { PageItem, Rotation, Source } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}${PDFJS_WORKER}`;

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const A4_WIDTH_PT = 595.28;

/* ---------- Upload: normalise every file to PDF bytes ---------- */

async function imageToPngBytes(file: File): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image conversion failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

async function imageToPdf(file: File): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const raw = new Uint8Array(await file.arrayBuffer());
  const type = file.type.toLowerCase();
  // JPG and PNG are embedded as-is (no quality loss); other formats go through a lossless PNG conversion.
  const img =
    type === 'image/jpeg' || type === 'image/jpg'
      ? await doc.embedJpg(raw)
      : type === 'image/png'
        ? await doc.embedPng(raw)
        : await doc.embedPng(await imageToPngBytes(file));
  // Page is A4 width; height follows the image's proportions. Full resolution is kept.
  const width = A4_WIDTH_PT;
  const height = (img.height / img.width) * width;
  const page = doc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });
  return doc.save({ useObjectStreams: true });
}

export function isSupported(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name) || file.type.startsWith('image/');
}

/** Reads a file (images are converted to a one-page PDF). Page count is filled in by the renderer. */
export async function fileToSource(file: File): Promise<Source> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const bytes = isPdf ? new Uint8Array(await file.arrayBuffer()) : await imageToPdf(file);
  return { id: uid(), name: file.name, bytes, pageCount: 0 };
}

/* ---------- On-screen rendering (fallback when background rendering is unavailable) ---------- */

const viewerDocs = new Map<string, pdfjs.PDFDocumentLoadingTask>();

function getViewerDoc(source: Source) {
  let task = viewerDocs.get(source.id);
  if (!task) {
    // pdf.js takes ownership of the buffer, so give it a copy.
    task = pdfjs.getDocument({ data: source.bytes.slice(), ...pdfjsResources(window.location.origin) });
    viewerDocs.set(source.id, task);
    task.promise.catch(() => viewerDocs.delete(source.id));
  }
  return task.promise;
}

export function forgetMainThreadDoc(sourceId: string) {
  viewerDocs.get(sourceId)?.destroy();
  viewerDocs.delete(sourceId);
}

/** Releases everything held for a file. */
export function forgetEditDoc(sourceId: string) {
  editDocs.delete(sourceId);
}

export async function openOnMainThread(source: Source) {
  const doc = await getViewerDoc(source);
  const aspects: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const v = (await doc.getPage(i)).getViewport({ scale: 1 });
    aspects.push(v.height / v.width);
  }
  const meta = await doc.getMetadata();
  const encrypted = !!(meta.info as { EncryptFilterName?: string | null })?.EncryptFilterName;
  return { pageCount: doc.numPages, aspects, encrypted };
}

/** Renders a page to a JPEG, `targetWidth` pixels wide. */
export async function renderOnMainThread(source: Source, pageIndex: number, targetWidth: number, quality = 0.85) {
  const doc = await getViewerDoc(source);
  const page = await doc.getPage(pageIndex + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: targetWidth / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
    const blob: Blob = await new Promise((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Render failed'))), 'image/jpeg', quality),
    );
    canvas.width = canvas.height = 0;
    return { blob, aspect: base.height / base.width };
  } finally {
    page.cleanup();
  }
}

/* ---------- Building group PDFs (pdf-lib) ---------- */

const editDocs = new Map<string, Promise<PDFDocument>>();

function getEditDoc(source: Source) {
  let p = editDocs.get(source.id);
  if (!p) {
    p = PDFDocument.load(source.bytes);
    editDocs.set(source.id, p);
  }
  return p;
}

/** Lossless build: copies original page objects unchanged, applies rotation, compresses file structure. */
export async function buildPdf(
  pageIds: string[],
  pages: Map<string, PageItem>,
  sources: Map<string, Source>,
  title?: string,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const items = pageIds.map((id) => pages.get(id)).filter((p): p is PageItem => !!p && sources.has(p.sourceId));

  // Copy all pages from the same source in ONE call, so shared fonts and images are copied once.
  const copiedById = new Map<string, Awaited<ReturnType<PDFDocument['copyPages']>>[number]>();
  const bySource = new Map<string, PageItem[]>();
  for (const it of items) bySource.set(it.sourceId, [...(bySource.get(it.sourceId) ?? []), it]);
  for (const [sourceId, list] of bySource) {
    const srcDoc = await getEditDoc(sources.get(sourceId)!);
    const copied = await out.copyPages(srcDoc, list.map((it) => it.pageIndex));
    list.forEach((it, i) => copiedById.set(it.id, copied[i]));
  }

  for (const it of items) {
    const page = copiedById.get(it.id)!;
    const base = page.getRotation().angle;
    page.setRotation(degrees((((base + it.rotation) % 360) + 360) % 360));
    out.addPage(page);
  }
  if (title) out.setTitle(title);
  out.setProducer('RLK PDF Grouper');
  out.setCreator('RLK PDF Grouper');
  return out.save({ useObjectStreams: true });
}

export const nextRotation = (r: Rotation): Rotation => (((r + 90) % 360) as Rotation);
export const prevRotation = (r: Rotation): Rotation => (((r + 270) % 360) as Rotation);

/* ---------- Compression (Ghostscript WebAssembly worker) ---------- */

let worker: Worker | null = null;
const pending = new Map<string, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (!worker) {
    worker = new Worker(`${import.meta.env.BASE_URL}gs/gs-worker.js`);
    worker.onmessage = (e: MessageEvent) => {
      const { id, ok, pdf, error } = e.data;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (ok) job.resolve(new Uint8Array(pdf));
      else job.reject(new Error(error));
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Compression engine failed to start');
      pending.forEach((j) => j.reject(err));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/** Recompresses images above `dpi`; text, fonts and vector graphics are kept. */
export function compressPdf(bytes: Uint8Array, dpi = 150): Promise<Uint8Array> {
  const id = uid();
  const buf = bytes.slice().buffer;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, pdf: buf, dpi }, [buf]);
  });
}

/* ---------- Helpers ---------- */

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function safeFileName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Untitled').slice(0, 120);
}
