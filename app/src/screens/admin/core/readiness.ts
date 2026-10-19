// «Готово к игре»: what the organizer still has to fix before Saturday (pure, tested).

import { SURPRISE } from '@shared/engine/surprise';
import { QuestionSchema } from '@shared/validate';
import type { Question, Settings } from '@shared/types';

export type ProblemLevel = 'block' | 'warn';

export interface Problem {
  qid: string;
  level: ProblemLevel;
  text: string;
}

export interface Readiness {
  /** Enabled questions. */
  active: number;
  total: number;
  /** Rough length of the whole show, seconds. */
  durationS: number;
  problems: Problem[];
  /** Per question: worst level. */
  byQid: Record<string, ProblemLevel>;
  /** 0..1 for the meter. */
  score: number;
}

/** Per question on top of intro + timer: reveal, table, talking. */
export const TALK_PER_QUESTION_S = 28;
/** Lobby start + final ceremony. */
export const SHOW_OVERHEAD_S = 4 * 60;

const TEMPLATE_RE = /\(шаблон\)|^ШАБЛОН/i;

export const isTemplate = (q: Question): boolean => TEMPLATE_RE.test(q.title) || TEMPLATE_RE.test(q.notes ?? '');

/** Media ids a question refers to (main, reveal, options/items). */
export function mediaIdsOf(q: Question): string[] {
  const ids: string[] = [];
  if (q.media) ids.push(q.media.mediaId);
  if (q.revealMedia) ids.push(q.revealMedia.mediaId);
  if (q.surprise?.on && q.surprise.src === 'custom' && q.surprise.mediaId) ids.push(q.surprise.mediaId);
  const items = q.type === 'choice' ? q.options : q.type === 'ordering' ? q.items : [];
  for (const it of items) if (it.mediaId) ids.push(it.mediaId);
  return ids;
}

/**
 * `mediaOk(id)`: true = exists, false = missing, undefined = not checked yet (no problem reported).
 */
export function readiness(questions: readonly Question[], settings: Pick<Settings, 'introMs'>, mediaOk: (id: string) => boolean | undefined): Readiness {
  const problems: Problem[] = [];
  const add = (qid: string, level: ProblemLevel, text: string) => {
    if (!problems.some((p) => p.qid === qid && p.text === text)) problems.push({ qid, level, text });
  };
  let durationS = SHOW_OVERHEAD_S;
  const active = questions.filter((q) => !q.disabled);
  for (const q of active) {
    durationS += settings.introMs / 1000 + q.timeLimitS + TALK_PER_QUESTION_S;
    const parsed = QuestionSchema.safeParse(q);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join('.');
        let text = issue.message;
        if (path === 'correctId') text = 'Не выбран правильный ответ';
        else if (path.startsWith('options') && /\.\d+$/.test(path)) text = 'Пустой вариант ответа';
        else if (path.startsWith('items') && /\.\d+$/.test(path)) text = 'Пустой пункт';
        else if (path === 'options') text = 'Нужно от 2 до 6 вариантов';
        else if (path === 'items') text = 'Нужно от 3 до 6 пунктов';
        else if (path === 'title') text = 'Нет текста вопроса';
        else if (!/[а-яё]/i.test(text)) text = `Проверь поле «${path}»`;
        add(q.id, 'block', text);
      }
    }
    for (const id of mediaIdsOf(q)) if (mediaOk(id) === false) add(q.id, 'block', 'Файл не найден — загрузи заново');
    if (q.type === 'choice' && q.options.some((o) => o.mediaId) && q.options.some((o) => !o.mediaId && !o.text?.trim())) {
      add(q.id, 'block', 'У варианта нет ни текста, ни картинки');
    }
    if (isTemplate(q)) add(q.id, 'warn', 'Это шаблон — замени на настоящий вопрос');
    const sp = q.surprise;
    if (sp?.on) {
      if (sp.afterS >= q.timeLimitS) add(q.id, 'warn', `Сюрприз должен начаться раньше, чем кончится время (${q.timeLimitS} с) — начнётся за секунду до конца`);
      if (sp.src === 'custom' && !sp.mediaId) add(q.id, 'warn', 'Сюрприз: своё видео не загружено — покажем встроенное');
      // the video plays instead of the rest of the time; then the answer and the final
      durationS += (sp.src === 'custom' ? 60_000 : SURPRISE.builtin.ms) / 1000;
    }
  }
  if (!active.length) problems.unshift({ qid: '', level: 'block', text: 'Нет ни одного включённого вопроса' });

  const byQid: Record<string, ProblemLevel> = {};
  for (const p of problems) if (p.qid && byQid[p.qid] !== 'block') byQid[p.qid] = p.level;
  const bad = active.filter((q) => byQid[q.id] === 'block').length;
  const warn = active.filter((q) => byQid[q.id] === 'warn').length;
  const score = active.length ? Math.max(0, (active.length - bad - warn * 0.5) / active.length) : 0;
  return { active: active.length, total: questions.length, durationS, problems, byQid, score };
}
