// Drag-to-reorder lists (@dnd-kit): mouse, touch (by the grip) and keyboard, announced in Russian.

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, ReactNode } from 'react';
import { audio } from '../../../visual';

const num = (ids: readonly string[], id: unknown) => ids.indexOf(String(id)) + 1;

export function SortableList({ ids, onMove, children }: { ids: readonly string[]; onMove: (from: number, to: number) => void; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Взял пункт ${num(ids, active.id)}`,
    onDragOver: ({ over }) => (over ? `Над местом ${num(ids, over.id)}` : 'Вне списка'),
    onDragEnd: ({ over }) => (over ? `Поставил на место ${num(ids, over.id)}` : 'Отменено'),
    onDragCancel: () => 'Отменено',
  };
  const end = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    audio.drop(1.1, 0.2);
    onMove(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => audio.drop(0.8, 0.12)}
      onDragEnd={end}
      accessibility={{ announcements, screenReaderInstructions: { draggable: 'Чтобы переставить: пробел — взять, стрелки — двигать, пробел — поставить, Esc — отмена.' } }}
    >
      <SortableContext items={ids as string[]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function useSortableRow(id: string) {
  const s = useSortable({ id });
  const style: CSSProperties = { transform: CSS.Translate.toString(s.transform), transition: s.transition };
  return {
    ref: s.setNodeRef,
    style,
    dragging: s.isDragging,
    handle: { ref: s.setActivatorNodeRef, ...s.attributes, ...s.listeners },
  };
}

export function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  const [x] = out.splice(from, 1);
  if (x !== undefined) out.splice(to, 0, x);
  return out;
}
