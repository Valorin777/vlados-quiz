// Between questions: your place on a chrome plate (rolling up from the previous one) and the
// top five — the TV shows the full table.

import { gsap } from 'gsap';
import { useRef, useState } from 'react';
import type { PlayerView } from '../../host/views';
import { ChromeBlock, ChromeText, Odometer, audio, beats, cx, plural, type Blob } from './vx';
import { fmtNum } from './format';
import { useEntrance } from './hooks';
import { Hud } from './parts';

export function Board({ view }: { view: PlayerView }) {
  const root = useRef<HTMLDivElement | null>(null);
  const plate = useRef<Blob | null>(null);
  const b = view.board;
  const mine = b?.mine ?? null;
  const vlados = view.me?.isVlados === true;
  const rank = mine?.rank ?? view.score?.rank ?? null;
  const prev = mine?.prev ?? null;
  const tot = mine?.tot ?? view.score?.tot ?? 0;
  const [shownRank, setShownRank] = useState(prev ?? rank ?? 0);
  const [shownTot, setShownTot] = useState(Math.max(0, tot - (mine?.pts ?? 0)));

  useEntrance(() => {
    const s = gsap.utils.selector(root);
    const tl = gsap.timeline();
    setShownRank(prev ?? rank ?? 0);
    setShownTot(Math.max(0, tot - (mine?.pts ?? 0)));
    tl.add(beats.fadeUp(s('.pl-f'), { stagger: 0.06 }), 0.05);
    tl.add(beats.countTo(Math.max(0, tot - (mine?.pts ?? 0)), tot, setShownTot, { duration: 1.1, step: 10 }), 0.7);
    if (rank !== null) {
      tl.call(
        () => {
          setShownRank(rank);
          if (prev !== null && rank < prev) {
            beats.pulse(plate.current, 0.9, 1.2);
            audio.bell(784, 0.1, 1.2);
          } else beats.pulse(plate.current, 0.4, 0.8);
        },
        undefined,
        1.9,
      );
    }
    tl.add(beats.fadeUp(s('.pl-top li'), { stagger: 0.06, y: 14 }), 1.1);
    return tl;
  }, [view.reveal?.i]);

  const top = (b?.top ?? []).slice(0, 5);
  const inTop = top.some((r) => r.uid === view.me?.uid);
  const fifth = top[4];
  const gap = !vlados && rank !== null && rank > 5 && fifth ? Math.max(0, fifth.score - tot) : null;
  const up = rank !== null && prev !== null ? prev - rank : 0;
  const n = view.question?.n;

  return (
    <div className="pl-screen pl-board" ref={root}>
      <Hud view={view} game />
      <p className="vx-kick pl-f">{n ? `после вопроса ${n} из ${view.question?.total ?? n}` : view.texts.boardTitle}</p>
      <ChromeText as="h2" size="h1" className="pl-f pl-b-h">
        {vlados ? 'Твой счёт' : 'Твоё место'}
      </ChromeText>
      <ChromeBlock shape="box" radius={30} film={0.4} blobRef={plate} className="pl-b-plate">
        {vlados || rank === null ? (
          <span className="pl-b-out vx-eng">{vlados ? view.texts.outOfCompetition : 'ещё без места'}</span>
        ) : (
          <span className="pl-b-rank vx-eng">
            #<Odometer value={shownRank} />
          </span>
        )}
        <span className="pl-b-score vx-eng">
          <Odometer value={shownTot} /> {plural(tot, ['очко', 'очка', 'очков'])}
        </span>
      </ChromeBlock>
      <p className="vx-lead pl-f pl-b-line">
        {vlados
          ? 'Ты вне зачёта — зато в финале узнаем, насколько ты знаешь себя.'
          : rank === null
            ? 'Отвечай на следующий — и попадёшь в таблицу.'
            : prev === null
              ? rank <= 3
                ? 'Мощный старт! Теперь главное — не расслабляться.'
                : 'Первый вопрос позади — дальше только вверх.'
              : up > 0
              ? `Обогнал ${up} ${plural(up, ['человека', 'человек', 'человек'])} за один вопрос!`
              : rank === 1
                ? 'Ты первый. Все смотрят тебе в спину.'
                : up < 0
                  ? 'Чуть сдал позиции — следующий вопрос всё исправит.'
                  : 'Держишь позицию.'}
      </p>
      {gap !== null ? <p className="vx-body pl-f">До пятёрки — {fmtNum(gap)} {plural(gap, ['очко', 'очка', 'очков'])}.</p> : null}
      {top.length ? (
        <ol className="pl-top pl-f" aria-label={view.texts.boardTitle}>
          {top.map((row) => (
            <li key={row.uid} className={cx(row.uid === view.me?.uid && 'is-me')}>
              <span className="pl-top-n">{row.rank}</span>
              <span className="pl-top-name">{row.name}</span>
              <span className="pl-top-s vx-mono">{fmtNum(row.score)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {!inTop && !vlados && rank !== null && rank > 5 ? <p className="vx-small pl-f pl-center">полная таблица — на большом экране</p> : null}
    </div>
  );
}
