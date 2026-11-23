/**
 * One player into a match in another's place, on the same team: the pickup
 * lobby's mid-match substitution (GameIntegration.substitutePlayer). A match
 * with no server yet gets the new roster in its stored config; one on a Ready
 * Up server gets a `match.update`, which the server applies whole or not at
 * all.
 */
import { db } from '../../../../config/database';
import {
  applyOpsToMatchConfig,
  getMatchRoster,
  sendMatchUpdate,
  type RosterOp,
} from './matchUpdate';

export interface Substitution {
  outId: string;
  inId: string;
  inName: string;
  team: 'team1' | 'team2';
}

export async function substitutePlayer(slug: string, change: Substitution): Promise<boolean> {
  const { outId, inId, inName, team } = change;
  const match = await db.queryOneAsync<{ config: string | null; server_id: string | null }>(
    'SELECT config, server_id FROM matches WHERE slug = ?',
    [slug]
  );
  if (!match) return false;
  const ops: RosterOp[] = [
    { op: 'remove_player', steamid64: outId },
    { op: 'add_player', team, steamid64: inId, name: inName },
  ];
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
  // Asked again after an answer that came late: the roster already shows it.
  const playing = live.roster?.[team].players.map((p) => p.steamid64) ?? [];
  if (playing.includes(inId) && !playing.includes(outId)) return true;
  const outcome = await sendMatchUpdate(slug, ops);
  return outcome.kind === 'answered' && outcome.command.status === 'ok';
}
