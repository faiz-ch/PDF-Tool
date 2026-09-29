import { Modal } from './Modal';
import { downloadBlob, zipResults } from '../lib/generate';
import { formatBytes } from '../lib/pdf';
import type { GroupResult } from '../lib/types';

const STATUS: Record<GroupResult['status'], { label: string; cls: string }> = {
  ok: { label: 'Original quality', cls: 'bg-emerald-100 text-emerald-800' },
  compressed: { label: 'Compressed to fit', cls: 'bg-blue-100 text-blue-800' },
  'over-limit': { label: 'Above limit', cls: 'bg-amber-100 text-amber-800' },
  error: { label: 'Failed', cls: 'bg-red-100 text-red-800' },
};

export default function ResultsModal({
  results,
  progress,
  onClose,
}: {
  results: GroupResult[];
  progress: { done: number; total: number; current?: string } | null;
  onClose: () => void;
}) {
  const running = progress !== null && progress.done < progress.total;
  const ready = results.filter((r) => r.blob);
  const date = new Date().toISOString().slice(0, 10);

  return (
    <Modal
      title={running ? 'Generating PDFs…' : 'Your PDFs are ready'}
      onClose={() => !running && onClose()}
      footer={
        <>
          <button className="btn mr-auto" disabled={running} onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            disabled={running || ready.length === 0}
            onClick={async () => downloadBlob(await zipResults(ready), `PDF Groups ${date}.zip`)}
          >
            ⬇ Download all as ZIP
          </button>
        </>
      }
    >
      {progress && running && (
        <div className="mb-4">
          <div className="mb-1 flex justify-between text-sm text-slate-600">
            <span>{progress.current}</span>
            <span>
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            The first compression loads the engine (about 16 MB) once; later runs are faster.
          </p>
        </div>
      )}
      <ul className="divide-y rounded-lg border">
        {results.map((r) => (
          <li key={r.groupId} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
            <div className="min-w-0 flex-1 basis-56">
              <div className="truncate font-medium">📄 {r.fileName}</div>
              <div className="mt-0.5 text-sm text-slate-500">
                {r.status === 'error' ? (
                  r.message
                ) : (
                  <>
                    {r.finalSize !== r.originalSize
                      ? `${formatBytes(r.originalSize)} → ${formatBytes(r.finalSize)}`
                      : formatBytes(r.finalSize)}
                    {r.limitBytes != null && ` · limit ${formatBytes(r.limitBytes)}`}
                  </>
                )}
              </div>
              {r.status === 'over-limit' && r.message && <div className="mt-1 text-sm text-amber-700">⚠ {r.message}</div>}
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[r.status].cls}`}>
              {STATUS[r.status].label}
            </span>
            {r.blob && (
              <button className="btn shrink-0" onClick={() => downloadBlob(r.blob!, r.fileName)}>
                ⬇ Download
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
