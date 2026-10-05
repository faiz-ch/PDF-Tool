import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Thumb, { IconButton } from './components/Thumb';
import { PreviewModal } from './components/Modal';
import GroupEditor from './components/GroupEditor';
import LimitSelect from './components/LimitSelect';
import ResultsModal from './components/ResultsModal';
import { buildPdf, fileToSource, forgetEditDoc, formatBytes, isSupported, nextRotation, uid } from './lib/pdf';
import { PRIORITY, isCancelled, previews, renderer, type RenderJob } from './lib/renderer';
import { fileNamesFor, generateGroup, resolveLimitBytes } from './lib/generate';
import type { Group, GroupResult, LimitSetting, PageItem, Source } from './lib/types';

const THUMB_WIDTH = 260;

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [pool, setPool] = useState<PageItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [defaultLimit, setDefaultLimit] = useState<LimitSetting>(3);
  const [naming, setNaming] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ list: PageItem[]; index: number } | null>(null);
  const [estimates, setEstimates] = useState<Record<string, { key: string; size: number }>>({});
  const [loading, setLoading] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [results, setResults] = useState<GroupResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const pageMap = useMemo(() => new Map(pool.map((p) => [p.id, p])), [pool]);
  const defaultLimitMb = defaultLimit === 'default' ? 3 : defaultLimit;
  const defaultLimitLabel = defaultLimitMb == null ? 'no limit' : `${defaultLimitMb} MB`;
  const multiSource = sources.length > 1;

  const pageLabel = useCallback(
    (p: PageItem) => {
      if (!multiSource) return `Page ${p.pageIndex + 1}`;
      const short = p.sourceName.replace(/\.[^.]+$/, '');
      return `${short.length > 14 ? short.slice(0, 13) + '…' : short} · p${p.pageIndex + 1}`;
    },
    [multiSource],
  );

  /* ---------- Upload ---------- */

  const addFiles = useCallback(async (files: File[]) => {
    const ok = files.filter(isSupported);
    const rejected = files.filter((f) => !isSupported(f)).map((f) => `"${f.name}" is not a PDF or image.`);
    if (rejected.length) setErrors((e) => [...e, ...rejected]);
    for (const file of ok) {
      setLoading((n) => n + 1);
      try {
        const src = await fileToSource(file);
        const info = await renderer.open(src);
        if (info.encrypted) {
          renderer.close(src.id);
          throw new Error(`"${file.name}" is password-protected. Please remove the password first.`);
        }
        src.pageCount = info.pageCount;
        const items: PageItem[] = Array.from({ length: src.pageCount }, (_, i) => ({
          id: uid(),
          sourceId: src.id,
          sourceName: src.name,
          pageIndex: i,
          rotation: 0,
          aspect: info.aspects[i] ?? 1.414,
        }));
        setSources((s) => [...s, src]);
        setPool((p) => [...p, ...items]);
      } catch (e) {
        setErrors((errs) => [...errs, (e as Error).message]);
      } finally {
        setLoading((n) => n - 1);
      }
    }
  }, []);

  /* ---------- Thumbnails: background rendering, pages on screen first ---------- */

  const jobs = useRef(new Map<string, RenderJob>());
  const visible = useRef(new Set<string>());
  const observer = useRef<IntersectionObserver | null>(null);
  const observed = useRef(new Map<string, HTMLElement>());
  const thumbRefs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const finished = useRef(new Map<string, { thumb?: string; aspect?: number; thumbError?: boolean }>());
  const flushScheduled = useRef(false);

  // Finished thumbnails are applied together once per frame, instead of redrawing the list per page.
  const flushThumbs = useCallback(() => {
    flushScheduled.current = false;
    const done = new Map(finished.current);
    finished.current.clear();
    if (done.size === 0) return;
    setPool((ps) => {
      const live = new Set(ps.map((x) => x.id));
      done.forEach((d, id) => !live.has(id) && d.thumb && URL.revokeObjectURL(d.thumb));
      return ps.map((x) => (done.has(x.id) ? { ...x, ...done.get(x.id) } : x));
    });
  }, []);

  const finish = useCallback(
    (id: string, d: { thumb?: string; aspect?: number; thumbError?: boolean }) => {
      finished.current.set(id, d);
      if (!flushScheduled.current) {
        flushScheduled.current = true;
        requestAnimationFrame(flushThumbs);
      }
    },
    [flushThumbs],
  );

  // Watches which thumbnails are on screen (plus a margin) and moves them to the front of the queue.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.pageId;
          if (!id) continue;
          if (e.isIntersecting) visible.current.add(id);
          else visible.current.delete(id);
          jobs.current.get(id)?.setPriority(e.isIntersecting ? PRIORITY.VISIBLE : PRIORITY.BACKGROUND);
        }
      },
      { root: mainRef.current, rootMargin: '200px 0px' },
    );
    observer.current = io;
    observed.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /** Stable ref callback per page, so React does not re-attach observers on every update. */
  const thumbRef = useCallback((id: string) => {
    let fn = thumbRefs.current.get(id);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        const prev = observed.current.get(id);
        if (prev && prev !== el) {
          observer.current?.unobserve(prev);
          observed.current.delete(id);
        }
        if (el) {
          observed.current.set(id, el);
          observer.current?.observe(el);
        }
      };
      thumbRefs.current.set(id, fn);
    }
    return fn;
  }, []);

  // Every page without a thumbnail is queued once; on-screen pages are promoted by the observer.
  useEffect(() => {
    for (const p of pool) {
      if (p.thumb || p.thumbError || jobs.current.has(p.id)) continue;
      const src = sourceMap.get(p.sourceId);
      if (!src) continue;
      const job = renderer.request(
        src,
        p.pageIndex,
        THUMB_WIDTH,
        visible.current.has(p.id) ? PRIORITY.VISIBLE : PRIORITY.BACKGROUND,
      );
      jobs.current.set(p.id, job);
      job.promise
        .then(({ url, aspect }) => finish(p.id, { thumb: url, aspect }))
        .catch((err) => {
          if (isCancelled(err)) return;
          console.error('Thumbnail render failed', err);
          finish(p.id, { thumbError: true });
          setRenderError(String((err as Error).message || err));
        });
    }
  }, [pool, sourceMap, finish]);

  /* ---------- Selection ---------- */

  const onPageClick = (index: number, e: React.MouseEvent) => {
    const id = pool[index].id;
    // "Select range" mode (for touch screens): first tap marks the start, second tap selects everything between.
    const rangeEnd = e.shiftKey || (rangeMode && anchor !== null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (rangeEnd && anchor !== null) {
        const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
        for (let i = a; i <= b; i++) next.add(pool[i].id);
      } else if (rangeMode) next.add(id);
      else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (rangeMode && anchor !== null) {
      setRangeMode(false);
      setAnchor(index);
    } else if (!e.shiftKey) setAnchor(index);
  };

  const startRange = () => {
    setRangeMode(true);
    setAnchor(null);
  };

  const selectAll = () => setSelected(new Set(pool.map((p) => p.id)));

  const selectedInOrder = () => pool.filter((p) => selected.has(p.id)).map((p) => p.id);

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
    setRangeMode(false);
  };

  /* ---------- Groups ---------- */

  const startGroup = () => setNaming(`Group ${groups.length + 1}`);

  const createGroup = () => {
    const name = (naming ?? '').trim();
    if (!name || selected.size === 0) return;
    setGroups((g) => [...g, { id: uid(), name, pageIds: selectedInOrder(), limit: 'default' }]);
    setNaming(null);
    clearSelection();
  };

  const updateGroup = (g: Group) => setGroups((gs) => gs.map((x) => (x.id === g.id ? g : x)));
  const deleteGroup = (id: string) => {
    setGroups((gs) => gs.filter((g) => g.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const addSelectedTo = (g: Group) => {
    const existing = new Set(g.pageIds);
    updateGroup({ ...g, pageIds: [...g.pageIds, ...selectedInOrder().filter((id) => !existing.has(id))] });
    clearSelection();
  };

  const rotatePage = (pageId: string, rotation: PageItem['rotation']) =>
    setPool((ps) => ps.map((p) => (p.id === pageId ? { ...p, rotation } : p)));

  const groupCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) for (const id of g.pageIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [groups]);

  /* ---------- Size estimates (lossless build, debounced) ---------- */

  useEffect(() => {
    const t = setTimeout(async () => {
      for (const g of groups) {
        const key = g.pageIds.map((id) => `${id}:${pageMap.get(id)?.rotation ?? 0}`).join(',');
        if (estimates[g.id]?.key === key) continue;
        if (g.pageIds.length === 0) {
          setEstimates((e) => ({ ...e, [g.id]: { key, size: 0 } }));
          continue;
        }
        try {
          const bytes = await buildPdf(g.pageIds, pageMap, sourceMap);
          setEstimates((e) => ({ ...e, [g.id]: { key, size: bytes.byteLength } }));
        } catch {
          /* estimate is best-effort */
        }
      }
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, pageMap, sourceMap]);

  /* ---------- Generate ---------- */

  const generate = async () => {
    const todo = groups.filter((g) => g.pageIds.length > 0);
    if (todo.length === 0) return;
    const names = fileNamesFor(todo);
    const out: GroupResult[] = [];
    setResults([]);
    setProgress({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i];
      const r = await generateGroup(g, names.get(g.id)!, pageMap, sourceMap, defaultLimitMb, (step) =>
        setProgress({ done: i, total: todo.length, current: `${step} “${g.name}”` }),
      );
      out.push(r);
      setResults([...out]);
      setProgress({ done: i + 1, total: todo.length });
    }
  };

  const startOver = () => {
    if (!confirm('Remove all files and groups and start again?')) return;
    pool.forEach((p) => p.thumb?.startsWith('blob:') && URL.revokeObjectURL(p.thumb));
    jobs.current.forEach((j) => j.cancel());
    jobs.current.clear();
    visible.current.clear();
    previews.clear();
    sources.forEach((s) => {
      renderer.close(s.id);
      forgetEditDoc(s.id);
    });
    setSources([]);
    setPool([]);
    setGroups([]);
    setEstimates({});
    setErrors([]);
    clearSelection();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !preview && !editingId && !naming) clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, editingId, naming]);

  const editing = groups.find((g) => g.id === editingId) ?? null;
  const emptyGroups = groups.filter((g) => g.pageIds.length === 0).length;

  /* ---------- Render ---------- */

  return (
    <div
      className="flex h-[100dvh] flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="application/pdf,.pdf,image/*"
        className="hidden"
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-white px-3 py-2.5 shadow-sm sm:px-5 sm:py-3">
        <div className="mr-auto sm:mr-2">
          <h1 className="text-lg font-bold text-slate-900">PDF Grouper</h1>
          <p className="hidden text-xs text-slate-500 sm:block">Files are processed on this computer and never uploaded.</p>
        </div>
        <button
          className="btn relative md:hidden"
          onClick={() => setGroupsOpen(true)}
          aria-label={`Open groups (${groups.length})`}
        >
          Groups
          <span className="rounded-full bg-blue-700 px-1.5 text-xs font-semibold text-white">{groups.length}</span>
        </button>
        <div className="flex w-full gap-2 sm:w-auto">
          <button className="btn-primary flex-1 sm:flex-none" onClick={() => fileInput.current?.click()}>
            + Add <span className="hidden sm:inline">PDFs / images</span>
            <span className="sm:hidden">files</span>
          </button>
          {pool.length > 0 && (
            <button className="btn" onClick={startOver}>
              Start over
            </button>
          )}
        </div>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <span className="text-sm font-medium text-slate-600">
            <span className="hidden lg:inline">Default size limit:</span>
            <span className="lg:hidden">Size limit:</span>
          </span>
          <LimitSelect value={defaultLimit} onChange={setDefaultLimit} />
        </div>
      </header>

      {renderError && (
        <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 sm:px-5 text-sm text-amber-800">
          <div className="flex-1">
            <strong>Page previews could not be drawn.</strong> Grouping and generating PDFs still work. Try reloading the page
            (Ctrl + F5). Technical detail: {renderError}
          </div>
          <button onClick={() => setRenderError(null)} className="text-amber-600 hover:text-amber-900">
            Dismiss
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-3 py-2 sm:px-5 text-sm text-red-700">
          <ul className="flex-1 list-inside list-disc">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <button onClick={() => setErrors([])} className="text-red-500 hover:text-red-800">
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Page pool */}
        <main ref={mainRef} className="relative min-w-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {pool.length === 0 && loading === 0 ? (
            <button
              onClick={() => fileInput.current?.click()}
              className="flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white text-slate-500 hover:border-blue-400 hover:text-blue-600"
            >
              <span className="text-5xl">📄</span>
              <span className="mt-3 px-4 text-lg font-semibold">
                <span className="hidden sm:inline">Drop PDFs or images here, or click to choose</span>
                <span className="sm:hidden">Tap to choose PDFs or images</span>
              </span>
              <span className="mt-1 px-4 text-sm">PDF, JPG, PNG and other image formats · multiple files allowed</span>
            </button>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span className="mr-1">
                  {pool.length} page{pool.length === 1 ? '' : 's'} · {sources.length} file{sources.length === 1 ? '' : 's'}
                </span>
                {loading > 0 && <span className="animate-pulse text-blue-600">Loading {loading} file(s)…</span>}
                <div className="flex gap-2">
                  <button
                    className={`btn py-1 ${rangeMode ? 'border-blue-500 bg-blue-50 text-blue-800' : ''}`}
                    onClick={() => (rangeMode ? setRangeMode(false) : startRange())}
                    title="Tap the first page, then the last page"
                  >
                    {rangeMode ? 'Cancel range' : 'Select range'}
                  </button>
                  <button className="btn py-1" onClick={selectAll}>
                    Select all
                  </button>
                </div>
                <span className="ml-auto hidden text-slate-400 lg:inline">
                  Click to select · Shift-click for a range · Esc to clear
                </span>
                {rangeMode && (
                  <div className="w-full rounded-lg bg-blue-50 px-3 py-2 text-blue-800">
                    {anchor === null ? 'Tap the FIRST page of the range.' : 'Now tap the LAST page of the range.'}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 pb-28 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))] sm:gap-3">
                {pool.map((p, i) => {
                  const count = groupCount.get(p.id) ?? 0;
                  return (
                    <Thumb
                      key={p.id}
                      page={p}
                      cardRef={thumbRef(p.id)}
                      label={pageLabel(p)}
                      selected={selected.has(p.id)}
                      onClick={(e) => onPageClick(i, e)}
                      badge={
                        count > 0 && (
                          <span
                            className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white"
                            title={`In ${count} group${count > 1 ? 's' : ''}`}
                          >
                            {count} grp
                          </span>
                        )
                      }
                      actions={
                        <>
                          <IconButton title="Preview" onClick={() => setPreview({ list: pool, index: i })}>
                            🔍
                          </IconButton>
                          <IconButton title="Rotate" onClick={() => rotatePage(p.id, nextRotation(p.rotation))}>
                            ↻
                          </IconButton>
                        </>
                      }
                    />
                  );
                })}
              </div>
            </>
          )}

          {/* Selection bar */}
          {selected.size > 0 && (
            <div className="sticky bottom-3 z-20 mx-auto flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-slate-900 px-4 py-3 text-white shadow-2xl sm:bottom-4 sm:w-fit">
              <span className="font-semibold">{selected.size} selected</span>
              {naming === null ? (
                <>
                  <button className="btn-primary bg-blue-600" onClick={startGroup}>
                    Create group
                  </button>
                  <button className="text-sm text-slate-300 hover:text-white" onClick={clearSelection}>
                    Clear
                  </button>
                </>
              ) : (
                <form
                  className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap"
                  onSubmit={(e) => {
                    e.preventDefault();
                    createGroup();
                  }}
                >
                  <input
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    className="input min-w-0 flex-1 text-slate-900 sm:w-56 sm:flex-none"
                    value={naming}
                    onChange={(e) => setNaming(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
                    placeholder="Group name"
                  />
                  <button type="submit" className="btn-primary bg-blue-600" disabled={!naming.trim()}>
                    Save group
                  </button>
                  <button type="button" className="text-sm text-slate-300 hover:text-white" onClick={() => setNaming(null)}>
                    Cancel
                  </button>
                </form>
              )}
            </div>
          )}

          {dragOver && (
            <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-600/15 text-2xl font-semibold text-blue-800">
              Drop files to add them
            </div>
          )}
        </main>

        {/* Group panel: side column on tablet/desktop, bottom drawer on phones */}
        {groupsOpen && (
          <div className="fixed inset-0 z-30 bg-slate-900/40 md:hidden" onClick={() => setGroupsOpen(false)} />
        )}
        <aside
          className={`fixed inset-x-0 bottom-0 z-40 flex max-h-[85dvh] flex-col rounded-t-2xl bg-white shadow-2xl transition-transform duration-200 md:visible md:static md:z-auto md:max-h-none md:w-64 md:shrink-0 md:translate-y-0 md:rounded-none md:border-l md:shadow-none lg:w-80 ${
            groupsOpen ? 'translate-y-0' : 'invisible translate-y-full'
          }`}
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-slate-300 md:hidden" />
          <div className="flex items-start gap-2 border-b px-4 py-3">
            <div className="flex-1">
              <h2 className="font-semibold">Groups ({groups.length})</h2>
              <p className="text-xs text-slate-500">Each group becomes one PDF, named after the group.</p>
            </div>
            <button className="btn md:hidden" onClick={() => setGroupsOpen(false)}>
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {groups.length === 0 && (
              <p className="p-4 text-center text-sm text-slate-400">
                <span className="hidden md:inline">Select pages on the left, then click “Create group”.</span>
                <span className="md:hidden">Select pages, then tap “Create group”.</span>
              </p>
            )}
            {groups.map((g) => {
              const est = estimates[g.id];
              const limit = resolveLimitBytes(g, defaultLimitMb);
              const over = est && limit != null && est.size > limit;
              const limitText =
                g.limit === 'default' ? `default (${defaultLimitLabel})` : g.limit === null ? 'no limit' : `${g.limit} MB`;
              return (
                <div key={g.id} className="rounded-lg border border-slate-200 p-3 hover:border-slate-300">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold" title={g.name}>
                        {g.name || <span className="italic text-slate-400">Unnamed</span>}
                      </div>
                      <div className="text-xs text-slate-500">
                        {g.pageIds.length} page{g.pageIds.length === 1 ? '' : 's'} · limit {limitText}
                      </div>
                    </div>
                    <IconButton title="Delete group" tone="danger" onClick={() => confirm(`Delete group "${g.name}"?`) && deleteGroup(g.id)}>
                      ✕
                    </IconButton>
                  </div>
                  <div className="mt-2 flex gap-1 overflow-hidden">
                    {g.pageIds.slice(0, 6).map((id) => {
                      const p = pageMap.get(id);
                      return (
                        <div key={id} className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded border bg-slate-50">
                          {p?.thumb && (
                            <img src={p.thumb} alt="" className="max-h-full max-w-full" style={{ transform: `rotate(${p.rotation}deg)` }} />
                          )}
                        </div>
                      );
                    })}
                    {g.pageIds.length > 6 && (
                      <div className="flex h-12 w-9 items-center justify-center text-xs text-slate-500">+{g.pageIds.length - 6}</div>
                    )}
                  </div>
                  <div className={`mt-2 text-xs ${over ? 'text-amber-700' : 'text-slate-500'}`}>
                    {g.pageIds.length === 0
                      ? '⚠ Empty group, will be skipped'
                      : est
                        ? `Est. size ${formatBytes(est.size)}${over ? ' · will be compressed' : ''}`
                        : 'Estimating size…'}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      className="btn flex-1"
                      onClick={() => {
                        setEditingId(g.id);
                        setGroupsOpen(false);
                      }}
                    >
                      Edit / preview
                    </button>
                    {selected.size > 0 && (
                      <button className="btn flex-1" onClick={() => addSelectedTo(g)} title="Add the selected pages to this group">
                        + Add {selected.size}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {emptyGroups > 0 && (
              <p className="mb-2 text-xs text-amber-700">
                {emptyGroups} empty group{emptyGroups > 1 ? 's' : ''} will be skipped.
              </p>
            )}
            <button
              className="btn-primary w-full py-2.5 text-base"
              disabled={groups.length - emptyGroups === 0}
              onClick={() => {
                setGroupsOpen(false);
                generate();
              }}
            >
              Generate {groups.length - emptyGroups || ''} PDF{groups.length - emptyGroups === 1 ? '' : 's'}
            </button>
          </div>
        </aside>
      </div>

      {editing && (
        <GroupEditor
          group={editing}
          pool={pool}
          pages={pageMap}
          defaultLimitLabel={defaultLimitLabel}
          pageLabel={pageLabel}
          onChange={updateGroup}
          onRotate={rotatePage}
          onPreview={(list, index) => setPreview({ list, index })}
          onDelete={() => deleteGroup(editing.id)}
          onClose={() => !preview && setEditingId(null)}
        />
      )}

      {preview && (
        <PreviewModal
          list={preview.list.map((p) => pageMap.get(p.id) ?? p)}
          index={preview.index}
          sources={sourceMap}
          onIndex={(index) => setPreview((pv) => pv && { ...pv, index })}
          onClose={() => setPreview(null)}
        />
      )}

      {results && (
        <ResultsModal
          results={results}
          progress={progress}
          onClose={() => {
            setResults(null);
            setProgress(null);
          }}
        />
      )}
    </div>
  );
}
