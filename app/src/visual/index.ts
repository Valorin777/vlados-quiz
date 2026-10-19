// Liquid chrome design system («Жидкий хром»). Screens import from here:
//
//   import { LiquidStage, ChromeButton, OptionTile, beats, audio } from '../../visual';
//
// Wiring (once per screen root):
//   <div className="vx"> <LiquidStage profile="phone"> …screen… </LiquidStage> <ToastHost/> </div>
//   TV: <LiquidStage profile="tv" designWidth={1280}> over a 1280×720 design surface.
// Keep wrappers inside the stage transparent (the canvas paints the ground) and never make
// floating overlays liquid (use <LiquidOff>; Sheet/Toast already do).
//
// The WebGL engine is code-split and loaded after first paint; until then (and on weak devices,
// tier 0) every chrome element renders CSS chrome. See #/lab for every primitive and beat.

import './styles.css';
import './fontwarm';

export * from './appearance';
export { audio } from './audio';
export * as beats from './beats';
export { reducedMotion, forceReducedMotion, onReducedMotion, ease, dur, rng } from './motion';
export {
  LiquidStage,
  LiquidOff,
  useLiquid,
  useChromeBlob,
  useFollow,
  savedTier,
  saveTier,
  autoTier,
  type LiquidStageProps,
  type LiquidCtx,
  type ChromeBlobOptions,
  type LiquidEngine,
  type Blob,
  type EngineStats,
  type Profile,
  type Shape,
  type Tier,
  type SceneProps,
  type AnchorOptions,
} from './liquid';

export { ChromeText, type ChromeTextProps } from './ui/ChromeText';
export { ChromeButton, type ChromeButtonProps } from './ui/ChromeButton';
export { ChromeField, type ChromeFieldProps } from './ui/ChromeField';
export { ChromeBlock, type ChromeBlockProps } from './ui/ChromeBlock';
export { OptionTile, type OptionTileProps, type OptionState } from './ui/OptionTile';
export { NumberInput, type NumberInputProps } from './ui/NumberInput';
export { OrderList, type OrderListProps, type OrderItem } from './ui/OrderList';
export { TimerBar, TimerTube, type TimerProps, type TimerTubeProps } from './ui/Timers';
export { Odometer, type OdometerProps } from './ui/Odometer';
export { Countdown, type CountdownProps } from './ui/Countdown';
export { Avatar, AvatarStack, type AvatarProps, type AvatarSize } from './ui/Avatar';
export { AvatarOrbit, type AvatarOrbitProps, type OrbitPlayer } from './ui/AvatarOrbit';
export { QRCode, type QRCodeProps } from './ui/QRCode';
export { ReactionBar, ReactionLayer, REACTION_EMOJI, type ReactionItem, type ReactionBarProps, type ReactionLayerProps } from './ui/Reactions';
export { ModeToggle, type ModeToggleProps } from './ui/ModeToggle';
export { ToastHost, toast, dismissToast, type ToastTone } from './ui/Toast';
export { Sheet, Modal, type SheetProps } from './ui/Sheet';
export { Badge, type BadgeProps } from './ui/Badge';
export { FitImage, useDecoded, decodeImage, fitOrientation, type FitImageProps } from './ui/FitImage';
export { Emerge, type EmergeProps } from './ui/Emerge';
export { Lightbox, type LightboxProps } from './ui/Lightbox';
export { SelfieViewfinder, generateChromeAvatar, type SelfieResult, type SelfieViewfinderProps } from './ui/SelfieViewfinder';
export { cx, plural, fmtInt, fmtClock, initialOf, graphemes } from './ui/util';
