import type { ReactNode } from 'react';
import type { PageItem } from '../lib/types';

interface Props {
  page: PageItem;
  label: string;
  selected?: boolean;
  dimmed?: boolean;
  badge?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  actions?: ReactNode;
  size?: 'md' | 'sm';
}

/** Square thumbnail box so rotated pages always fit without layout jumps. */
export default function Thumb({ page, label, selected, dimmed, badge, onClick, actions, size = 'md' }: Props) {
  const box = size === 'md' ? 'h-40' : 'h-28';
  return (
    <div
      onClick={onClick}
      className={`group relative select-none rounded-lg border bg-white p-2 shadow-sm transition ${
        onClick ? 'cursor-pointer' : ''
      } ${selected ? 'border-blue-600 ring-2 ring-blue-500' : 'border-slate-200 hover:border-slate-400'} ${
        dimmed ? 'opacity-50' : ''
      }`}
    >
      <div className={`flex ${box} items-center justify-center overflow-hidden rounded bg-slate-50`}>
        {page.thumbError ? (
          <div className="px-2 text-center text-xs text-red-600">Preview unavailable</div>
        ) : page.thumb ? (
          <img
            src={page.thumb}
            alt={label}
            draggable={false}
            className="max-h-full max-w-full object-contain shadow transition-transform"
            style={{ transform: `rotate(${page.rotation}deg)`, maxHeight: page.rotation % 180 ? '70%' : '100%' }}
          />
        ) : (
          <div className="h-3/4 w-1/2 animate-pulse rounded bg-slate-200" />
        )}
      </div>
      <div className="mt-1.5 truncate text-center text-xs text-slate-600" title={`${page.sourceName}, page ${page.pageIndex + 1}`}>
        {label}
      </div>
      {selected && (
        <div className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">
          ✓
        </div>
      )}
      {badge && <div className="absolute right-1.5 top-1.5">{badge}</div>}
      {actions && (
        <div className="absolute inset-x-1.5 bottom-7 flex justify-center gap-1 opacity-0 transition group-hover:opacity-100 pointer-coarse:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

export function IconButton({
  title,
  onClick,
  children,
  tone = 'default',
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={`flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 items-center justify-center rounded-md border bg-white/95 text-sm shadow-sm ${
        tone === 'danger'
          ? 'border-red-200 text-red-600 hover:bg-red-50'
          : 'border-slate-300 text-slate-700 hover:bg-slate-100'
      }`}
    >
      {children}
    </button>
  );
}
