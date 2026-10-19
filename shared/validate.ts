// zod schemas for everything that crosses a trust boundary (sockets, admin edits, files on disk).
// This is the ONLY module that imports zod; the player bundle must not import it.

import { z } from 'zod';
import { LIMITS, TEXT_KEY_LIST } from './defaults';
import type { AdminCmd, AnswerReq, AvatarReq, Binary, Handshake, JoinReq, RecoverReq, SettingsPatch } from './protocol';
import type { AnswerPayload, Content, MediaAsset, Question, Settings } from './types';

export const IdSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const finite = z.number().finite();
const nonNeg = finite.min(0);
const BinarySchema = z.custom<Binary>((v) => v instanceof ArrayBuffer || v instanceof Uint8Array, 'Ожидались бинарные данные');

// ---------- Media ----------

const FileNameSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);

export const MediaAssetSchema = z.object({
  id: IdSchema,
  kind: z.enum(['image', 'video']),
  files: z.object({ lg: FileNameSchema.optional(), sm: FileNameSchema, poster: FileNameSchema.optional() }),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  durationS: nonNeg.optional(),
  bytes: z.number().int().min(0),
  status: z.enum(['processing', 'ready', 'error']),
  progress: finite.min(0).max(1).optional(),
  error: z.string().max(1000).optional(),
  cdn: z.enum(['pending', 'queued', 'pushing', 'live', 'failed']),
  createdAt: nonNeg,
});

// ---------- Questions ----------

const ItemSchema = z
  .object({ id: IdSchema, text: z.string().max(140).optional(), mediaId: IdSchema.optional() })
  .refine((i) => Boolean(i.text?.trim() || i.mediaId), 'Нужен текст или картинка');

const QMediaSchema = z.object({ mediaId: IdSchema, onPhones: z.boolean(), startAtS: nonNeg.optional() });

/** «Сюрприз-видео» (shared/engine/surprise.ts). afterS < the time limit: checked by readiness (the engine clamps it). */
const QSurpriseSchema = z.object({
  on: z.boolean(),
  src: z.enum(['builtin', 'custom']),
  mediaId: IdSchema.optional(),
  afterS: finite.min(2).max(600),
});

const qBase = {
  id: IdSchema,
  title: z.string().trim().min(1, 'Нужен текст вопроса').max(300),
  media: QMediaSchema.optional(),
  revealMedia: QMediaSchema.optional(),
  revealText: z.string().max(1000).optional(),
  timeLimitS: z.number().int().min(5).max(600),
  double: z.boolean(),
  notes: z.string().max(4000).optional(),
  disabled: z.boolean().optional(),
  surprise: QSurpriseSchema.optional(),
};

const uniqueIds = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;

const ChoiceSchema = z
  .object({
    ...qBase,
    type: z.literal('choice'),
    options: z.array(ItemSchema).min(LIMITS.choiceOptions.min).max(LIMITS.choiceOptions.max),
    correctId: IdSchema,
  })
  .superRefine((q, ctx) => {
    if (!uniqueIds(q.options)) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Повторяются id вариантов' });
    if (!q.options.some((o) => o.id === q.correctId)) {
      ctx.addIssue({ code: 'custom', path: ['correctId'], message: 'Правильный ответ не среди вариантов' });
    }
  });

const NumberSchema = z
  .object({
    ...qBase,
    type: z.literal('number'),
    answer: finite,
    unit: z.string().max(20).optional(),
    min: finite.optional(),
    max: finite.optional(),
    step: finite.positive(),
    tolerance: nonNeg,
    zeroAt: finite.positive(),
  })
  .superRefine((q, ctx) => {
    if (q.zeroAt <= q.tolerance) {
      ctx.addIssue({ code: 'custom', path: ['zeroAt'], message: 'Порог нуля должен быть больше допуска' });
    }
    if (q.min !== undefined && q.max !== undefined && q.min >= q.max) {
      ctx.addIssue({ code: 'custom', path: ['max'], message: 'Максимум должен быть больше минимума' });
    }
    if ((q.min !== undefined && q.answer < q.min) || (q.max !== undefined && q.answer > q.max)) {
      ctx.addIssue({ code: 'custom', path: ['answer'], message: 'Ответ вне диапазона' });
    }
  });

