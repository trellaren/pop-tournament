/**
 * Reads and writes of the pickup tables. Every write of a lobby is one
 * transaction; the service serialises them (pickupService's lock).
 */
import type { PoolClient } from 'pg';
import { db } from '../../config/database';
import type {
  EventData,
  Lobby,
  LobbyEvent,
  LobbyPlayer,
  LobbySettings,
  LobbyState,
  Side,
} from './rules';
import {
  DEFAULT_TEAM_SIZE,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  ROLL_OUT_RULES,
  type RollOutRule,
} from './rules';
import type { Untrusted } from '../../utils/untrusted';
import { parseDraft } from './draftStore';

export const PICKUP_GAME = 'cs2';
export const PICKUP_MODE = '5v5';
/** How many log lines a lobby view carries, newest last. */
export const LOG_LIMIT = 100;

interface LobbyRow {
  id: string;
  state: string;
  host_id: string;
  version: number;
  settings: string;
  teams_locked: boolean;
  picked_map: string | null;
  deadline_at: number | null;
  match_count: number;
  match_slug: string | null;
  draft: string | null;
  created_at: number;
}

interface PlayerRow {
  player_id: string;
  side: string | null;
  joined_at: number;
  waiting_since: number | null;
  ready: boolean;
  games_in_row: number;
}

export interface StoredEvent {
  id: number;
  type: string;
  actorId: string;
  data: EventData;
  at: number;
}

export interface PlayerName {
  id: string;
  name: string;
  avatarUrl: string | null;
}

function parseSettings(raw: string): LobbySettings {
  let teamSize = DEFAULT_TEAM_SIZE;
  let rollOut: RollOutRule = 'most_played';
  try {
    const parsed: Untrusted = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'teamSize' in parsed) {
      const size = Number(parsed.teamSize);
      if (Number.isInteger(size) && size >= MIN_TEAM_SIZE && size <= MAX_TEAM_SIZE) teamSize = size;
    }
    if (typeof parsed === 'object' && parsed !== null && 'rollOut' in parsed) {
      rollOut = ROLL_OUT_RULES.find((rule) => rule === parsed.rollOut) ?? rollOut;
    }
  } catch {
    // An unreadable value reads as the defaults.
  }
  return { teamSize, rollOut };
}

function parseEventData(raw: string): EventData {
  const out: Record<string, string | number | boolean | null> = {};
  try {
    const parsed: Untrusted = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return out;
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        out[key] = value;
      }
    }
  } catch {
    // An unreadable line has no details.
  }
  return out;
}

const sideOf = (raw: string | null): Side | null => (raw === 'a' || raw === 'b' ? raw : null);

function stateOf(raw: string): LobbyState {
  if (raw === 'drafting' || raw === 'ready_check' || raw === 'in_match' || raw === 'closed') {
    return raw;
  }
  return 'gathering';
}

function toPlayer(row: PlayerRow): LobbyPlayer {
  return {
    playerId: row.player_id,
    side: sideOf(row.side),
    joinedAt: Number(row.joined_at),
    waitingSince: row.waiting_since === null ? null : Number(row.waiting_since),
    ready: Boolean(row.ready),
    gamesInRow: Number(row.games_in_row),
  };
}

function toLobby(row: LobbyRow, players: PlayerRow[]): Lobby {
  return {
    id: row.id,
    state: stateOf(row.state),
    hostId: row.host_id,
    version: Number(row.version),
    settings: parseSettings(row.settings),
    teamsLocked: Boolean(row.teams_locked),
    pickedMap: row.picked_map,
    deadline: row.deadline_at === null ? null : Number(row.deadline_at),
    matchNo: Number(row.match_count),
    matchSlug: row.match_slug,
    draft: parseDraft(row.draft),
    players: players.map(toPlayer),
  };
}

const LOBBY_COLUMNS =
  'id, state, host_id, version, settings, teams_locked, picked_map, deadline_at, match_count, match_slug, draft, created_at';

async function playersOf(lobbyId: string): Promise<PlayerRow[]> {
  return db.queryAsync<PlayerRow>(
    `SELECT player_id, side, joined_at, waiting_since, ready, games_in_row
       FROM pickup_lobby_players WHERE lobby_id = ? ORDER BY joined_at, player_id`,
    [lobbyId]
  );
}

