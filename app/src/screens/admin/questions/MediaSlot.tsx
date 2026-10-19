// A place for a photo or a video: drop a file, paste (⌘V), pick one, or shoot with the camera.
// Images are resized to 1600 px JPEG; videos are compressed to 720p in the browser (progress %).

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { cx, toast } from '../../../visual';
import { MediaError, processAndUpload, useMediaMeta, useMediaUrl, type MediaProgress, type UploadedMedia } from '../core/media';
import { useAdmin } from '../core/session';
import { Btn, Meter, Toggle } from '../ui/kit';
import { Icon } from '../ui/icons';

const STAGE: Record<MediaProgress['stage'], string> = {
  reading: 'Открываю файл…',
  converting: 'Сжимаю видео…',
  uploading: 'Загружаю…',
  done: 'Готово!',
};

export function useUploader(accept: 'image' | 'video' | 'any', onDone: (m: UploadedMedia) => void) {
  const { backend } = useAdmin();
  const [progress, setProgress] = useState<MediaProgress | null>(null);
  const busy = progress !== null;
  const upload = async (file: File | Blob) => {
    if (busy) return;
    setProgress({ stage: 'reading', p: 0 });
    try {
      const m = await processAndUpload(backend.media, file, { accept, onProgress: setProgress });
      onDone(m);
      toast(m.kind === 'video' ? 'Видео загружено' : 'Фото загружено', { tone: 'good' });
    } catch (e) {
      toast(e instanceof MediaError ? e.message : 'Не получилось загрузить — проверь интернет и попробуй ещё раз', { tone: 'bad', ms: 6000 });
    } finally {
      setProgress(null);
    }
  };
  return { progress, busy, upload };
}

