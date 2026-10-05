import { useEffect, useState, type ReactNode } from 'react';
import { PRIORITY, isCancelled, previews } from '../lib/renderer';
import type { PageItem, Source } from '../lib/types';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 sm:p-4" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex h-[100dvh] w-full flex-col bg-white shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-xl ${wide ? 'sm:max-w-6xl' : 'sm:max-w-3xl'}`}
      >
        <div className="flex items-center justify-between gap-3 border-b px-3 py-2.5 sm:px-5 sm:py-3">
          <div className="min-w-0 flex-1 font-semibold">{title}</div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Large preview of one page, with next/previous navigation through a list of pages. */
export function PreviewModal({
  list,
  index,
  sources,
  onIndex,
  onClose,
}: {
  list: PageItem[];
  index: number;
  sources: Map<string, Source>;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const page = list[index];
  const src = page ? sources.get(page.sourceId) : undefined;
  const [url, setUrl] = useState<string | null>(() => (src && page ? previews.cached(src, page.pageIndex) : null));
  const [error, setError] = useState<string | null>(null);

  // Drop queued full-size renders when the preview closes; finished pages stay cached.
  useEffect(() => () => previews.cancelPending(), []);

  useEffect(() => {
    if (!page || !src) return;
    let current = true;
    setError(null);
    setUrl(previews.cached(src, page.pageIndex));
    previews.focus(src, page.pageIndex);
    previews
      .get(src, page.pageIndex, PRIORITY.PREVIEW)
      .then((u) => current && setUrl(u))
      .catch((e) => current && !isCancelled(e) && setError(String((e as Error).message || e)));
    // Fetch the neighbours ahead of time, so Next / Previous open instantly.
    for (const j of [index + 1, index - 1, index + 2]) {
      const n = list[j];
      const ns = n && sources.get(n.sourceId);
      if (ns) previews.get(ns, n.pageIndex, PRIORITY.PREFETCH);
    }
    return () => {
      current = false;
    };
  }, [page, src, index, list, sources]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < list.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, list.length, onIndex]);

  if (!page) return null;
  const sideways = page.rotation % 180 !== 0;
  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <span className="truncate">
          {page.sourceName} · page {page.pageIndex + 1}
          <span className="ml-2 text-sm font-normal text-slate-500">
            ({index + 1} of {list.length})
          </span>
        </span>
      }
      footer={
        <>
          <button disabled={index === 0} onClick={() => onIndex(index - 1)} className="btn">
            ← Previous
          </button>
          <button disabled={index === list.length - 1} onClick={() => onIndex(index + 1)} className="btn">
            Next →
          </button>
        </>
      }
    >
      <div className="flex h-[calc(100dvh-8.5rem)] items-center justify-center overflow-hidden bg-slate-100 sm:h-[72vh]">
        {error && !url ? (
          <div className="max-w-lg text-center text-red-700">
            <div className="font-semibold">This page could not be displayed.</div>
            <div className="mt-1 text-sm">{error}</div>
          </div>
        ) : url || page.thumb ? (
          <div className="relative flex h-full w-full items-center justify-center">
            <img
              // Shows the thumbnail enlarged at once, then swaps to the sharp page when ready.
              src={url ?? page.thumb}
              alt="Page preview"
              data-sharp={url ? 'true' : 'false'}
              decoding="async"
              className={`object-contain shadow-lg ${url ? '' : 'blur-[1px]'}`}
              style={{
                transform: `rotate(${page.rotation}deg)`,
                height: url ? undefined : '100%',
                maxHeight: sideways ? 'min(72vw, 94vw)' : '100%',
                maxWidth: sideways ? '72vh' : '100%',
              }}
            />
            {!url && (
              <div className="absolute bottom-3 rounded-full bg-slate-900/75 px-3 py-1 text-xs font-medium text-white">
                Loading full quality…
              </div>
            )}
          </div>
        ) : (
          <div className="text-slate-500">Rendering…</div>
        )}
      </div>
    </Modal>
  );
}
