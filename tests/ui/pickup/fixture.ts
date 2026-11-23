import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { Side } from '../../../api/src/services/pickup/rules';

/**
 * What the pickup lobby's test groups share. Only one lobby can be open at a
 * time, so every group runs inside tests/ui/pickup-lobby.spec.ts's one serial
 * run and is handed this.
 */
export interface LobbyBody {
  lobby: {
    id: string;
    state: string;
    version: number;
    hostId: string;
    teamsLocked: boolean;
    settings: {
      format: string;
      visibility: string;
      teamSize: number;
      rollOut: string;
      poolId: number | null;
    };
    teams: Record<
      Side,
      Array<{ playerId: string; name: string; isHost: boolean; ready: boolean; gamesInRow: number }>
    >;
    waiting: Array<{ playerId: string }>;
    invited: Array<{ playerId: string; name: string; inLobby: boolean }>;
    substitutes: string[];
    leavers: Array<{ playerId: string; name: string }>;
    subFailed: { outId: string; inId: string } | null;
    log: Array<{ type: string; data: Record<string, string | number | boolean | null> }>;
    deadline: number | null;
    pickedMap: string | null;
    maps: Array<{ id: string }>;
    match: {
      slug: string;
      matchNo: number;
      status: string;
      map: string | null;
      vetoing: boolean;
    } | null;
    vote: { counts: Record<string, number>; voted: number; voters: number } | null;
    draft: { turn: Side | null; pool: Array<{ playerId: string }> } | null;
    me: string | null;
    can: Record<string, boolean>;
  };
}

export interface PickupFixture {
  steamIds: string[];
  /** One signed-in player per steam id. */
  contexts: APIRequestContext[];
  view: (who: number) => Promise<LobbyBody['lobby']>;
  send: (who: number, data: object) => Promise<APIResponse>;
  /** Open a lobby as this player; the fixture's view and send then act on it. */
  open: (who: number) => Promise<void>;
}

export const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3069';
export const TAGS = { tag: ['@ui', '@pickup'] };
