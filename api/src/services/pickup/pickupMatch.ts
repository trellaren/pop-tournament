/**
 * A pickup lobby's match on the platform: an ordinary standalone match
 * (`matches.source = 'pickup'`) with both sides as its teams, put on a free
 * server by the scheduler like any other.
 */
import { randomInt } from 'crypto';
import { db } from '../../config/database';
import { log } from '../../utils/logger';
import { configuredPublicOrigin } from '../../utils/publicOrigin';
import { getIntegration, hasIntegration } from '../../integrations/registry';
import { matchService } from '../matchService';
import { matchmakingSides } from '../matchmaking/matchmakingService';
import type { MatchmakingMode } from '../matchmaking/rules';
import type { DbMatchRow } from '../../types/database.types';
import { seated, type Lobby, type LobbyFormat, type Side } from './rules';
import { PICKUP_GAME, insertPickupMatch, loadNames } from './pickupStore';

export interface PickupMap {
  id: string;
  name: string;
}

/**
 * The platform mode whose maps and rules a format plays by: wingman is the
 * platform's 2v2 (wingman maps, MR8, no knife round) also with one a side;
 * classic is its 5v5 whatever the team size.
 */
function modeOf(format: LobbyFormat): MatchmakingMode {
  return format === 'wingman' ? '2v2' : '5v5';
}

const MAX_ROUNDS: Record<MatchmakingMode, number> = { '5v5': 24, '2v2': 16, '1v1': 12 };

export interface PickupPool {
  id: number;
  name: string;
  maps: number;
}

/** The platform's map pools a host can choose from. */
export async function mapPools(): Promise<PickupPool[]> {
  if (!hasIntegration(PICKUP_GAME)) return [];
  return (await getIntegration(PICKUP_GAME).matchmakingPools?.()) ?? [];
}

/** The maps a lobby of this format picks from. */
export async function mapPoolFor(
  format: LobbyFormat,
  poolId: number | null = null
): Promise<PickupMap[]> {
  if (!hasIntegration(PICKUP_GAME)) return [];
  const pool =
    (await getIntegration(PICKUP_GAME).matchmakingMapPool?.(modeOf(format), poolId)) ?? [];
  return pool.map((m) => ({ id: m.id, name: m.name }));
}

/**
 * Create the lobby's match and ask for a server. The lobby is already
 * `in_match` with `matchSlug` set. Throws when the match cannot be made.
 */
export async function createPickupMatch(
  lobby: Lobby,
  slug: string,
  now: number,
  /** The two teams veto the map on the match page before it gets a server. */
  wantsVeto: boolean
): Promise<void> {
  const pool = await mapPoolFor(lobby.settings.format, lobby.settings.poolId);
  if (pool.length === 0) throw new Error('No maps for this format');
  const veto = wantsVeto && pool.length > 1;
  const picked = pool.find((m) => m.id === lobby.pickedMap);
  const map = veto ? null : (picked?.id ?? pool[randomInt(pool.length)].id);

  const ids = (side: Side) =>
    seated(lobby, side)
      .sort((x, y) => x.joinedAt - y.joinedAt)
      .map((p) => p.playerId);
  const names = await loadNames([...ids('a'), ...ids('b')]);
  const team = (side: Side, label: string) => {
    const roster = ids(side);
    const captain = roster.includes(lobby.hostId) ? lobby.hostId : roster[0];
    return {
      name: label,
      captainSteamId: captain,
      players: Object.fromEntries(roster.map((id) => [id, names.get(id)?.name ?? id])),
    };
  };
  const mode = modeOf(lobby.settings.format);

  await matchService.createMatch(
    {
      slug,
      config: {
        matchid: 0,
        players_per_team: lobby.settings.teamSize,
        team1: team('a', 'Team A'),
        team2: team('b', 'Team B'),
        num_maps: 1,
        maplist: map === null ? pool.map((m) => m.id) : [map],
        // The veto runs before the match gets a server (status 'pending' until it is done).
        ...(veto ? { vetoDisabled: false } : {}),
        wingman: mode === '2v2',
        maxRounds: MAX_ROUNDS[mode],
        ...matchmakingSides(mode),
      },
    },
    configuredPublicOrigin() ?? '',
    null
  );
  await db.runAsync("UPDATE matches SET source = 'pickup' WHERE slug = ?", [slug]);
  await insertPickupMatch({
    lobbyId: lobby.id,
    slug,
    matchNo: lobby.matchNo,
    map,
    teamA: ids('a'),
    teamB: ids('b'),
    now,
  });
  log.info(`[PICKUP] lobby ${lobby.id}: match ${slug} ${map ? `on ${map}` : 'vetoes its map'}`);

  // Allocation is the scheduler's; it keeps trying while no server is free.
  const { scheduler } = await import('../../core/scheduler');
  setImmediate(() => {
    void scheduler.tryImmediateAllocation();
  });
}

/** Stop a lobby's match: tell its server when it has one, mark it cancelled, free the server. */
export async function cancelPickupMatch(slug: string): Promise<void> {
  const match = await db.queryOneAsync<DbMatchRow>('SELECT * FROM matches WHERE slug = ?', [slug]);
  if (!match) return;
  const status: string = match.status;
  if (status === 'completed' || status === 'cancelled') return;
  if (match.server_id) {
    try {
      const { scheduler } = await import('../../core/scheduler');
      await scheduler.cancelMatch(match, 'force-cancel');
    } catch (error) {
      log.warn(`[PICKUP] could not tell the server that ${slug} is cancelled`, error as Error);
    }
  }
  const { settleEndedMatch } = await import('../matchTerminationService');
  await settleEndedMatch(match, 'pickup-cancel');
}

/**
 * Put a substitute into the lobby's match in the leaver's place, through the
 * game's own roster change. False when the match server did not take it.
 */
export async function substituteInMatch(
  slug: string,
  outId: string,
  inId: string,
  side: Side
): Promise<boolean> {
  if (!hasIntegration(PICKUP_GAME)) return false;
  const names = await loadNames([inId]);
  const substitute = getIntegration(PICKUP_GAME).substitutePlayer;
  if (!substitute) return false;
  return substitute(slug, {
    outId,
    inId,
    inName: names.get(inId)?.name ?? inId,
    team: side === 'a' ? 'team1' : 'team2',
  });
}
