// Things that float over any scene: pause, lost connection, the organizer's banner, key hints
// and the short feedback toast for the organizer's key presses. CSS chrome only (LiquidOff), since
// they cover the liquid content.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChromeText, LiquidOff, cx, fmtClock, graphemes } from '../../visual';
import type { PauseView } from '../../host';

// ------------------------------------------------------------------ «стоп-экран»

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Text size by length: a word or two fills the screen, a paragraph still fits. */
function holdSize(t: string): string {
  const n = graphemes(t).length;
  if (n <= 28) return 'is-xl';
  if (n <= 60) return 'is-l';
  if (n <= 110) return 'is-m';
  if (n <= 180) return 'is-s';
  return 'is-xs';
}

/**
 * The text in chrome letters; emoji stay emoji (chrome would turn them into grey blots). A leading
 * emoji («🎂 Несём торт…», the quick texts) stands big above the line.
 */
function holdParts(t: string): { icon: string | null; body: ReactNode[] } {
  const gs = graphemes(t.trim());
  let icon: string | null = null;
  if (gs.length > 2 && PICTO.test(gs[0] ?? '') && /\s/.test(gs[1] ?? '')) {
    icon = gs[0] ?? null;
    gs.splice(0, 2);
  }
  const body: ReactNode[] = [];
  let run = '';
  let emo = false;
  const flush = () => {
    if (!run) return;
    const k = body.length;
    body.push(
      emo ? (
        <span key={k} className="tv-hold-emo">
          {run}
        </span>
      ) : (
        <span key={k} className="vx-chr vx-still">
          {run}
        </span>
      ),
    );
    run = '';
  };
  for (const g of gs) {
    const e = PICTO.test(g);
    if (e !== emo && !/^\s+$/.test(g)) {
      flush();
      emo = e;
    }
    run += g;
  }
  flush();
  return { icon, body };
}

/**
 * The organizer's «стоп-экран»: the whole surface, only the text — chrome letters on the dark
 * ground, centred, big, perfectly still (no sweep, no liquid, no timer, no guests). It fades in
 * over the show and out again when the organizer takes it away (`leaving`).
 */
export function HoldScreen({ text, leaving = false, note }: { text: string; leaving?: boolean; note?: string | null }) {
  const { icon, body } = holdParts(text);
  return (
    <LiquidOff>
      <div className={cx('tv-hold', leaving && 'is-out')} data-mode="dark" role="status" aria-live="polite" aria-label={text}>
        {/* a new text («Сменить текст») fades in again */}
        <div key={text} className="tv-hold-in" aria-hidden="true">
          {icon ? <span className="tv-hold-icon">{icon}</span> : null}
          <h1 className={cx('tv-hold-h', holdSize(text))}>{body}</h1>
        </div>
        {note ? <p className="tv-hold-note">{note}</p> : null}
      </div>
    </LiquidOff>
  );
}

export function PauseOverlay({ pause, text }: { pause: PauseView; text: string }) {
  const why =
    pause.reason === 'mass-disconnect'
      ? 'У многих пропала связь — ждём, пока все вернутся'
      : pause.reason === 'recovered'
        ? 'Экран перезапустился — продолжаем с того же места'
        : null;
  return (
    <LiquidOff>
      <div className="tv-over tv-pause" role="status">
        <div className="tv-over-card">
          <p className="vx-kick">пауза</p>
          <ChromeText as="h2" className="tv-over-h">
            {text || 'Небольшая пауза — не уходи'}
          </ChromeText>
          {why ? <p className="tv-over-p">{why}</p> : null}
          {pause.remainingMs > 0 ? <p className="tv-over-t vx-mono">на таймере {fmtClock(pause.remainingMs / 1000)}</p> : null}
        </div>
      </div>
    </LiquidOff>
  );
}

export function OfflineOverlay({ text }: { text: string }) {
  return (
    <LiquidOff>
      <div className="tv-over tv-offline" role="status">
        <div className="tv-over-card">
          <i className="tv-drop-spin" aria-hidden="true" />
          <ChromeText as="h2" className="tv-over-h">
            {text || 'Связь пропала, возвращаемся в игру…'}
          </ChromeText>
          <p className="tv-over-p">Ответы гостей не потеряются — они уже на сервере</p>
        </div>
      </div>
    </LiquidOff>
  );
}

/** The organizer's announcement ribbon (loops when it does not fit). */
export function Banner({ text }: { text: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const inner = useRef<HTMLSpanElement | null>(null);
  const [loop, setLoop] = useState(false);
  useEffect(() => {
    const b = box.current;
    const i = inner.current;
    if (b && i) setLoop(i.scrollWidth > b.clientWidth - 40);
  }, [text]);
  return (
    <LiquidOff>
      <div ref={box} className={cx('tv-banner', loop && 'is-loop')} role="status" aria-live="polite">
        <span className="tv-banner-dot" aria-hidden="true" />
        <span className="tv-banner-track">
          <span ref={inner}>{text}</span>
          {loop ? <span aria-hidden="true">{text}</span> : null}
        </span>
      </div>
    </LiquidOff>
  );
}

export interface HudMsg {
  id: number;
  text: string;
  tone?: 'ok' | 'warn';
}

export function Hud({ msg }: { msg: HudMsg | null }) {
  const [shown, setShown] = useState<HudMsg | null>(null);
  useEffect(() => {
    if (!msg) return;
    setShown(msg);
    const t = window.setTimeout(() => setShown((m) => (m?.id === msg.id ? null : m)), 2200);
    return () => clearTimeout(t);
  }, [msg]);
  if (!shown) return null;
  return (
    <div key={shown.id} className={cx('tv-hud', shown.tone === 'warn' && 'is-warn')} role="status">
      {shown.text}
    </div>
  );
}

export function KeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <LiquidOff>
      <div className="tv-over tv-help" onClick={onClose}>
        <div className="tv-over-card">
          <p className="vx-kick">пульт экрана</p>
          <ul className="tv-keys">
            <li>
              <kbd>Пробел</kbd> <kbd>→</kbd> <span>дальше: старт, показать ответ, таблица, следующий вопрос, шаги финала</span>
            </li>
            <li>
              <kbd>P</kbd> <span>пауза / продолжить</span>
            </li>
            <li>
              <kbd>M</kbd> <span>звук вкл / выкл</span>
            </li>
            <li>
              <kbd>F</kbd> <span>полный экран</span>
            </li>
            <li>
              <kbd>H</kbd> <span>эта подсказка</span>
            </li>
          </ul>
          <p className="tv-over-p">Всё остальное — в админке на телефоне.</p>
        </div>
      </div>
    </LiquidOff>
  );
}
