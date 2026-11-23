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
  | 'invite'
  | 'revoke_invite'
  | 'substitute'
  | 'substitution_action'
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
  /** A second player the line is about: who went out in a substitution. */
  otherName: string | null;
  data: Record<string, string | number | boolean | null>;
}

export type PickupFormat = 'classic' | 'wingman';

/** Who can join: everyone, or only the invited. */
export type PickupVisibility = 'open' | 'invite';

export interface PickupLobby {
  id: string;
  state: 'gathering' | 'drafting' | 'ready_check' | 'map_vote' | 'in_match' | 'closed';
  version: number;
  hostId: string;
  teamsLocked: boolean;
  settings: {
    format: PickupFormat;
    visibility: PickupVisibility;
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
  /** Whether the viewer may ban someone from pickup: a moderator or an admin. */
  mayBan: boolean;
  /** Whether the viewer may watch the running match from inside its server. */
  maySpectate: boolean;
  /** Who may come in for a seated player during the match, longest wait first. */
  substitutes: string[];
  /** Who left the running match by substitution. */
  leavers: Array<{ playerId: string; name: string }>;
  /** A substitution the match server did not take. */
  subFailed: { outId: string; outName: string; inId: string; inName: string } | null;
  /** The invite list; empty unless the viewer runs the lobby. */
  invited: Array<{ playerId: string; name: string; inLobby: boolean }>;
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
  | { type: 'join'; side: Side | null; invite?: string }
  | { type: 'substitute'; outId: string; inId: string; version: number }
  | { type: 'substitution_action'; action: 'retry' | 'undo'; version: number }
  | { type: 'invite'; playerId: string }
  | { type: 'revoke_invite'; playerId: string }
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
      visibility?: PickupVisibility;
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

export function listPickupLobbies(): Promise<{
  lobbies: PickupSummary[];
  mine: string | null;
  mayModerate?: boolean;
}> {
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

/** What the Activity starts from: Discord's application id and the site's public address. */
export function pickupActivityConfig(): Promise<{
  clientId: string | null;
  siteUrl: string | null;
}> {
  return api.get('/api/pickup/activity/config');
}

export function signInToPickupActivity(code: string): Promise<PickupActivitySignIn> {
  return api.post<PickupActivitySignIn>('/api/pickup/activity/token', { code });
}

export async function sendPickupCommand(lobbyId: string, command: PickupCommand): Promise<void> {
  await api.post(`/api/pickup/${encodeURIComponent(lobbyId)}/commands`, command);
}

/** Ban a player from pickup lobbies: `length` in seconds, or null until lifted. */
export async function banFromPickup(
  playerId: string,
  length: number | null,
  reason: string
): Promise<void> {
  await api.put(`/api/pickup/admin/bans/${encodeURIComponent(playerId)}`, { length, reason });
}

/** When the ban named in a refused call ends (epoch seconds), null until lifted or not a ban. */
export function pickupBanUntil(error: Untrusted): number | null {
  if (!(error instanceof Error)) return null;
  try {
    const parsed = JSON.parse(error.message) as { until?: Untrusted };
    return typeof parsed.until === 'number' ? parsed.until : null;
  } catch {
    return null;
  }
}

/** How to join a server: its address, an IP for the steam:// link, and its password if any. */
export interface PickupConnect {
  host: string;
  ip: string | null;
  port: number;
  password: string | null;
}

/** Go on the running match's spectator list; null while the match has no server yet. */
export async function spectatePickupMatch(lobbyId: string): Promise<PickupConnect | null> {
  const answer = await api.post<{ connect: PickupConnect | null }>(
    `/api/pickup/${encodeURIComponent(lobbyId)}/spectate`,
    {}
  );
  return answer.connect;
}

export interface PickupModeServer {
  name: string;
  address: string;
  connectIp: string | null;
  port: number;
}

/** The practice and retakes servers that are online now. */
export function listPickupServers(): Promise<{
  practice: PickupModeServer[];
  retakes: PickupModeServer[];
}> {
  return api.get('/api/pickup/servers');
}

/** A new invite link to the lobby: the page's path with its token. Host and admins only. */
export async function makePickupInviteLink(lobbyId: string): Promise<string> {
  const answer = await api.post<{ path: string }>(
    `/api/pickup/${encodeURIComponent(lobbyId)}/invite-link`,
    {}
  );
  return answer.path;
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
