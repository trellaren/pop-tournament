/** A pickup lobby's invite list in the database: one row per person, oldest first. */
import type { PoolClient } from 'pg';
import { db } from '../../config/database';
import type { Lobby } from './rules';

export async function invitesOf(lobbyId: string): Promise<string[]> {
  const rows = await db.queryAsync<{ player_id: string }>(
    'SELECT player_id FROM pickup_lobby_invites WHERE lobby_id = ? ORDER BY position',
    [lobbyId]
  );
  return rows.map((row) => row.player_id);
}

/** Write the list as decided, inside the lobby's own transaction. */
export async function writeInvites(client: PoolClient, lobby: Lobby): Promise<void> {
  await client.query('DELETE FROM pickup_lobby_invites WHERE lobby_id = $1', [lobby.id]);
  for (const [position, playerId] of lobby.invited.entries()) {
    await client.query(
      'INSERT INTO pickup_lobby_invites (lobby_id, player_id, position) VALUES ($1, $2, $3)',
      [lobby.id, playerId, position]
    );
  }
}

/** Whether these are players of the site: nobody else can be invited. */
export async function isKnownPlayer(playerId: string): Promise<boolean> {
  const row = await db.queryOneAsync<{ id: string }>('SELECT id FROM players WHERE id = ?', [
    playerId,
  ]);
  return Boolean(row);
}
