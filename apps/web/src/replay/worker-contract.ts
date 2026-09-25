import type { PublicMatchRow } from '@fantasy/domain/spatial';
import type { ReplayLoadErrorKind } from './artifacts.ts';
import type { OpenedReplay } from './open-replay.ts';
import type { ReplayPlayer } from './replay-player.ts';

export type ReplayLocation =
  | { mode: 'api'; id: string; base: string }
  | { mode: 'public'; root: string; row: PublicMatchRow };
export type ReplayInfo = Pick<OpenedReplay, 'manifest' | 'context'>;
export type ReplayControls = Pick<ReplayPlayer, 'frame' | 'events'>;
export type WorkerRequest =
  | { id: number; action: 'open'; location: ReplayLocation }
  | { id: number; action: 'frame' | 'events'; index: number }
  | { id: number; action: 'cancel' };
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; kind: ReplayLoadErrorKind; message: string };
