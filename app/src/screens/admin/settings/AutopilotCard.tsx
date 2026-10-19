// «Автопилот» (shared/engine/showTimings.ts): the host moves the show on by itself — the answer →
// the board → the next question → the whole final — with exactly the pace of «Прогнать игру». The
// same switch is at the top of «Эфир». No per-step numbers: the pace is the rehearsal's.

import { FINALE } from '@shared/engine/finale';
import { SHOW, autopilotOn } from '@shared/engine/showTimings';
import { SURPRISE } from '@shared/engine/surprise';
import type { Settings } from '@shared/types';
import { Card, Toggle } from '../ui/kit';

const sec = (ms: number): string => `${String(Math.round(ms / 100) / 10).replace('.', ',')} с`;

export function AutopilotCard({ s, set }: { s: Settings; set: (fn: (s: Settings) => void, delay?: number) => void }) {
  const on = autopilotOn(s);
  const [d, p3, p2, p1, vl] = SHOW.finalStepMs;
  return (
    <Card id="set-auto" kicker="Игра идёт сама" title="Автопилот" icon="bolt" tone={on ? 'accent' : undefined}>
      <div className="ad-stack">
        <Toggle
          label={`Автопилот: ${on ? 'вкл' : 'выкл'}`}
          hint={
            on
              ? 'Ты жмёшь только «Начать игру» — дальше всё само, в том же темпе, что в «Прогнать игру». Большая кнопка в «Эфире» показывает, что будет дальше и через сколько, и делает этот шаг сразу.'
              : 'Каждый шаг — ответ, таблица, следующий вопрос, финал — по большой кнопке в «Эфире».'
          }
          checked={on}
          onChange={(v) => set((x) => void (x.autopilot = v), 0)}
        />
        <ul className="ad-help" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
          <li>
            Ответ на экране — {sec(SHOW.revealMs)}; с текстом после ответа — {sec(SHOW.revealTextMs)}; с фото — {sec(SHOW.revealPictureMs)}; с видео — пока не доиграет (+{sec(SHOW.revealVideoTailMs)}).
          </li>
          <li>Таблица — {sec(SHOW.boardMs)}, потом следующий вопрос (заставка {sec(s.introMs)}).</li>
          <li>
            Финал: барабанная дробь {sec(d ?? 0)} → 3-е место {sec(p3 ?? 0)} → 2-е {sec(p2 ?? 0)} → 1-е {sec(p1 ?? 0)} → Владос против друзей {sec(vl ?? 0)} → «С днём рождения» и через{' '}
            {sec(FINALE.autoMs)} видео.
          </li>
          <li>После сюрприз-видео — ответ, и через {sec(SURPRISE.toFinalMs)} финал.</li>
          <li>«Стоп-экран» (и пауза во время вопроса) замораживает отсчёт — после продолжения он идёт с того же места.</li>
        </ul>
      </div>
    </Card>
  );
}
