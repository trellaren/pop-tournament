/**
 * Spectators and the servers outside matches (docs/design/pickup-lobby.md):
 * who may watch the lobby's running match from inside its server, and the
 * practice and retakes servers anyone joins on their own.
 */
import { getIntegration, hasIntegration } from '../../integrations/registry';
import { PICKUP_GAME, loadNames } from './pickupStore';
import { mayManage, type Actor, type Lobby } from './rules';

/**
 * Whether the actor may watch the running match in its server: someone in the
 * lobby who is not playing, or its host or an admin. Never someone who was
 * substituted out of this match. Pure.
 */
export function maySpectate(lobby: Lobby, actor: Actor): boolean {
  if (lobby.state !== 'in_match' || !lobby.matchSlug) return false;
  if (lobby.leavers.includes(actor.playerId)) return false;
  const mine = lobby.players.find((p) => p.playerId === actor.playerId);
  if (mine?.side) return false;
  return Boolean(mine) || mayManage(lobby, actor);
}

export interface SpectatorConnect {
  host: string;
  ip: string | null;
  port: number;
  password: string | null;
}

/**
 * Put the actor on the match's spectator list and say how to join. `listed`
 * false: the match server did not take it. `connect` null: no server yet.
 */
export async function spectateMatch(
  slug: string,
  playerId: string
): Promise<{ listed: boolean; connect: SpectatorConnect | null }> {
  if (!hasIntegration(PICKUP_GAME)) return { listed: false, connect: null };
  const game = getIntegration(PICKUP_GAME);
  if (!game.matchSpectator) return { listed: false, connect: null };
  const names = await loadNames([playerId]);
  const name = names.get(playerId)?.name ?? playerId;
  const listed = await game.matchSpectator(slug, { id: playerId, name, watching: true });
  if (!listed) return { listed, connect: null };
  return { listed, connect: (await game.matchSpectatorConnect?.(slug)) ?? null };
}

/** Take someone off the match's spectator list: they left the lobby or were kicked. */
export async function stopSpectating(slug: string, playerId: string): Promise<void> {
  if (!hasIntegration(PICKUP_GAME)) return;
  await getIntegration(PICKUP_GAME).matchSpectator?.(slug, {
    id: playerId,
    name: playerId,
    watching: false,
  });
}

export interface ModeServer {
  name: string;
  address: string;
  connectIp: string | null;
  port: number;
}

/** The practice and retakes servers that are online now. */
export async function modeServers(): Promise<{ practice: ModeServer[]; retakes: ModeServer[] }> {
  if (!hasIntegration(PICKUP_GAME)) return { practice: [], retakes: [] };
  const list = getIntegration(PICKUP_GAME).modeServers;
  if (!list) return { practice: [], retakes: [] };
  const [practice, retakes] = await Promise.all([list('practice'), list('retakes')]);
  return { practice, retakes };
}
