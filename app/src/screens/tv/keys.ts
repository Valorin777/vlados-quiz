// The organizer's main key on the TV (Space / → / Enter / clicker PageDown): one action per
// phase, derived only from AdminView.can — pure, so the DEV rehearsal script uses it too.

import type { AdminView, HostCommand } from '../../host';

export interface MainAction {
  cmd: HostCommand;
  /** feedback shown on the TV */
  label: string;
  /** when set, a second press within 2.5 s is needed (revealing while time is still running) */
  confirm?: string;
}

/** What Space / → does right now (null: nothing to do). */
export function mainAction(v: AdminView): MainAction | null {
  // «стоп-экран» (the parents' video in another tab…): a stray key must not end it — press twice
  if (v.hold) {
    return v.can.unhold
      ? { cmd: { type: 'unhold' }, label: 'Убираем надпись — продолжаем', confirm: 'Стоп-экран. Нажми ещё раз — уберём надпись и продолжим' }
      : null;
  }
  if (v.pause) return v.can.resume ? { cmd: { type: 'resume' }, label: 'Продолжаем' } : null;
  // «Сюрприз»: the TV reports the end of the video by itself; Space = «досмотрели» (a second
  // press while most of the video is still ahead)
  if (v.can.surpriseEnd && v.surprise) {
    const early = v.surprise.endAt - v.now > 8_000;
    return {
      cmd: { type: 'surpriseEnd', phaseRev: v.phaseRev },
      label: 'Досмотрели — к ответу',
      ...(early ? { confirm: 'Видео ещё идёт. Нажми ещё раз — остановим его и покажем ответ' } : {}),
    };
  }
  if (v.can.start) return { cmd: { type: 'start' }, label: 'Поехали!' };
  // a video question: the answers open after the video; Space = «досмотрели» (the TV reports the
  // end by itself — a press while most of the video is still ahead needs a second one)
  if (v.can.watchEnd && v.watch) {
    const early = v.watch.stage === 'play' && v.watch.untilAt - v.now > 8_000;
    return {
      cmd: { type: 'watchEnd', phaseRev: v.phaseRev },
      label: 'Видео досмотрели — старт',
      ...(early ? { confirm: 'Видео ещё идёт. Нажми ещё раз — остановим его и откроем ответы' } : {}),
    };
  }
  // locked: the host reveals by itself after the grace window (late answers still arrive)
  if (v.phase === 'open') {
    if (!v.can.reveal) return null;
    // a «Сюрприз» question: «Показать ответ» starts the video now (the answer comes after it)
    if (v.surpriseIn) {
      return { cmd: { type: 'reveal', phaseRev: v.phaseRev }, label: 'Сюрприз!', confirm: 'Сюрприз-видео начнётся само. Нажми ещё раз — запустим его прямо сейчас' };
    }
    const left = v.timer?.remainingMs ?? 0;
    const early = left > 3000 && v.counts.answered < v.counts.players;
    return {
      cmd: { type: 'reveal', phaseRev: v.phaseRev },
      label: 'Показываем ответ',
      ...(early ? { confirm: 'Время ещё идёт. Нажми ещё раз — покажем ответ досрочно' } : {}),
    };
  }
  if (v.can.advance) {
    const label = v.phase === 'reveal' ? (v.revealToFinal ? 'К финалу' : 'Таблица') : v.phase === 'board' ? (v.next ? 'Следующий вопрос' : 'К финалу') : v.phase === 'final' && (v.final?.step ?? 0) === 5 ? 'Финальное видео' : 'Дальше';
    return { cmd: { type: 'advance', phaseRev: v.phaseRev }, label };
  }
  return null;
}

