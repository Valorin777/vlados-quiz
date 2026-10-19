// Public surface of the liquid renderer. Only types come from ./engine here, so importing this
// module never pulls the WebGL engine into the main bundle (LiquidStage loads it lazily).

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
} from './LiquidStage';
export type { LiquidEngine, DropletOptions, LocalRect } from './engine';
export type { AnchorOptions, Blob, EngineOptions, EngineStats, Profile, SceneProps, Shape, Tier } from './types';
