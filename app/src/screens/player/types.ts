// What the phone screens get besides the PlayerView: the actions of a PlayerSession (live) or of
// a fixture (preview). Screens never touch Firestore; everything goes through these.

import type { AnswerPayload } from '@shared/types';
import type { AnswerResult, JoinResult, ReactResult } from '../../host/player';
import type { SelfieResult } from './vx';

export type Haptic = 'tap' | 'commit' | 'good' | 'bad';

export interface PlayerActions {
  /** checkedName(): normalized name, or null when the rules would refuse it. */
  checkName(raw: string): string | null;
  /** Joins with the selfie (or the generated chrome avatar); null = no picture at all. */
  join(name: string, selfie: SelfieResult | null): Promise<JoinResult>;
  answer(round: number, p: AnswerPayload): Promise<AnswerResult>;
  react(e: number): Promise<ReactResult>;
  /** Server clock, ms. */
  now(): number;
  /** Object URL of an image from the media store (cached on the device). */
  media(id: string): Promise<string>;
  haptic(kind: Haptic): void;
}
