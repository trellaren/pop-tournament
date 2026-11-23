/**
 * Tells whoever listens that a pickup lobby changed, after the change is
 * written: the Discord add-on keeps its panel and voice channels from this.
 */
import { log } from '../../utils/logger';
import type { Effect, Lobby, LobbyEvent } from './rules';

export interface PickupChange {
  /** The lobby after the change. */
  lobby: Lobby;
  events: readonly LobbyEvent[];
  effects: readonly Effect[];
}

type Listener = (change: PickupChange) => void | Promise<void>;

const listeners = new Set<Listener>();

/** Listen for lobby changes; the returned function stops listening. */
export function onPickupChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A listener that fails is logged and never stops the lobby. */
export function emitPickupChange(change: PickupChange): void {
  for (const listener of listeners) {
    void Promise.resolve()
      .then(() => listener(change))
      .catch((error: unknown) => {
        log.warn('[PICKUP] a change listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}
