import { PDFJS_BASE } from './pdfjs-worker';

/**
 * Resource locations pdf.js needs to draw every kind of PDF correctly:
 * standard fonts that a PDF does not embed, Asian character maps, and the
 * JPEG 2000 / JBIG2 decoders that scanners commonly use. Without these,
 * such pages are drawn blank.
 * `useWorkerFetch` is set explicitly so pdf.js never needs a DOM document to decide it.
 */
export function pdfjsResources(origin: string) {
  const base = new URL(import.meta.env.BASE_URL + PDFJS_BASE, origin).href;
  return {
    standardFontDataUrl: base + 'standard_fonts/',
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    useWorkerFetch: false,
  };
}

/** Turns pdf.js open errors into a message a user can act on. */
export function friendlyOpenError(name: string, err: unknown) {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'PasswordException' || /password/i.test(e?.message ?? ''))
    return `"${name}" is password-protected. Please remove the password first.`;
  return `"${name}" could not be read as a PDF.`;
}
