/*
 * Page rendering scheduler.
 *
 * Pages are drawn in background workers (render-worker.ts), so the screen never freezes.
 * Requests are served by priority, not upload order:
 *   PREVIEW    the page open in the preview window
 *   PREFETCH   its neighbours, so Next / Previous are instant
 *   VISIBLE    thumbnails currently on screen
 *   BACKGROUND everything else, filled in while the user works
 * If a browser cannot run the background renderer, or one page fails in it, rendering falls
 * back to the original on-screen renderer automatically.
 */
import { friendlyOpenError } from './pdfjs-options';
import { openOnMainThread, renderOnMainThread, forgetMainThreadDoc } from './pdf';
import type { RenderRequest, RenderResponse } from './render-worker';
import type { Source } from './types';

export const PRIORITY = { PREVIEW: 0, PREFETCH: 1, VISIBLE: 2, BACKGROUND: 3 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface RenderOut {
  url: string;
  aspect: number;
}
export interface RenderJob {
  promise: Promise<RenderOut>;
  setPriority(p: Priority): void;
  cancel(): void;
}
export interface OpenInfo {
  pageCount: number;
  aspects: number[];
  encrypted: boolean;
}

export class CancelledError extends Error {
  name = 'CancelledError';
}
export const isCancelled = (e: unknown) => (e as Error)?.name === 'CancelledError';

const TASK_TIMEOUT_MS = 60_000;
/** Files above this size are opened in one background worker only, to limit memory use. */
const LARGE_FILE_BYTES = 100 * 1024 * 1024;

interface Task {
  seq: number;
  source: Source;
  pageIndex: number;
  width: number;
  quality: number;
  priority: Priority;
  state: 'queued' | 'running' | 'done' | 'cancelled';
  forceMain: boolean;
  resolve: (r: RenderOut) => void;
  reject: (e: Error) => void;
}

interface Lane {
  readonly kind: 'worker' | 'main';
  busy: boolean;
  dead: boolean;
  accepts(source: Source): boolean;
  run(t: Task): Promise<{ blob: Blob; aspect: number }>;
  close(sourceId: string): void;
}

/* ---------- Background worker lane ---------- */

class WorkerLane implements Lane {
  readonly kind = 'worker';
  busy = false;
  dead = false;
  private worker: Worker;
  private opened = new Map<string, Promise<OpenInfo>>();
  private waiting = new Map<string, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private n = 0;

  readonly index: number;
  private onDead: (lane: WorkerLane) => void;

  constructor(index: number, onDead: (lane: WorkerLane) => void) {
    this.index = index;
    this.onDead = onDead;
    this.worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<RenderResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.fail(new Error(e.message || 'Background renderer stopped'));
  }

  private post(m: RenderRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private wait<T>(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.waiting.set(key, { resolve: resolve as (v: never) => void, reject }),
    );
  }

  private settle(key: string, value: unknown, error?: Error) {
    const w = this.waiting.get(key);
    if (!w) return;
    this.waiting.delete(key);
    if (error) w.reject(error);
    else w.resolve(value as never);
  }

  private onMessage(m: RenderResponse) {
    if (m.type === 'pong') this.settle('ping', m.ok);
    else if (m.type === 'opened') this.settle('open:' + m.docId, m);
    else if (m.type === 'rendered') this.settle('r:' + m.reqId, { blob: m.blob, aspect: m.aspect });
    else if (m.type === 'error') {
      const err = Object.assign(new Error(m.message), { name: m.name || 'Error' });
      if (m.reqId) this.settle('r:' + m.reqId, null, err);
      else if (m.docId) this.settle('open:' + m.docId, null, err);
    }
  }

  private fail(err: Error) {
    if (this.dead) return;
    this.dead = true;
    this.waiting.forEach((w) => w.reject(err));
    this.waiting.clear();
    this.worker.terminate();
    this.onDead(this);
  }

  /** Confirms this browser can draw off-screen inside a worker. */
  async check(): Promise<boolean> {
    const p = this.wait<boolean>('ping');
    this.post({ type: 'ping' });
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 6000));
    return Promise.race([p, timeout]).catch(() => false);
  }

  accepts(source: Source) {
    return this.index === 0 || source.bytes.byteLength <= LARGE_FILE_BYTES;
  }

  open(source: Source, details: boolean): Promise<OpenInfo> {
    let p = this.opened.get(source.id);
    if (!p) {
      p = this.wait<OpenInfo>('open:' + source.id);
      const data = source.bytes.slice().buffer; // the worker keeps its own copy
      this.post({ type: 'open', docId: source.id, data, details }, [data]);
      this.opened.set(source.id, p);
      p.catch(() => this.opened.delete(source.id));
    }
    return p;
  }

  async run(t: Task) {
    await this.open(t.source, false);
    const reqId = String(++this.n);
    const p = this.wait<{ blob: Blob; aspect: number }>('r:' + reqId);
    this.post({ type: 'render', reqId, docId: t.source.id, pageIndex: t.pageIndex, width: t.width, quality: t.quality });
    return p;
  }

  close(sourceId: string) {
    if (!this.opened.has(sourceId)) return;
    this.opened.delete(sourceId);
    if (!this.dead) this.post({ type: 'close', docId: sourceId });
  }
}

