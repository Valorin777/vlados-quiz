// The slice of the liquid chrome design system the phone uses, imported file by file instead of
// through visual/index.ts: the barrel also re-exports OrderList (dnd-kit) and QRCode (qrcode),
// and a static import of it drags those into the phone's first-load bundle. OrderList is loaded
// lazily by Round.tsx when an ordering question comes up.

import '../../visual/styles.css';
import '../../visual/fontwarm';

export { LiquidStage, LiquidOff, useLiquid, type Blob, type LiquidEngine, type Tier } from '../../visual/liquid';
export * as beats from '../../visual/beats';
export { audio } from '../../visual/audio';
export { ease } from '../../visual/motion';
export {
  APPEARANCE_KEY,
  APPEARANCE_OPTIONS,
  setAppearance,
  setAppearanceOverride,
  useAppearance,
  type AppearancePref,
} from '../../visual/appearance';
export { ChromeText } from '../../visual/ui/ChromeText';
export { ChromeButton } from '../../visual/ui/ChromeButton';
export { ChromeField } from '../../visual/ui/ChromeField';
export { ChromeBlock } from '../../visual/ui/ChromeBlock';
export { OptionTile } from '../../visual/ui/OptionTile';
export { NumberInput } from '../../visual/ui/NumberInput';
export { TimerBar } from '../../visual/ui/Timers';
export { Odometer } from '../../visual/ui/Odometer';
export { Countdown } from '../../visual/ui/Countdown';
export { Avatar } from '../../visual/ui/Avatar';
export { ReactionBar } from '../../visual/ui/Reactions';
export { ModeToggle } from '../../visual/ui/ModeToggle';
export { ToastHost, toast } from '../../visual/ui/Toast';
export { Badge } from '../../visual/ui/Badge';
export { FitImage, useDecoded } from '../../visual/ui/FitImage';
export { Emerge } from '../../visual/ui/Emerge';
export { Lightbox } from '../../visual/ui/Lightbox';
export { SelfieViewfinder, generateChromeAvatar, type SelfieResult } from '../../visual/ui/SelfieViewfinder';
export { cx, plural, fmtClock } from '../../visual/ui/util';
