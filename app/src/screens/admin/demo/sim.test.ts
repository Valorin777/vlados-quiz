// The «Эфир» big button drives a whole game (lobby → questions → final step 5) on the simulator,
// which runs the real host step(); results and CSV come out consistent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { heroAction } from '../core/live';
import { roundStats, standings, standingsCsv } from '../core/results';
import { seedDoc } from '../core/seed';
import { SimHost } from './sim';

afterEach(() => {
  vi.useRealTimers();
});

describe('rehearsal simulator + hero button', () => {
  it('autopilot off: plays the 6 templates with 3 bots from «Начать игру» to «Спасибо всем!»', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-26T16:00:00Z') });
    const content = seedDoc(true);
    content.settings.autopilot = false;
    for (const q of content.questions) q.timeLimitS = 20;
    const sim = new SimHost(content);
    sim.start();
    sim.addBots(3);
    const labels: string[] = [];
    let presses = 0;
    for (let guard = 0; guard < 500; guard++) {
      let v = sim.adminView();
      if (v.phase === 'final' && (v.final?.step ?? 0) >= 5) break;
      if (v.phase === 'open') {
        // let the bots think, then close the question early from the button
        await vi.advanceTimersByTimeAsync(16_000);
        v = sim.adminView();
        if (v.phase !== 'open') continue;
      }
      // the action from the view as it is now (its phaseRev), not from before the wait
      const a = heroAction(v);
      if (!a.cmd) {
        await vi.advanceTimersByTimeAsync(500);
        continue;
      }
      if (labels[labels.length - 1] !== a.label) labels.push(a.label);
      const p = sim.command(a.cmd);
      await vi.advanceTimersByTimeAsync(300);
      const r = await p;
      // 'stale' = the host's own timer made the same move a moment earlier (bots answer at random
      // times, so an auto lock / reveal can land inside this 300 ms): the button is simply done
      expect(r.ok || r.error === 'stale', `${a.label} in ${v.phase}: ${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) presses++;
    }
    const v = sim.adminView();
    sim.stop();
    expect(v.phase).toBe('final');
    expect(v.final?.step).toBe(5);
    expect(labels[0]).toBe('Начать игру');
    expect(labels).toContain('Таблица');
    expect(labels).toContain('Следующий вопрос');
    expect(labels).toContain('Финал');
    expect(labels).toContain('Показать 1 место');
    expect(presses).toBeGreaterThan(20);

    const s = sim.snapshot();
    const rows = standings(s);
    const rounds = roundStats(s);
    expect(rows).toHaveLength(3);
    expect(rounds.filter((r) => r.revealed)).toHaveLength(6);
    expect(rows.some((r) => r.score > 0)).toBe(true);
    const csv = standingsCsv(rows, rounds);
    expect(csv.split('\r\n')).toHaveLength(5);
  });

  it('autopilot (the default): «Начать игру» is the only press — the rest runs by itself, the button counts down', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-26T16:00:00Z') });
    const content = seedDoc(true);
    expect(content.settings.autopilot).toBe(true);
    for (const q of content.questions) q.timeLimitS = 20;
    const sim = new SimHost(content);
    sim.start();
    sim.addBots(3);
    const first = heroAction(sim.adminView());
    expect(first.label).toBe('Начать игру');
    const p = sim.command(first.cmd!);
    await vi.advanceTimersByTimeAsync(300);
    expect((await p).ok).toBe(true);
    const labels = new Set<string>();
    for (let s = 0; s < 900; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      const v = sim.adminView();
      labels.add(heroAction(v).label.replace(/\d+ с$/, 'N с'));
      if (v.phase === 'final' && (v.final?.step ?? 0) >= 6) break;
    }
    const v = sim.adminView();
    sim.stop();
    expect(v.phase).toBe('final');
    expect(v.final?.step).toBe(6);
    expect(sim.snapshot().totals?.rounds.filter((r) => r.res)).toHaveLength(6);
    for (const l of ['Таблица через N с', 'Вопрос 2 через N с', 'Вопрос 6 через N с', 'Финал через N с', '3-е место через N с', '2-е место через N с', '1-е место через N с', 'С днём рождения через N с', 'Финальное видео через N с']) {
      expect(labels, l).toContain(l);
    }
  });

  it('pause, +15 s, skip and a stale double tap', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-26T16:00:00Z') });
    const sim = new SimHost(seedDoc(true));
    sim.start();
    sim.addBots(2);
    const run = async (cmd: Parameters<SimHost['command']>[0]) => {
      const p = sim.command(cmd);
      await vi.advanceTimersByTimeAsync(300);
      return p;
    };
    expect((await run({ type: 'start' })).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    let v = sim.adminView();
    expect(v.phase).toBe('open');
    expect(v.can.pause).toBe(true);
    expect((await run({ type: 'pause' })).ok).toBe(true);
    v = sim.adminView();
    expect(v.pause).not.toBeNull();
    expect(heroAction(v).cmd?.type).toBe('reveal');
    expect((await run({ type: 'resume' })).ok).toBe(true);
    const before = sim.adminView().timer?.remainingMs ?? 0;
    expect((await run({ type: 'addTime', ms: 15_000 })).ok).toBe(true);
    expect(sim.adminView().timer?.remainingMs ?? 0).toBeGreaterThan(before + 10_000);
    const rev = sim.adminView().phaseRev;
    expect((await run({ type: 'skip', phaseRev: rev })).ok).toBe(true);
    expect(await run({ type: 'skip', phaseRev: rev })).toEqual({ ok: false, error: 'stale' });
    sim.stop();
  });
});