export async function loadLobby(id: string): Promise<Lobby | null> {
  const row = await db.queryOneAsync<LobbyRow>(
    `SELECT ${LOBBY_COLUMNS} FROM pickup_lobbies WHERE id = ?`,
    [id]
  );
  return row ? toLobby(row, await playersOf(id)) : null;
}

/** The lobbies that are not closed, oldest first. */
export async function loadOpenLobbies(): Promise<Lobby[]> {
  const rows = await db.queryAsync<LobbyRow>(
    `SELECT ${LOBBY_COLUMNS} FROM pickup_lobbies WHERE state <> 'closed' ORDER BY created_at, id`
  );
  return Promise.all(rows.map(async (row) => toLobby(row, await playersOf(row.id))));
}

/** The open lobby a player is in, if any. */
export async function openLobbyIdOf(playerId: string): Promise<string | null> {
  const row = await db.queryOneAsync<{ id: string }>(
    `SELECT l.id FROM pickup_lobbies l
       JOIN pickup_lobby_players p ON p.lobby_id = l.id
      WHERE p.player_id = ? AND l.state <> 'closed'
      LIMIT 1`,
    [playerId]
  );
  return row?.id ?? null;
}

async function inTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  await db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await fn(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function writePlayersAndEvents(
  client: PoolClient,
  lobby: Lobby,
  events: readonly LobbyEvent[],
  now: number
): Promise<void> {
  await client.query('DELETE FROM pickup_lobby_players WHERE lobby_id = $1', [lobby.id]);
  for (const p of lobby.players) {
    await client.query(
      `INSERT INTO pickup_lobby_players (lobby_id, player_id, side, joined_at, waiting_since, ready, games_in_row)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [lobby.id, p.playerId, p.side, p.joinedAt, p.waitingSince, p.ready, p.gamesInRow]
    );
  }
  for (const event of events) {
    await client.query(
      `INSERT INTO pickup_events (lobby_id, type, actor_id, data, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [lobby.id, event.type, event.actorId, JSON.stringify(event.data), now]
    );
  }
}

/** Insert a new lobby. Throws Postgres' unique violation (23505) when one is already open. */
export async function insertLobby(
  lobby: Lobby,
  events: readonly LobbyEvent[],
  now: number
): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO pickup_lobbies (id, game, mode, state, host_id, version, settings, teams_locked, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        lobby.id,
        PICKUP_GAME,
        PICKUP_MODE,
        lobby.state,
        lobby.hostId,
        lobby.version,
        JSON.stringify(lobby.settings),
        lobby.teamsLocked,
        now,
      ]
    );
    await writePlayersAndEvents(client, lobby, events, now);
  });
}