const fmtBytes = (b: number): string => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} КБ` : `${(b / 1024 / 1024).toFixed(1)} МБ`);

function firstFile(list: FileList | DataTransferItemList | null | undefined): File | null {
  if (!list) return null;
  for (const x of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = x instanceof File ? x : x.kind === 'file' ? x.getAsFile() : null;
    if (f) return f;
  }
  return null;
}

export function MediaPreview({ mediaId, className }: { mediaId: string; className?: string }) {
  const meta = useMediaMeta(mediaId);
  const file = useMediaUrl(meta ? mediaId : undefined);
  const poster = useMediaUrl(meta?.kind === 'video' ? meta.posterId : undefined);
  if (meta === null || file.failed) {
    return (
      <div className={cx('ad-media', className)} style={{ borderColor: 'var(--hot)' }}>
        <Icon name="alert" size={26} />
        <p className="ad-hint is-error">Файл не найден — загрузи заново</p>
      </div>
    );
  }
  if (!meta || !file.url) {
    return (
      <div className={cx('ad-media', className)}>
        <p className="vx-kick">Загружаю превью…</p>
      </div>
    );
  }
  return meta.kind === 'video' ? (
    <video className="ad-media-img" src={file.url} poster={poster.url ?? undefined} controls playsInline preload="metadata" />
  ) : (
    <img className="ad-media-img" src={file.url} alt="" />
  );
}

export function MediaSlot({
  mediaId,
  accept = 'any',
  onChange,
  title = 'Фото или видео к вопросу',
  hint,
  pasteTarget = false,
  extra,
  className,
}: {
  mediaId: string | undefined;
  accept?: 'image' | 'video' | 'any';
  onChange: (m: UploadedMedia | null) => void;
  title?: string;
  hint?: ReactNode;
  /** Receives ⌘V anywhere on the page (the main slot of an editor). */
  pasteTarget?: boolean;
  extra?: ReactNode;
  className?: string;
}) {
  const meta = useMediaMeta(mediaId);
  const { progress, upload } = useUploader(accept, onChange);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement | null>(null);
  const cam = useRef<HTMLInputElement | null>(null);
  const zone = useRef<HTMLDivElement | null>(null);
  const types = accept === 'image' ? 'image/*' : accept === 'video' ? 'video/*' : 'image/*,video/*';

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest('input, textarea, [contenteditable]');
      const mine = zone.current?.contains(target ?? null);
      if (!mine && (!pasteTarget || inField)) return;
      const f = firstFile(e.clipboardData?.items);
      if (!f) return;
      e.preventDefault();
      void upload(f);
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  });

  const inputs = (
    <>
      <input
        ref={pick}
        type="file"
        accept={types}
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void upload(f);
        }}
      />
      <input
        ref={cam}
        type="file"
        accept={types}
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void upload(f);
        }}
      />
    </>
  );

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const f = firstFile(e.dataTransfer.files);
      if (f) void upload(f);
    },
  };

  const progressLayer = progress ? (
    <div className="ad-media-progress" role="status" aria-live="polite">
      <span className="ad-media-pct vx-chr">{Math.round(progress.p * 100)}%</span>
      <Meter value={progress.p} />
      <span className="ad-hint">{progress.note ?? STAGE[progress.stage]}</span>
    </div>
  ) : null;

  if (mediaId) {
    return (
      <div ref={zone} className={cx('ad-media has-file', over && 'is-over', className)} tabIndex={-1} {...dropProps}>
        {inputs}
        <MediaPreview mediaId={mediaId} />
        <div className="ad-media-over">
          <span className="ad-hint ad-clip" style={{ flex: 1 }}>
            {meta ? `${meta.kind === 'video' ? `Видео${meta.durationS ? ` · ${Math.round(meta.durationS)} с` : ''}` : 'Фото'} · ${meta.w}×${meta.h} · ${fmtBytes(meta.bytes)}` : ''}
          </span>
          {extra}
          <Btn size="s" icon="refresh" onClick={() => pick.current?.click()}>
            Заменить
          </Btn>
          <Btn size="s" icon="trash" tone="danger" onClick={() => onChange(null)}>
            Убрать
          </Btn>
        </div>
        {progressLayer}
      </div>
    );
  }

  return (
    <div ref={zone} className={cx('ad-media', over && 'is-over', className)} tabIndex={0} aria-label={title} {...dropProps}>
      {inputs}
      <Icon name={accept === 'image' ? 'image' : 'upload'} size={28} />
      <div>
        <p className="ad-strong" style={{ margin: 0, fontWeight: 650 }}>
          {title}
        </p>
        <p className="ad-hint" style={{ marginTop: 4 }}>
          {hint ?? (accept === 'image' ? 'Перетащи сюда, вставь ⌘V или выбери файл' : 'Перетащи сюда, вставь ⌘V или выбери. Видео сожмётся до 720p прямо в браузере.')}
        </p>
      </div>
      <div className="ad-media-actions">
        <Btn size="s" icon="upload" onClick={() => pick.current?.click()}>
          Выбрать файл
        </Btn>
        <Btn size="s" icon="camera" tone="ghost" onClick={() => cam.current?.click()}>
          Камера
        </Btn>
      </div>
      {progressLayer}
    </div>
  );
}

export const VIDEO_TV_ONLY = 'Видео играет только на большом экране, со звуком. На телефонах — варианты сразу после видео';

/**
 * Where the question's main media shows. A photo: on the phones too, or only on the TV (the switch).
 * A video: ONLY on the TV, with sound (organizer, 2026-09-23) — no switch, just the note; the phones
 * get the options right after the video (the host ignores «на телефонах» for videos).
 */
export function PhonesMode({ mediaId, onPhones, onChange }: { mediaId: string; onPhones: boolean; onChange: (v: boolean) => void }) {
  const meta = useMediaMeta(mediaId);
  if (meta === undefined) return null;
  if (meta?.kind === 'video') {
    return (
      <p className="ad-hint ad-mt ad-row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Icon name="tv" size={16} />
        <span>{VIDEO_TV_ONLY}</span>
      </p>
    );
  }
  return (
    <Toggle
      className="ad-mt"
      label="Показывать и в телефонах"
      hint="Выключи, если картинка — подсказка только для большого экрана."
      checked={onPhones}
      onChange={onChange}
    />
  );
}

/** Small square picture button for an option / ordering item. */
export function ItemImage({ mediaId, onChange }: { mediaId: string | undefined; onChange: (id: string | undefined) => void }) {
  const { progress, upload } = useUploader('image', (m) => onChange(m.id));
  const url = useMediaUrl(mediaId).url;
  const pick = useRef<HTMLInputElement | null>(null);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className={cx('ad-optimg', mediaId && 'has-img')}
        aria-label={mediaId ? 'Заменить картинку' : 'Добавить картинку'}
        title={mediaId ? 'Заменить картинку' : 'Добавить картинку'}
        onClick={() => pick.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = firstFile(e.dataTransfer.files);
          if (f) void upload(f);
        }}
      >
        {progress ? <span className="ad-mono" style={{ fontSize: 11 }}>{Math.round(progress.p * 100)}%</span> : url ? <img src={url} alt="" /> : <Icon name="image" size={18} />}
      </button>
      {mediaId && !progress ? (
        <button type="button" className="ad-ibtn is-s" style={{ position: 'absolute', top: -10, right: -10, width: 22, height: 22, borderRadius: 99, background: 'var(--bg-raised)' }} aria-label="Убрать картинку" onClick={() => onChange(undefined)}>
          <Icon name="x" size={12} />
        </button>
      ) : null}
      <input
        ref={pick}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void upload(f);
        }}
      />
    </span>
  );
}