const OrderingSchema = z
  .object({
    ...qBase,
    type: z.literal('ordering'),
    items: z.array(ItemSchema).min(LIMITS.orderingItems.min).max(LIMITS.orderingItems.max),
    firstLabel: z.string().max(40),
    lastLabel: z.string().max(40),
  })
  .superRefine((q, ctx) => {
    if (!uniqueIds(q.items)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Повторяются id пунктов' });
  });

export const QuestionSchema = z.discriminatedUnion('type', [ChoiceSchema, NumberSchema, OrderingSchema]);

// ---------- Settings ----------

const weight = finite.min(0).max(1);

export const ScoringSchema = z.object({
  base: z.number().int().min(1).max(100_000),
  choice: z.object({ speedWeight: weight }),
  number: z.object({ speedWeight: weight, accuracyShare: weight, closestShare: weight, curve: finite.min(0.1).max(10) }),
  ordering: z.object({ speedWeight: weight, partialCap: weight, gamma: finite.min(0.1).max(10) }),
  maxLatencyCreditMs: z.number().int().min(0).max(10_000),
});

const AppearanceSchema = z.enum(['system', 'light', 'dark']);
const QrModeSchema = z.enum(['direct', 'pages', 'lan']);
const autoSec = z.number().int().min(1).max(600).nullable();
const WifiSchema = z.object({ ssid: z.string().min(1).max(32), password: z.string().max(63) });

const settingsShape = {
  title: z.string().max(120),
  subtitle: z.string().max(200),
  lobbyBgMediaId: IdSchema.optional(),
  finaleVideo: z.enum(['builtin', 'custom', 'off']),
  finaleMediaId: IdSchema.optional(),
  vladosLabel: z.string().trim().min(1).max(40),
  themeId: z.string().min(1).max(40),
  tvAppearance: AppearanceSchema,
  gameStartsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Неверная дата'),
  texts: z.partialRecord(z.enum(TEXT_KEY_LIST), z.string().max(500)),
  introMs: z.number().int().min(0).max(30_000),
  lockMs: z.number().int().min(0).max(10_000),
  allAnsweredDelayMs: z.number().int().min(0).max(10_000),
  defaultTimeLimitS: z.number().int().min(5).max(600),
  autopilot: z.boolean().optional(),
  autoAdvance: z.object({ revealToBoardS: autoSec, boardToNextS: autoSec, finalStepS: autoSec }),
  autoPauseOnMassDisconnect: z.boolean(),
  reactions: z.boolean(),
  lateJoin: z.boolean(),
  maxPlayers: z.number().int().min(1).max(500),
  sound: z.object({ sfx: z.boolean(), music: z.boolean(), volume: weight }),
  qrMode: QrModeSchema,
  wifi: WifiSchema.optional(),
  scoring: ScoringSchema,
};

export const SettingsSchema = z.object(settingsShape);

/** Partial settings; `null` for an optional field (wifi, lobbyBgMediaId, finaleMediaId) removes it. */
export const SettingsPatchSchema = z.object({
  ...settingsShape,
  lobbyBgMediaId: IdSchema.nullable(),
  finaleMediaId: IdSchema.nullable(),
  wifi: WifiSchema.nullable(),
}).partial();

// ---------- Content file ----------

export const ContentSchema = z.object({
  rev: z.number().int().min(0),
  settings: SettingsSchema,
  questions: z.array(QuestionSchema),
  trash: z.array(z.object({ q: QuestionSchema, at: nonNeg })),
  media: z.record(IdSchema, MediaAssetSchema),
});

// ---------- Socket payloads ----------

export const HandshakeSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('player'), token: z.string().max(64).optional(), v: z.literal(1) }),
  z.object({ role: z.literal('tv'), key: z.string().min(1).max(128), v: z.literal(1) }),
  z.object({ role: z.literal('admin'), key: z.string().max(128).optional(), session: z.string().max(128).optional(), v: z.literal(1) }),
]);

