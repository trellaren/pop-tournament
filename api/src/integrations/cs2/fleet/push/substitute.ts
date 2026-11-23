/**
 * Roster changes the pickup lobby asks of a match (GameIntegration
 * `substitutePlayer`, `matchSpectator`): one player in for another on the
 * same team, and a spectator on or off the list. A match with no server yet
 * gets the change in its stored config; one on a Ready Up server gets a
 * `match.update`, which the server applies whole or not at all.
 */
import { db } from '../../../../config/database';
import {
  applyOpsToMatchConfig,
  getMatchRoster,
  sendMatchUpdate,
  type RosterOp,
  type RosterView,
} from './matchUpdate';

export interface Substitution {
  outId: string;
  inId: string;
  inName: string;
  team: 'team1' | 'team2';
}

/**
 * Apply `ops` to the match. `shows` says whether a live roster already has
 * the change, so asking again after a late answer is harmless. False when
 * the server did not take it.
 */
async function changeRoster(
  slug: string,
  ops: RosterOp[],
  shows: (roster: RosterView) => boolean
): Promise<boolean> {
  const match = await db.queryOneAsync<{ config: string | null; server_id: string | null }>(
    'SELECT config, server_id FROM matches WHERE slug = ?',
    [slug]
  );
  if (!match) return false;
  const live = await getMatchRoster(slug);
  if (!live.fleet) {
    // On a server the platform cannot update, the roster there would stay as it was.
    if (match.server_id || !match.config) return false;
    const config = JSON.parse(match.config) as Parameters<typeof applyOpsToMatchConfig>[0];
    await db.runAsync('UPDATE matches SET config = ? WHERE slug = ?', [
      JSON.stringify(applyOpsToMatchConfig(config, ops)),
      slug,
    ]);
    return true;
  }
  if (live.roster && shows(live.roster)) return true;
  const outcome = await sendMatchUpdate(slug, ops);
  return outcome.kind === 'answered' && outcome.command.status === 'ok';
}

const idsOf = (players: ReadonlyArray<{ steamid64: string }>): string[] =>
  players.map((p) => p.steamid64);

export function substitutePlayer(slug: string, change: Substitution): Promise<boolean> {
  const { outId, inId, inName, team } = change;
  return changeRoster(
    slug,
    [
      { op: 'remove_player', steamid64: outId },
      { op: 'add_player', team, steamid64: inId, name: inName },
    ],
    (roster) => {
      const playing = idsOf(roster[team].players);
      return playing.includes(inId) && !playing.includes(outId);
    }
  );
}

/** Put someone on the match's spectator list, or take them off. Never touches a team's player. */
export async function matchSpectator(
  slug: string,
  change: { id: string; name: string; watching: boolean }
): Promise<boolean> {
  const { id, name, watching } = change;
  const onTeam = (roster: RosterView) =>
    [...idsOf(roster.team1.players), ...idsOf(roster.team2.players)].includes(id);
  const live = await getMatchRoster(slug);
  if (live.roster && onTeam(live.roster)) return false;
  return changeRoster(
    slug,
    [
      watching
        ? { op: 'add_player', team: 'spectator', steamid64: id, name }
        : { op: 'remove_player', steamid64: id },
    ],
    (roster) => idsOf(roster.spectators).includes(id) === watching
  );
}