/** Write the lobby as decided, with its log lines. `fromVersion` is the version that was read. */
export async function saveLobby(
  lobby: Lobby,
  fromVersion: number,
  events: readonly LobbyEvent[],
  now: number
): Promise<void> {
  await inTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE pickup_lobbies
          SET state = $1, host_id = $2, version = $3, settings = $4, teams_locked = $5,
              closed_at = CASE WHEN $1 = 'closed' THEN $6::integer ELSE closed_at END,
              picked_map = $9, deadline_at = $10, match_count = $11, match_slug = $12, draft = $13,
              updated_at = $6::integer
        WHERE id = $7 AND version = $8`,
      [
        lobby.state,
        lobby.hostId,
        lobby.version,
        JSON.stringify(lobby.settings),
        lobby.teamsLocked,
        now,
        lobby.id,
        fromVersion,
        lobby.pickedMap,
        lobby.deadline,
        lobby.matchNo,
        lobby.matchSlug,
        lobby.draft ? JSON.stringify(lobby.draft) : null,
      ]
    );
    if (updated.rowCount !== 1) throw new Error('Pickup lobby changed while it was being written');
    await writePlayersAndEvents(client, lobby, events, now);
  });
}

/** The newest log lines of a lobby, oldest first. */
export async function loadEvents(lobbyId: string): Promise<StoredEvent[]> {
  const rows = await db.queryAsync<{
    id: number;
    type: string;
    actor_id: string;
    data: string;
    created_at: number;
  }>(
    `SELECT id, type, actor_id, data, created_at FROM pickup_events
      WHERE lobby_id = ? ORDER BY id DESC LIMIT ?`,
    [lobbyId, LOG_LIMIT]
  );
  return rows.reverse().map((row) => ({
    id: Number(row.id),
    type: row.type,
    actorId: row.actor_id,
    data: parseEventData(row.data),
    at: Number(row.created_at),
  }));
}

export async function loadNames(playerIds: readonly string[]): Promise<Map<string, PlayerName>> {
  const out = new Map<string, PlayerName>();
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return out;
  const rows = await db.queryAsync<{ id: string; name: string; avatar_url: string | null }>(
    'SELECT id, name, avatar_url FROM players WHERE id = ANY(?::text[])',
    [ids]
  );
  for (const row of rows)
    out.set(row.id, { id: row.id, name: row.name, avatarUrl: row.avatar_url });
  return out;
}

/** The open lobby whose running match is `slug`, if any. */
export async function lobbyIdOfMatch(slug: string): Promise<string | null> {
  const row = await db.queryOneAsync<{ id: string }>(
    "SELECT id FROM pickup_lobbies WHERE match_slug = ? AND state = 'in_match' LIMIT 1",
    [slug]
  );
  return row?.id ?? null;
}

export interface MatchState {
  /** The platform's status of the match: pending, loaded, live, completed, cancelled… */
  status: string;
  map: string | null;
  /** When the platform marked it over (epoch seconds), if it has. */
  completedAt: number | null;
}

/** The platform's row of a match, or null when there is none. */
export async function loadMatchState(slug: string): Promise<MatchState | null> {
  const row = await db.queryOneAsync<{
    status: string;
    map: string | null;
    completed_at: number | null;
  }>(
    `SELECT m.status, pm.map, m.completed_at FROM matches m
       LEFT JOIN pickup_matches pm ON pm.match_slug = m.slug
      WHERE m.slug = ?`,
    [slug]
  );
  if (!row) return null;
  return {
    status: row.status,
    map: row.map,
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

/** Record a lobby's match: who played on which side, and where. */
export async function insertPickupMatch(input: {
  lobbyId: string;
  slug: string;
  matchNo: number;
  map: string;
  teamA: readonly string[];
  teamB: readonly string[];
  now: number;
}): Promise<void> {
  await db.runAsync(
    `INSERT INTO pickup_matches (match_slug, lobby_id, match_no, map, team_a, team_b, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.slug,
      input.lobbyId,
      input.matchNo,
      input.map,
      JSON.stringify(input.teamA),
      JSON.stringify(input.teamB),
      input.now,
    ]
  );
}

/** How a lobby's match ended: 'a', 'b', 'draw', 'cancelled' or 'failed'. */
export async function endPickupMatch(slug: string, result: string, now: number): Promise<void> {
  await db.runAsync(
    'UPDATE pickup_matches SET result = ?, ended_at = ? WHERE match_slug = ? AND result IS NULL',
    [result, now, slug]
  );
}

/** When a lobby last changed (epoch seconds); its creation when it never has. */
export async function lobbyTouchedAt(id: string): Promise<number | null> {
  const row = await db.queryOneAsync<{ at: number | null }>(
    'SELECT COALESCE(updated_at, created_at) AS at FROM pickup_lobbies WHERE id = ?',
    [id]
  );
  return row?.at == null ? null : Number(row.at);
}

/** Who played a lobby's match, by side. */
export async function loadMatchRoster(slug: string): Promise<{ a: string[]; b: string[] } | null> {
  const row = await db.queryOneAsync<{ team_a: string; team_b: string }>(
    'SELECT team_a, team_b FROM pickup_matches WHERE match_slug = ?',
    [slug]
  );
  if (!row) return null;
  const list = (raw: string): string[] => {
    try {
      const parsed: Untrusted = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
      return [];
    }
  };
  return { a: list(row.team_a), b: list(row.team_b) };
}