export const AnswerPayloadSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('choice'), id: IdSchema }),
  z.object({ t: z.literal('number'), v: finite }),
  z.object({ t: z.literal('ordering'), ids: z.array(IdSchema).min(LIMITS.orderingItems.min).max(LIMITS.orderingItems.max) }),
]);

export const AnswerReqSchema = z.object({
  round: z.number().int().min(0),
  p: AnswerPayloadSchema,
  elapsedMs: nonNeg,
  cid: z.string().min(1).max(64),
});

/** Name is only length-capped here; shared/util normalizeName decides validity. */
export const JoinReqSchema = z.object({
  name: z.string().max(200),
  avatar: BinarySchema.optional(),
  mime: z.string().max(64).optional(),
});

export const RecoverReqSchema = z.object({ name: z.string().max(200), code: z.string().regex(/^\d{4}$/) });

export const AvatarReqSchema = z.object({ data: BinarySchema, mime: z.string().max(64) });

// ---------- Admin commands ----------

const phaseRev = z.number().int().min(0);

export const AdminCmdSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('advance'), phaseRev }),
  z.object({ type: z.literal('reveal'), phaseRev }),
  z.object({ type: z.literal('skip'), phaseRev }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('addTime'), ms: z.number().int().min(-600_000).max(600_000) }),
  z.object({ type: z.literal('jumpTo'), qid: IdSchema }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('resetScores') }),
  z.object({ type: z.literal('newGame') }),
  z.object({ type: z.literal('rescoreRound'), round: z.number().int().min(0) }),
  z.object({ type: z.literal('kick'), id: IdSchema }),
  z.object({ type: z.literal('unkick'), id: IdSchema }),
  z.object({ type: z.literal('removeAvatar'), id: IdSchema }),
  z.object({ type: z.literal('rename'), id: IdSchema, name: z.string().max(200) }),
  z.object({ type: z.literal('setVlados'), id: IdSchema.nullable() }),
  z.object({ type: z.literal('merge'), from: IdSchema, into: IdSchema }),
  z.object({ type: z.literal('tvBanner'), text: z.string().max(200).nullable() }),
  z.object({ type: z.literal('hold'), phaseRev, text: z.string().min(1).max(300) }),
  z.object({ type: z.literal('unhold') }),
  z.object({ type: z.literal('qrMode'), mode: QrModeSchema }),
  z.object({ type: z.literal('openTv') }),
  z.object({ type: z.literal('bots'), n: z.number().int().min(0).max(200) }),
]);

// ---------- Compile-time checks: schemas and shared types must stay in sync ----------

type Same<A, B extends A> = [A, B];
type Out<S extends z.ZodType> = z.output<S>;
export type SchemaChecks = [
  Same<Question, Out<typeof QuestionSchema>>,
  Same<Out<typeof QuestionSchema>, Question>,
  Same<Settings, Out<typeof SettingsSchema>>,
  Same<Out<typeof SettingsSchema>, Settings>,
  Same<SettingsPatch, Out<typeof SettingsPatchSchema>>,
  Same<Out<typeof SettingsPatchSchema>, SettingsPatch>,
  Same<Content, Out<typeof ContentSchema>>,
  Same<MediaAsset, Out<typeof MediaAssetSchema>>,
  Same<AdminCmd, Out<typeof AdminCmdSchema>>,
  Same<Out<typeof AdminCmdSchema>, AdminCmd>,
  Same<AnswerPayload, Out<typeof AnswerPayloadSchema>>,
  Same<AnswerReq, Out<typeof AnswerReqSchema>>,
  Same<Handshake, Out<typeof HandshakeSchema>>,
  Same<JoinReq, Out<typeof JoinReqSchema>>,
  Same<RecoverReq, Out<typeof RecoverReqSchema>>,
  Same<AvatarReq, Out<typeof AvatarReqSchema>>,
];
