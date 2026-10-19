import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { audio } from '../audio';
import { flipReorder, pulse } from '../beats';
import { useChromeBlob } from '../liquid';
import { cx } from './util';

export interface OrderItem {
  id: string;
  text: ReactNode;
  /** plain text for screen-reader announcements */
  plain?: string;
  media?: ReactNode;
}

export interface OrderListProps {
  items: readonly OrderItem[];
  /** current order (ids) */
  order: readonly string[];
  onChange: (order: string[]) => void;
  firstLabel?: string;
  lastLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** Row corner radius: half the one-line row height (ui.css `.vx-ord-row`). */
const ROW_R = 30;

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function Row({
  item,
  index,
  selected,
  disabled,
  onTap,
}: {
  item: OrderItem;
  index: number;
  selected: boolean;
  disabled: boolean;
  onTap: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled });
  const el = useRef<HTMLLIElement | null>(null);
  // a rounded box (r = half a one-line row): a row whose text wraps keeps it on the flat of the
  // chrome — as a pill its first and last lines sat on the dark rim of a fat capsule
  const blob = useChromeBlob(el, { shape: 'box', cr: ROW_R, film: isDragging || selected ? 0.8 : 0.34, glow: isDragging ? 0.18 : selected ? 0.12 : 0 });
  return (
    <li
      ref={(n) => {
        setNodeRef(n);
        el.current = n;
      }}
      data-flip-id={item.id}
      className={cx('vx-ord-row lq', isDragging && 'is-dragging', selected && 'is-selected')}
      data-tone={selected ? 'film' : undefined}
      style={{ transform: CSS.Translate.toString(transform), transition: transition ?? undefined }}
      {...attributes}
      {...listeners}
      aria-label={`${index + 1}. ${item.plain ?? ''}`}
      onClick={() => {
        if (disabled) return;
        pulse(blob.current, 0.3, 0.5);
        onTap(item.id);
      }}
    >
      <span className="vx-ord-n vx-mono" aria-hidden="true">
        {index + 1}
      </span>
      {item.media ? <span className="vx-ord-media">{item.media}</span> : null}
      <span className="vx-ord-text vx-eng">{item.text}</span>
      <span className="vx-ord-grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </li>
  );
}

/**
 * Ordering question: drag rows (dnd-kit, pointer + keyboard) or tap one row then another to swap
 * them. Controlled: `order` in, `onChange(newOrder)` out.
 */
export function OrderList({ items, order, onChange, firstLabel = 'Раньше', lastLabel = 'Позже', disabled = false, className }: OrderListProps) {
  const [sel, setSel] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const ids = order.filter((id) => byId.has(id));
  const name = (id: unknown) => byId.get(String(id))?.plain ?? 'пункт';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onStart = (_e: DragStartEvent) => {
    setSel(null);
    audio.drop(1.1, 0.25);
  };
  const onEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onChange(arrayMove(ids, from, to));
    audio.drop(0.8, 0.3);
  };
  const onTap = (id: string) => {
    if (!sel) {
      setSel(id);
      audio.drop(1.3, 0.2);
      return;
    }
    if (sel === id) {
      setSel(null);
      return;
    }
    const a = ids.indexOf(sel);
    const b = ids.indexOf(id);
    const next = ids.slice();
    next[a] = id;
    next[b] = sel;
    const rows = listRef.current ? Array.from(listRef.current.querySelectorAll('.vx-ord-row')) : [];
    flipReorder(rows, () => flushSync(() => {
      setSel(null);
      onChange(next);
    }), { duration: 0.55, stagger: 0 });
    audio.drop(0.9, 0.3);
  };

  return (
    <div className={cx('vx-ord', disabled && 'is-disabled', className)}>
      <p className="vx-kick vx-ord-edge">↑ {firstLabel}</p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragStart={onStart}
        onDragEnd={onEnd}
        accessibility={{
          screenReaderInstructions: {
            draggable: 'Чтобы переставить: пробел — взять, стрелки — двигать, пробел — поставить, Escape — отмена. Или коснись двух пунктов, чтобы поменять их местами.',
          },
          announcements: {
            onDragStart: ({ active }) => `Взят пункт «${name(active.id)}».`,
            onDragOver: ({ active, over }) => (over ? `«${name(active.id)}» над позицией ${ids.indexOf(String(over.id)) + 1}.` : undefined),
            onDragEnd: ({ active, over }) => (over ? `«${name(active.id)}» теперь на позиции ${ids.indexOf(String(over.id)) + 1}.` : 'Отпущено.'),
            onDragCancel: ({ active }) => `Отмена, «${name(active.id)}» на месте.`,
          },
        }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol ref={listRef} className="vx-ord-list">
            {ids.map((id, i) => {
              const it = byId.get(id);
              return it ? <Row key={id} item={it} index={i} selected={sel === id} disabled={disabled} onTap={onTap} /> : null;
            })}
          </ol>
        </SortableContext>
      </DndContext>
      <p className="vx-kick vx-ord-edge">↓ {lastLabel}</p>
      <p className="vx-small vx-ord-hint">{sel ? 'Теперь коснись, с чем поменять' : 'Тяни пункты или коснись двух, чтобы поменять местами'}</p>
    </div>
  );
}