/* ---------- On-screen fallback lane ---------- */

class MainLane implements Lane {
  readonly kind = 'main';
  busy = false;
  dead = false;
  accepts() {
    return true;
  }
  run(t: Task) {
    return renderOnMainThread(t.source, t.pageIndex, t.width, t.quality);
  }
  close(sourceId: string) {
    forgetMainThreadDoc(sourceId);
  }
}

/* ---------- Scheduler ---------- */

class Renderer {
  private lanes: Lane[] = [];
  private mainLane: MainLane | null = null;
  private queue: Task[] = [];
  private seq = 0;
  private ready: Promise<void>;
  mode: 'starting' | 'background' | 'on-screen' = 'starting';

  constructor() {
    this.ready = this.start();
  }

  private async start() {
    const canTry = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
    if (canTry) {
      try {
        const first = new WorkerLane(0, (l) => this.laneDied(l));
        if (await first.check()) {
          this.lanes.push(first);
          const cores = navigator.hardwareConcurrency || 2;
          if (cores >= 4) this.lanes.push(new WorkerLane(1, (l) => this.laneDied(l)));
          this.mode = 'background';
          return;
        }
      } catch {
        /* fall through to on-screen rendering */
      }
    }
    this.useMainLane();
    this.mode = 'on-screen';
  }

  private useMainLane() {
    if (!this.mainLane) {
      this.mainLane = new MainLane();
      this.lanes.push(this.mainLane);
    }
    return this.mainLane;
  }

  private laneDied(lane: Lane) {
    this.lanes = this.lanes.filter((l) => l !== lane);
    if (!this.lanes.some((l) => l.kind === 'worker')) this.useMainLane();
    this.pump();
  }

  /** Opens a file and returns its page count, page shapes and whether it is encrypted. */
  async open(source: Source): Promise<OpenInfo> {
    await this.ready;
    const worker = this.lanes.find((l): l is WorkerLane => l instanceof WorkerLane);
    if (worker) {
      try {
        return await worker.open(source, true);
      } catch (e) {
        if ((e as Error).name === 'PasswordException') throw new Error(friendlyOpenError(source.name, e));
        // Any other problem: try the on-screen renderer before giving up.
      }
    }
    try {
      return await openOnMainThread(source);
    } catch (e) {
      throw new Error(friendlyOpenError(source.name, e));
    }
  }

  request(source: Source, pageIndex: number, width: number, priority: Priority, quality = 0.85): RenderJob {
    let task!: Task;
    const promise = new Promise<RenderOut>((resolve, reject) => {
      task = {
        seq: ++this.seq,
        source,
        pageIndex,
        width,
        quality,
        priority,
        state: 'queued',
        forceMain: false,
        resolve,
        reject,
      };
    });
    promise.catch(() => {}); // callers that cancel may not attach a handler
    this.queue.push(task);
    this.ready.then(() => this.pump());
    return {
      promise,
      setPriority: (p) => {
        if (task.state === 'queued' && task.priority !== p) task.priority = p;
      },
      cancel: () => {
        if (task.state === 'queued') {
          task.state = 'cancelled';
          this.queue = this.queue.filter((t) => t !== task);
          task.reject(new CancelledError('Cancelled'));
        } else if (task.state === 'running') task.state = 'cancelled';
      },
    };
  }

  /** Highest priority first; among previews the newest request wins, otherwise page order. */
  private pick(lane: Lane): Task | undefined {
    let best: Task | undefined;
    const key = (t: Task) => [t.priority, t.priority === PRIORITY.PREVIEW ? -t.seq : t.seq];
    for (const t of this.queue) {
      if (t.forceMain ? lane.kind !== 'main' : !lane.accepts(t.source)) continue;
      if (!best) best = t;
      else {
        const [a1, a2] = key(t);
        const [b1, b2] = key(best);
        if (a1 < b1 || (a1 === b1 && a2 < b2)) best = t;
      }
    }
    return best;
  }

