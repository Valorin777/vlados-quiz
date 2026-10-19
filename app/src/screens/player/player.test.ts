// The phone's fixture states come from the real pure host: if the host or the view models change
// shape, these catch it before a screenshot run does. Plus the Russian text helpers.

import { describe, expect, it } from 'vitest';
import { answerText, correctText, fmtNum, heroSize, splitTitle, withUnit } from './format';
import { fixtures } from './preview/fixtures';

describe('phone fixtures', () => {
  const all = fixtures();
  const byId = (id: string) => {
    const f = all.find((x) => x.id === id);
    if (!f) throw new Error(`no fixture ${id}`);
    return f.view;
  };

  it('cover every screen a guest can see', () => {
    const screens = new Set(all.map((f) => f.view.screen));
    for (const s of ['join', 'join_closed', 'kicked', 'no_game', 'lobby', 'intro', 'question', 'answered', 'time_up', 'reveal', 'board', 'final'] as const) {
      expect(screens.has(s), s).toBe(true);
    }
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
  });

  it('put each state where the screens expect it', () => {
    expect(byId('pregame').now).toBeLessThan(byId('pregame').pub?.startsAt ?? 0);
    expect(byId('lobby-vlados').me?.isVlados).toBe(true);
    expect(byId('offline').online).toBe(false);
    expect(byId('question')).toMatchObject({ screen: 'question', canAnswer: true, question: { type: 'choice', double: true } });
    expect(byId('number').question?.number).toMatchObject({ min: 5, max: 40, unit: 'лет' });
    expect(byId('ordering').question?.items).toHaveLength(4);
    expect(byId('sending').answer?.status).toBe('sending');
    expect(byId('paused').pause).not.toBeNull();
    expect(byId('reveal-good').reveal).toMatchObject({ verdict: 'correct', correct: 'c' });
    expect(byId('reveal-good').reveal?.mine?.pts).toBeGreaterThan(1000); // ×2
    expect(byId('reveal-bad').reveal).toMatchObject({ verdict: 'wrong', vlados: { t: 'choice', id: 'a' } });
    expect(byId('reveal-none').reveal?.verdict).toBe('none');
    expect(byId('reveal-vlados').reveal?.mine?.rank).toBeNull();
    expect(byId('board').board?.top.length).toBeGreaterThan(0);
    expect(byId('final-0').final?.step).toBe(0);
    expect(byId('final-0').final?.mine).toBeNull(); // no spoilers before the gold
    expect(byId('final-3').final?.mine?.rank).toBeGreaterThan(0);
    expect(byId('final-4').final?.vlados).toBeTruthy();
  });
});

describe('phone text helpers', () => {
  it('splits the title into a lead and a chrome hero word', () => {
    expect(splitTitle('Кто лучше знает Владоса')).toEqual({ lead: 'Кто лучше знает', hero: 'ВЛАДОСА' });
    expect(splitTitle('Владос!')).toEqual({ lead: '', hero: 'ВЛАДОС!' });
    expect(splitTitle('Угадай Владоса!')).toEqual({ lead: 'Угадай', hero: 'ВЛАДОСА' });
    expect(heroSize('ВЛАДОСА')).toContain('7.14');
  });

  it('formats numbers and answers the Russian way', () => {
    expect(fmtNum(12345.5)).toBe('12 345,5');
    expect(fmtNum(-3)).toBe('−3');
    expect(withUnit(16, 'лет')).toBe('16 лет');
    const q = byQuestion();
    expect(answerText(q, { t: 'choice', id: 'c' })).toBe('Бабушкин борщ');
    expect(correctText(q, 'x')).toBe('—');
    expect(answerText(null, { t: 'number', v: 7 })).toBe('7');
  });
});

function byQuestion() {
  const q = fixtures().find((f) => f.id === 'question')?.view.question;
  if (!q) throw new Error('no question');
  return q;
}
