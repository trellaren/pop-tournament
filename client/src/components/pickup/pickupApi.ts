/** The pickup lobby's API (api routes/pickup.ts) and the hook the pages read it with. */
import React from 'react';
import { api } from '../../utils/api';
import { useTopic } from '../../hooks/useTopic';
import type { Untrusted } from '../../utils/untrusted';
import { usePickupHost } from './pickupHost';

export type Side = 'a' | 'b';

export type PickupCaptainMethod = 'random' | 'rating' | 'host';

export type PickupMapMethod = 'pick' | 'veto' | 'vote';

export type PickupRollOut = 'most_played' | 'losers';

export type PickupCommandType =
  | 'join'
  | 'leave'
  | 'move'
  | 'kick'
  | 'make_host'
  | 'scramble'
  | 'balance'
  | 'lock_teams'
  | 'set_settings'
  | 'roll_out'
  | 'start_draft'
  | 'pick'
  | 'pick_map'
  | 'vote_map'
  | 'start'
  | 'ready'
  | 'cancel'
  | 'close';

export interface PickupPlayer {
  playerId: string;
  name: string;
  avatarUrl: string | null;
  rating: number | null;
  isHost: boolean;
  ready: boolean;
  gamesInRow: number;
}

export interface PickupMatch {
  slug: string;
  matchNo: number;
  status: string;
  map: string | null;
  vetoing: boolean;
}

export interface PickupLogLine {
  id: number;
  type: string;
  at: number;
  actorId: string;
  actorName: string;
  playerName: string | null;
  data: Record<string, string | number | boolean | null>;
}

export type PickupFormat = 'classic' | 'wingman';

export interface PickupLobby {
  id: string;
  state: 'gathering' | 'drafting' | 'ready_check' | 'map_vote' | 'in_match' | 'closed';
  version: number;
  hostId: string;
  teamsLocked: boolean;
  settings: {
    format: PickupFormat;
    teamSize: number;
    rollOut: PickupRollOut;
    mapMethod: PickupMapMethod;
    poolId: number | null;
  };
  pools: Array<{ id: number; name: string; maps: number }>;
  vote: {
    counts: Record<string, number>;
    mine: string | null;
    voted: number;
    voters: number;
  } | null;
  pickedMap: string | null;
  maps: Array<{ id: string; name: string }>;
  deadline: number | null;
  match: PickupMatch | null;
  draft: { captains: Record<Side, string>; turn: Side | null; pool: PickupPlayer[] } | null;
  teams: Record<Side, PickupPlayer[]>;
  waiting: PickupPlayer[];
  log: PickupLogLine[];
  me: Side | 'waiting' | null;
  can: Record<PickupCommandType, boolean>;
}

export interface PickupSummary {
  id: string;
  hostName: string;
  format: PickupFormat;
  teamSize: number;
  teamsLocked: boolean;
  seated: number;
  waiting: number;
}

export type PickupCommand =
  | { type: 'join'; side: Side | null }
  | { type: 'leave' }
  | { type: 'move'; playerId: string; side: Side | null }
  | { type: 'kick'; playerId: string }
  | { type: 'make_host'; playerId: string }
  | { type: 'scramble'; version: number }
  | { type: 'balance'; version: number }
  | { type: 'lock_teams'; locked: boolean }
  | {
      type: 'set_settings';
      format?: PickupFormat;
      teamSize?: number;
      rollOut?: PickupRollOut;
      mapMethod?: PickupMapMethod;
      poolId?: number | null;
    }
  | { type: 'vote_map'; map: string }
  | { type: 'roll_out'; playerId: string; version: number }
  | {
      type: 'start_draft';
      method: PickupCaptainMethod;
      captainA?: string;
      captainB?: string;
      version: number;
    }
  | { type: 'pick'; playerId: string }
  | { type: 'pick_map'; map: string | null }
  | { type: 'start'; version: number }
  | { type: 'ready' }
  | { type: 'cancel'; version: number }
  | { type: 'close'; version: number };

export const PICKUP_TOPIC = 'pickup';

export function listPickupLobbies(): Promise<{ lobbies: PickupSummary[]; mine: string | null }> {
  return api.get('/api/pickup');
}

export async function openPickupLobby(): Promise<string> {
  const answer = await api.post<{ id: string }>('/api/pickup', {});
  return answer.id;
}

export interface PickupActivitySignIn {
  token: string;
  expiresAt: number;
  accessToken: string;
  playerId: string;
}

export async function pickupActivityClientId(): Promise<string | null> {
  const answer = await api.get<{ clientId: string | null }>('/api/pickup/activity/config');
  return answer.clientId;
}

export function signInToPickupActivity(code: string): Promise<PickupActivitySignIn> {
  return api.post<PickupActivitySignIn>('/api/pickup/activity/token', { code });
}

export async function sendPickupCommand(lobbyId: string, command: PickupCommand): Promise<void> {
  await api.post(`/api/pickup/${encodeURIComponent(lobbyId)}/commands`, command);
}

/** The refusal's code from a failed call (`side_full`, `stale`…), or null. */
export function pickupRefusalCode(error: Untrusted): string | null {
  if (!(error instanceof Error)) return null;
  try {
    const parsed = JSON.parse(error.message) as { code?: Untrusted };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

export interface PickupLobbyState {
  lobby: PickupLobby | null;
  /** True once the first read has answered. */
  ready: boolean;
  /** True when the lobby does not exist. */
  missing: boolean;
  reload: () => void;
}

/** One lobby, re-read whenever the server says a pickup lobby changed. */
export function usePickupLobby(lobbyId: string | undefined): PickupLobbyState {
  const [lobby, setLobby] = React.useState<PickupLobby | null>(null);
  const [ready, setReady] = React.useState(false);
  const [missing, setMissing] = React.useState(false);

  const reload = React.useCallback(() => {
    if (!lobbyId) return;
    api
      .get<{ lobby: PickupLobby }>(`/api/pickup/${encodeURIComponent(lobbyId)}`)
      .then((answer) => {
        setLobby(answer.lobby);
        setMissing(false);
      })
      .catch((error: Untrusted) => {
        if (pickupRefusalCode(error) === 'not_found') setMissing(true);
      })
      .finally(() => setReady(true));
  }, [lobbyId]);

  const { pollMs } = usePickupHost();
  React.useEffect(() => {
    if (pollMs <= 0) return undefined;
    const timer = window.setInterval(reload, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, reload]);

  React.useEffect(reload, [reload]);
  // The match's own progress (server found, live) arrives as match updates.
  useTopic(PICKUP_TOPIC, reload, { enabled: Boolean(lobbyId), events: ['match:update'] });

  return { lobby, ready, missing, reload };
}