  private pump() {
    for (const lane of this.lanes) {
      if (lane.busy || lane.dead) continue;
      const t = this.pick(lane);
      if (!t) continue;
      this.queue = this.queue.filter((x) => x !== t);
      this.runTask(lane, t);
    }
  }

  private runTask(lane: Lane, t: Task) {
    lane.busy = true;
    t.state = 'running';
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('Page rendering timed out.')), TASK_TIMEOUT_MS);
    });
    Promise.race([lane.run(t), timeout])
      .then(({ blob, aspect }) => {
        if (t.state === 'cancelled') return t.reject(new CancelledError('Cancelled'));
        t.state = 'done';
        t.resolve({ url: URL.createObjectURL(blob), aspect });
      })
      .catch((err: Error) => {
        if (t.state === 'cancelled') return t.reject(new CancelledError('Cancelled'));
        if (lane.kind === 'worker' && !t.forceMain) {
          // Retry this page with the on-screen renderer, which supports every PDF feature.
          this.useMainLane();
          t.forceMain = true;
          t.state = 'queued';
          this.queue.push(t);
          return;
        }
        t.state = 'done';
        t.reject(err);
      })
      .finally(() => {
        clearTimeout(timer);
        lane.busy = false;
        this.pump();
      });
  }

  close(sourceId: string) {
    for (const t of this.queue.filter((x) => x.source.id === sourceId)) {
      t.state = 'cancelled';
      t.reject(new CancelledError('Cancelled'));
    }
    this.queue = this.queue.filter((x) => x.source.id !== sourceId);
    this.lanes.forEach((l) => l.close(sourceId));
    this.mainLane?.close(sourceId);
  }
}

export const renderer = new Renderer();

/* ---------- Preview cache ---------- */

export const PREVIEW_WIDTH = 1400;
const PREVIEW_CACHE_SIZE = 24;

/**
 * Keeps recently viewed full-size pages, so going back and forth is instant,
 * and lets the preview window fetch neighbouring pages ahead of time.
 */
class PreviewCache {
  private urls = new Map<string, string>();
  private jobs = new Map<string, { job: RenderJob; promise: Promise<string> }>();
  private protectedKey: string | null = null;

  key(source: Source, pageIndex: number) {
    return `${source.id}:${pageIndex}`;
  }

  cached(source: Source, pageIndex: number) {
    return this.urls.get(this.key(source, pageIndex)) ?? null;
  }

  get(source: Source, pageIndex: number, priority: Priority): Promise<string> {
    const k = this.key(source, pageIndex);
    const hit = this.urls.get(k);
    if (hit) {
      this.urls.delete(k); // refresh position for least-recently-used eviction
      this.urls.set(k, hit);
      return Promise.resolve(hit);
    }
    const running = this.jobs.get(k);
    if (running) {
      running.job.setPriority(priority);
      return running.promise;
    }
    const job = renderer.request(source, pageIndex, PREVIEW_WIDTH, priority, 0.9);
    const promise = job.promise
      .then(({ url }) => {
        this.urls.set(k, url);
        this.evict();
        return url;
      })
      .finally(() => this.jobs.delete(k));
    promise.catch(() => {});
    this.jobs.set(k, { job, promise });
    return promise;
  }

  /** The page on screen keeps top priority; everything else waits behind it. */
  focus(source: Source, pageIndex: number) {
    const k = this.key(source, pageIndex);
    this.protectedKey = k;
    this.jobs.forEach((j, key) => key !== k && j.job.setPriority(PRIORITY.PREFETCH));
  }

  /** Called when the preview closes: drop work that has not started. */
  cancelPending() {
    this.protectedKey = null;
    this.jobs.forEach((j) => j.job.cancel());
  }

  private evict() {
    for (const k of this.urls.keys()) {
      if (this.urls.size <= PREVIEW_CACHE_SIZE) break;
      if (k === this.protectedKey) continue;
      URL.revokeObjectURL(this.urls.get(k)!);
      this.urls.delete(k);
    }
  }

  clear(sourceId?: string) {
    for (const [k, url] of [...this.urls]) {
      if (sourceId && !k.startsWith(sourceId + ':')) continue;
      URL.revokeObjectURL(url);
      this.urls.delete(k);
    }
  }
}

export const previews = new PreviewCache();
