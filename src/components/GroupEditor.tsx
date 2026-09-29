import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Modal } from './Modal';
import Thumb, { IconButton } from './Thumb';
import LimitSelect from './LimitSelect';
import { nextRotation } from '../lib/pdf';
import type { Group, PageItem } from '../lib/types';

interface Props {
  group: Group;
  pool: PageItem[];
  pages: Map<string, PageItem>;
  defaultLimitLabel: string;
  pageLabel: (p: PageItem) => string;
  onChange: (g: Group) => void;
  onRotate: (pageId: string, rotation: PageItem['rotation']) => void;
  onPreview: (list: PageItem[], index: number) => void;
  onDelete: () => void;
  onClose: () => void;
}

function SortableThumb({
  page,
  position,
  label,
  onRemove,
  onPreview,
  onRotate,
}: {
  page: PageItem;
  position: number;
  label: string;
  onRemove: () => void;
  onPreview: () => void;
  onRotate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: page.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={`cursor-grab touch-manipulation active:cursor-grabbing ${isDragging ? 'opacity-80' : ''}`}
      {...attributes}
      {...listeners}
    >
      <Thumb
        page={page}
        size="sm"
        label={label}
        badge={
          <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[11px] font-semibold text-white">{position}</span>
        }
        actions={
          <>
            <IconButton title="Preview" onClick={onPreview}>🔍</IconButton>
            <IconButton title="Rotate" onClick={onRotate}>↻</IconButton>
            <IconButton title="Remove from group" tone="danger" onClick={onRemove}>✕</IconButton>
          </>
        }
      />
    </div>
  );
}

export default function GroupEditor({
  group,
  pool,
  pages,
  defaultLimitLabel,
  pageLabel,
  onChange,
  onRotate,
  onPreview,
  onDelete,
  onClose,
}: Props) {
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // On touch screens a short press-and-hold starts dragging, so normal swipes still scroll.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groupPages = group.pageIds.map((id) => pages.get(id)).filter(Boolean) as PageItem[];
  const inGroup = new Set(group.pageIds);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = group.pageIds.indexOf(String(active.id));
    const to = group.pageIds.indexOf(String(over.id));
    onChange({ ...group, pageIds: arrayMove(group.pageIds, from, to) });
  };

  const togglePoolPage = (id: string) =>
    onChange({
      ...group,
      pageIds: inGroup.has(id) ? group.pageIds.filter((p) => p !== id) : [...group.pageIds, id],
    });

  return (
    <Modal
      wide
      onClose={onClose}
      title={
        <input
          className="input w-full max-w-md text-base font-semibold"
          value={group.name}
          placeholder="Group name"
          onChange={(e) => onChange({ ...group, name: e.target.value })}
          aria-label="Group name"
        />
      }
      footer={
        <>
          <button
            className="btn-danger mr-auto"
            onClick={() => {
              if (confirm(`Delete group "${group.name}"?`)) onDelete();
            }}
          >
            Delete group
          </button>
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-slate-600">Size limit:</span>
        <LimitSelect
          allowDefault
          defaultLabel={defaultLimitLabel}
          value={group.limit}
          onChange={(limit) => onChange({ ...group, limit })}
        />
        <span className="text-sm text-slate-500 sm:ml-auto">
          {groupPages.length} page{groupPages.length === 1 ? '' : 's'} ·{' '}
          <span className="pointer-coarse:hidden">drag to reorder</span>
          <span className="hidden pointer-coarse:inline">press and hold to reorder</span>
        </span>
      </div>

      {groupPages.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-slate-300 p-8 text-center text-slate-500">
          This group has no pages. Use “Add pages” below.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={group.pageIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] sm:gap-3">
              {groupPages.map((p, i) => (
                <SortableThumb
                  key={p.id}
                  page={p}
                  position={i + 1}
                  label={pageLabel(p)}
                  onRemove={() => onChange({ ...group, pageIds: group.pageIds.filter((id) => id !== p.id) })}
                  onPreview={() => onPreview(groupPages, i)}
                  onRotate={() => onRotate(p.id, nextRotation(p.rotation))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <div className="mt-6 border-t pt-4">
        <button className="btn" onClick={() => setAdding((a) => !a)}>
          {adding ? '▾ Hide page list' : '▸ Add pages'}
        </button>
        {adding && (
          <>
            <p className="mb-3 mt-2 text-sm text-slate-500">
              Click a page to add it to the end of this group; click again to remove it.
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(110px,1fr))] sm:gap-3">
              {pool.map((p) => (
                <Thumb
                  key={p.id}
                  page={p}
                  size="sm"
                  label={pageLabel(p)}
                  selected={inGroup.has(p.id)}
                  onClick={() => togglePoolPage(p.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
