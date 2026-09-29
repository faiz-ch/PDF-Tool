import { useEffect, useState, type ReactNode } from 'react';
import { renderPage } from '../lib/pdf';
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
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    setUrl(null);
    setError(null);
    const src = page && sources.get(page.sourceId);
    if (src)
      renderPage(src, page.pageIndex, 1400)
        .then((r) => {
          made = r.url;
          if (!cancelled) setUrl(r.url);
          else URL.revokeObjectURL(r.url);
        })
        .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [page, sources]);

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
        {url ? (
          <img
            src={url}
            alt="Page preview"
            className="object-contain shadow-lg"
            style={{
              transform: `rotate(${page.rotation}deg)`,
              maxHeight: sideways ? 'min(72vw, 94vw)' : '100%',
              maxWidth: sideways ? '72vh' : '100%',
            }}
          />
        ) : error ? (
          <div className="max-w-lg text-center text-red-700">
            <div className="font-semibold">This page could not be displayed.</div>
            <div className="mt-1 text-sm">{error}</div>
          </div>
        ) : (
          <div className="text-slate-500">Rendering…</div>
        )}
      </div>
    </Modal>
  );
}
