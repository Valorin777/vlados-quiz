import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, TEXT_KEY_LIST, TEXT_KEYS, getText, seedContent } from '../defaults';
import { sigilShapes, sigilSpec, sigilSvg } from '../sigil';
import { nameKey, normalizeName, resolveAppearance, rng, shuffleNotIdentity } from '../util';
import { AdminCmdSchema, ContentSchema, QuestionSchema, SettingsPatchSchema, SettingsSchema } from '../validate';

describe('defaults', () => {
  it('seed content and default settings pass validation', () => {
    const c = seedContent();
    expect(ContentSchema.safeParse(c).success).toBe(true);
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
    expect(c.questions).toHaveLength(6);
    expect(c.questions.every((q) => q.title.endsWith(' (шаблон)'))).toBe(true);
    expect(new Set(c.questions.map((q) => q.type))).toEqual(new Set(['choice', 'number', 'ordering']));
  });

  it('seedContent returns independent copies', () => {
    const a = seedContent();
    a.settings.title = 'x';
    expect(seedContent().settings.title).toBe(DEFAULT_SETTINGS.title);
  });

  it('every text key has a default and {vlados} is substituted', () => {
    for (const k of TEXT_KEY_LIST) expect(TEXT_KEYS[k].def.length).toBeGreaterThan(0);
    const s = { texts: { thanks: '  ' }, vladosLabel: 'Влад' };
    expect(getText(s, 'thanks')).toContain('Влад!');
    expect(getText({ texts: { thanks: 'Пока, {vlados}' }, vladosLabel: 'Влад' }, 'thanks')).toBe('Пока, Влад');
  });
});

describe('validate', () => {
  it('rejects a choice question whose correct id is not an option', () => {
    const q = { ...seedContent().questions[0], correctId: 'nope' };
    expect(QuestionSchema.safeParse(q).success).toBe(false);
  });

  it('rejects a number question with zeroAt ≤ tolerance', () => {
    const q = seedContent().questions.find((x) => x.type === 'number');
    expect(QuestionSchema.safeParse({ ...q, zeroAt: 1, tolerance: 1 }).success).toBe(false);
  });

  it('settings patch accepts null to remove wifi', () => {
    expect(SettingsPatchSchema.safeParse({ wifi: null, tvAppearance: 'light' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ tvAppearance: 'pink' }).success).toBe(false);
  });

  it('admin commands', () => {
    expect(AdminCmdSchema.safeParse({ type: 'advance', phaseRev: 3 }).success).toBe(true);
    expect(AdminCmdSchema.safeParse({ type: 'advance' }).success).toBe(false);
    expect(AdminCmdSchema.safeParse({ type: 'launchRockets' }).success).toBe(false);
  });
});

describe('util', () => {
  it('normalizes names', () => {
    expect(normalizeName('  Вася \t Пупкин ')).toBe('Вася Пупкин');
    expect(normalizeName('‮evil​')).toBe('evil');
    expect(normalizeName('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
    expect(normalizeName('🎉'.repeat(20))).toBe('🎉'.repeat(20));
    expect(normalizeName('x'.repeat(21))).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(42)).toBeNull();
    expect(nameKey('Алёна  Ким')).toBe(nameKey('алена ким'));
  });

  it('shuffleNotIdentity never keeps the original order', () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) expect(shuffleNotIdentity(['a', 'b', 'c'], r)).not.toEqual(['a', 'b', 'c']);
  });

  it('resolves appearance', () => {
    expect(resolveAppearance('system', true)).toBe('dark');
    expect(resolveAppearance('system', false)).toBe('light');
    expect(resolveAppearance('light', true)).toBe('light');
  });
});

describe('sigil', () => {
  it('is deterministic and differs between seeds', () => {
    expect(sigilSpec(42)).toEqual(sigilSpec(42));
    expect(sigilSvg(sigilSpec(1), 'dark')).not.toBe(sigilSvg(sigilSpec(2), 'dark'));
  });

  it('produces shapes within the unit square and hex colors for both modes', () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = sigilSpec(seed);
      for (const mode of ['light', 'dark'] as const) {
        for (const c of Object.values(s.colors[mode])) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
      for (const sh of sigilShapes(s)) {
        const pts = sh.t === 'poly' ? sh.pts : [[sh.cx, sh.cy] as const];
        for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.001);
      }
    }
  });
});
