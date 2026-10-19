// The one big button of «Эфир»: what the show needs next, from AdminView alone (pure, tested).

import type { AdminView, AutoStep, HostCommand } from '../../../host';
import { nPlayers } from './format';

export interface HeroAction {
  label: string;
  sub?: string;
  cmd?: HostCommand;
  film?: boolean;
}

export const FINAL_STEPS = ['Показать 3 место', 'Показать 2 место', 'Показать 1 место', 'Сравнить с Владосом', 'Спасибо всем!'];

/** What the autopilot's next step is called: «Таблица», «Вопрос 4», «Финал», «3-е место»… */
export function autoStepName(a: Pick<AutoStep, 'kind' | 'n'>, vlados = true): string {
  switch (a.kind) {
    case 'board':
      return 'Таблица';
    case 'question':
      return `Вопрос ${a.n ?? ''}`.trim();
    case 'final':
      return 'Финал';
    case 'step':
      return (
        { 1: '3-е место', 2: '2-е место', 3: '1-е место', 4: vlados ? 'Сравнение с Владосом' : 'Финальные титры', 5: 'С днём рождения', 6: 'Финальное видео' }[a.n ?? 0] ??
        'Дальше'
      );
  }
}

/** «Таблица через 6 с» / «Таблица — сейчас» (the countdown of the autopilot's next step). */
export function autoStepText(a: AutoStep, vlados = true): string {
  const name = autoStepName(a, vlados);
  const s = Math.ceil(a.ms / 1000);
  return s > 0 ? `${name} через ${s} с` : `${name} — сейчас`;
}

/**
 * «Автопилот» on: out of the answer, the board and the final the button shows what the host does
 * next by itself and when; pressing it does that step now (the same 'advance' as before).
 */
function autopilotHero(v: AdminView): HeroAction | null {
  const a = v.autopilot?.on ? v.autopilot.next : null;
  if (!a || (v.phase !== 'reveal' && v.phase !== 'board' && v.phase !== 'final')) return null;
  const video = a.kind === 'step' && a.n === 6;
  const sub = video && !v.tvOnAir ? 'ТВ не подключён — видео никто не увидит' : a.held ? 'стоп-экран: отсчёт стоит' : 'автопилот · нажми — покажу сразу';
  const film = a.kind !== 'board' && !(a.kind === 'step' && (a.n ?? 0) < 3);
  return { label: autoStepText(a, !!v.vladosUid), sub, cmd: { type: 'advance', phaseRev: v.phaseRev }, film };
}

export function heroAction(v: AdminView): HeroAction {
  const rev = v.phaseRev;
  const auto = autopilotHero(v);
  if (auto) return auto;
  switch (v.phase) {
    case null:
      return { label: 'Подключаюсь…' };
    case 'lobby':
      return v.can.start
        ? { label: 'Начать игру', sub: `${nPlayers(v.counts.players)} в лобби`, cmd: { type: 'start' }, film: true }
        : { label: 'Нет вопросов', sub: 'добавь или включи вопросы' };
    case 'intro': {
      const t = v.timer;
      const s = t?.kind === 'intro' && !t.paused ? Math.ceil(t.remainingMs / 1000) : 0;
      return { label: `Вопрос ${v.question?.n ?? ''} на экране`, sub: s > 0 ? `варианты через ${s} с` : 'сейчас откроется для ответов' };
    }
    case 'open': {
      // a «Сюрприз» question: the host interrupts it by itself; the button starts the video now
      const sp = v.surpriseIn;
      if (sp) {
        const sub = sp.at === null ? 'пауза — отсчёт стоит' : sp.ms > 0 ? `само начнётся через ${Math.ceil(sp.ms / 1000)} с · ответили ${v.counts.answered} из ${v.counts.players}` : 'сейчас начнётся';
        return { label: 'Сюрприз-видео сейчас', sub, cmd: { type: 'reveal', phaseRev: rev }, film: true };
      }
      return { label: 'Показать ответ', sub: `ответили ${v.counts.answered} из ${v.counts.players}`, cmd: { type: 'reveal', phaseRev: rev } };
    }
    case 'locked': {
      // the «Сюрприз» stage: the TV reports the end of the video by itself
      const s = v.surprise;
      if (s && v.can.surpriseEnd) {
        const left = Math.max(0, Math.ceil((s.endAt - v.now) / 1000));
        const sub =
          s.stage === 'glitch' ? 'сбой эфира на экране…' : s.stage === 'black' ? 'чёрный экран — сейчас видео' : s.stage === 'play' ? `видео на экране · ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'видео закончилось — сейчас ответ';
        return { label: 'Досмотрели — к ответу', sub: !v.tvOnAir ? `ТВ не подключён · ${sub}` : sub, cmd: { type: 'surpriseEnd', phaseRev: rev }, film: true };
      }
      if (s) return { label: 'Сюрприз-видео на экране', sub: 'стоп-экран' };
      return { label: 'Показать ответ', sub: 'время вышло — собираю ответы', cmd: { type: 'reveal', phaseRev: rev } };
    }
    case 'reveal':
      if (v.revealToFinal) return { label: 'Финал', sub: 'после сюрприза игра заканчивается — сам через 10 с', cmd: { type: 'advance', phaseRev: rev }, film: true };
      return { label: 'Таблица', sub: 'кто лидирует', cmd: { type: 'advance', phaseRev: rev } };
    case 'board':
      return v.next
        ? { label: 'Следующий вопрос', sub: v.next.title.slice(0, 60), cmd: { type: 'advance', phaseRev: rev }, film: true }
        : { label: 'Финал', sub: 'вопросы закончились', cmd: { type: 'advance', phaseRev: rev }, film: true };
    case 'final': {
      const step = v.final?.step ?? 0;
      const last = v.finalLast;
      // the video after the final (step 6): on air, then the end
      if (step >= 6) {
        const f = v.finale;
        return f && f.stage !== 'after' ? { label: 'Финальное видео на экране', sub: f.stage === 'gather' ? 'сейчас начнётся' : `ещё ${Math.max(1, Math.ceil((f.endAt - v.now) / 1000))} с` } : { label: 'Игра окончена', sub: 'спасибо, что провёл её!' };
      }
      if (step >= last) return { label: 'Игра окончена', sub: 'спасибо, что провёл её!' };
      if (step === 5) {
        // the host starts it by itself FINALE.autoMs after the mosaic (AdminView.finaleVideoIn)
        const c = v.finaleVideoIn;
        const sub = !v.tvOnAir
          ? 'ТВ не подключён — видео никто не увидит'
          : c?.held
            ? 'стоп-экран: отсчёт до видео стоит'
            : c
              ? c.ms > 0
                ? `само начнётся через ${Math.ceil(c.ms / 1000)} с`
                : 'сейчас начнётся'
              : 'видео на весь экран, со своим звуком';
        return { label: '▶ Финальное видео', sub, cmd: { type: 'advance', phaseRev: rev }, film: true };
      }
      const label = step === 3 && !v.vladosUid ? 'Финальные титры' : (FINAL_STEPS[step] ?? 'Дальше');
      return { label, sub: `финал · шаг ${step + 1} из ${last}`, cmd: { type: 'advance', phaseRev: rev }, film: step === 2 };
    }
  }
}

