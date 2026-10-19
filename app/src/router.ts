// Hash routes (`#/…`), so the same build works on Pages under /vlados/, over a tunnel, on
// localhost and on the LAN without any server-side rewrites.
//   #/        player (eager: it's what 90 phones load)
//   #/tv      big screen            #/admin/*  organizer
//   #/lab     design system + every screen on fixtures
//   #/og      the 1200×630 link-preview card (tools/og-image.mjs screenshots it; not linked anywhere)
// Everything but the player is code-split.

import { lazy, type ComponentType } from 'react';
import { navigate as hashNavigate, useHashLocation } from 'wouter/use-hash-location';
import { PlayerApp } from './screens/player/PlayerApp';

export interface RouteDef {
  path: string;
  /** Nested routes live under this prefix (`#/admin/questions`). */
  nest?: boolean;
  component: ComponentType;
}

const TvApp = lazy(() => import('./screens/tv/TvApp').then((m) => ({ default: m.TvApp })));
const AdminApp = lazy(() => import('./screens/admin/AdminApp').then((m) => ({ default: m.AdminApp })));
const LabApp = lazy(() => import('./screens/lab/LabApp').then((m) => ({ default: m.LabApp })));
const OgCard = lazy(() => import('./screens/og/OgCard').then((m) => ({ default: m.OgCard })));

export const ROUTES: readonly RouteDef[] = [
  { path: '/tv', component: TvApp },
  { path: '/admin', nest: true, component: AdminApp },
  { path: '/lab', component: LabApp },
  { path: '/og', component: OgCard },
];

/** Anything unmatched (including `#/` and no hash at all) is the player. */
export const FALLBACK: ComponentType = PlayerApp;

export const locationHook = useHashLocation;
export const navigate = (to: string, replace = false): void => hashNavigate(to, { replace });
