/// <reference lib="webworker" />
/*
 * Background page renderer.
 * Runs pdf.js entirely inside this worker and draws on an OffscreenCanvas, so rendering
 * thumbnails and previews never freezes the screen. pdf.js's own parser runs in this same
 * thread (no nested worker), which keeps it compatible with every modern browser.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { pdfjsResources } from './pdfjs-options';

(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfjsWorker;

type CanvasAndContext = { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null };

/** pdf.js creates helper canvases through this; the default one needs a DOM document. */
class OffscreenCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: false }) };
  }
  reset(cc: CanvasAndContext, width: number, height: number) {
    if (!cc.canvas) throw new Error('Canvas is not specified');
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: CanvasAndContext) {
    if (cc.canvas) cc.canvas.width = cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

/**
 * Downloads fonts, character maps and image decoders. pdf.js's default loader reads
 * `document.baseURI`, which does not exist in a worker, so every download would fail.
 */
class WorkerBinaryDataFactory {
  private urls: Record<string, string | null>;
  constructor(o: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    this.urls = {
      cMapUrl: o.cMapUrl ?? null,
      standardFontDataUrl: o.standardFontDataUrl ?? null,
      wasmUrl: o.wasmUrl ?? null,
    };
  }
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = this.urls[kind];
    if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const url = base + filename;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Unable to load ${kind} data at: ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** SVG colour filters need a DOM; they are only used by rare transfer functions, so they are skipped. */
class NoFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}

export type RenderRequest =
  | { type: 'open'; docId: string; data: ArrayBuffer; details: boolean }
  | { type: 'close'; docId: string }
  | { type: 'render'; reqId: string; docId: string; pageIndex: number; width: number; quality: number }
  | { type: 'ping' };

export type RenderResponse =
  | { type: 'opened'; docId: string; pageCount: number; aspects: number[]; encrypted: boolean }
  | { type: 'rendered'; reqId: string; blob: Blob; aspect: number }
  | { type: 'error'; reqId?: string; docId?: string; message: string; name?: string }
  | { type: 'pong'; ok: boolean; message?: string };

const docs = new Map<string, pdfjs.PDFDocumentLoadingTask>();
const scope = self as unknown as DedicatedWorkerGlobalScope;
const reply = (m: RenderResponse) => scope.postMessage(m);

function open(docId: string, data: ArrayBuffer) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    ...pdfjsResources(self.location.origin),
    CanvasFactory: OffscreenCanvasFactory as never,
    FilterFactory: NoFilterFactory as never,
    BinaryDataFactory: WorkerBinaryDataFactory as never,
    disableFontFace: true, // glyphs are drawn as shapes, which works without a DOM
    useSystemFonts: false,
    isOffscreenCanvasSupported: true,
    isImageDecoderSupported: true,
    enableHWA: true,
  });
  docs.set(docId, task);
  return task.promise;
}

async function render(m: Extract<RenderRequest, { type: 'render' }>) {
  const task = docs.get(m.docId);
  if (!task) throw new Error('Document is not open');
  const doc = await task.promise;
  const page = await doc.getPage(m.pageIndex + 1);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: m.width / base.width });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport }).promise;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: m.quality });
    canvas.width = canvas.height = 0;
    return { blob, aspect: base.height / base.width };
  } finally {
    page.cleanup();
  }
}

scope.onmessage = async (e: MessageEvent<RenderRequest>) => {
  const m = e.data;
  if (m.type === 'ping') {
    try {
      const c = new OffscreenCanvas(4, 4);
      const ok = !!c.getContext('2d') && typeof c.convertToBlob === 'function';
      reply({ type: 'pong', ok });
    } catch (err) {
      reply({ type: 'pong', ok: false, message: String(err) });
    }
    return;
  }
  if (m.type === 'open') {
    try {
      const doc = await open(m.docId, m.data);
      const aspects: number[] = [];
      let encrypted = false;
      if (m.details) {
        // Page proportions, so placeholders have the right shape before a page is drawn.
        for (let i = 1; i <= doc.numPages; i++) {
          const pg = await doc.getPage(i);
          const v = pg.getViewport({ scale: 1 });
          aspects.push(v.height / v.width);
        }
        const meta = await doc.getMetadata();
        encrypted = !!(meta.info as { EncryptFilterName?: string | null })?.EncryptFilterName;
      }
      reply({ type: 'opened', docId: m.docId, pageCount: doc.numPages, aspects, encrypted });
    } catch (err) {
      docs.delete(m.docId);
      const e = err as Error;
      reply({ type: 'error', docId: m.docId, name: e?.name, message: String(e?.message || err) });
    }
    return;
  }
  if (m.type === 'close') {
    const task = docs.get(m.docId);
    docs.delete(m.docId);
    task?.destroy().catch(() => {});
    return;
  }
  if (m.type === 'render') {
    try {
      const { blob, aspect } = await render(m);
      reply({ type: 'rendered', reqId: m.reqId, blob, aspect });
    } catch (err) {
      reply({ type: 'error', reqId: m.reqId, message: String((err as Error)?.message || err) });
    }
  }
};
