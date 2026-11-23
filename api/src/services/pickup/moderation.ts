/**
 * Pickup moderation in the database (docs/design/pickup-lobby.md): the
 * moderators, bans from pickup, and what an admin set per player (a balance
 * multiplier, display names). A ban's reason is for moderators only: it is
 * never sent to the player and never logged.
 */
import { db } from '../../config/database';
import { log } from '../../utils/logger';
import type { Untrusted } from '../../utils/untrusted';
import type { Actor } from './lobby';
import { banHolds, displayNameFor, type Ban } from './moderationRules';

/** The actor a signed-in player is in pickup: a moderator runs any lobby, as a site admin does. */
export async function actorFor(playerId: string, siteAdmin: boolean): Promise<Actor> {
  if (siteAdmin) return { playerId, isAdmin: true, siteAdmin: true };
  const row = await db.queryOneAsync<{ player_id: string }>(
    'SELECT player_id FROM pickup_moderators WHERE player_id = ?',
    [playerId]
  );
  return { playerId, isAdmin: Boolean(row), siteAdmin: false };
}

/** The ban that keeps a player out of pickup now, if one holds. */
export async function activeBanOf(playerId: string, now: number): Promise<Ban | null> {
  const row = await db.queryOneAsync<{ until_at: number | null }>(
    'SELECT until_at FROM pickup_bans WHERE player_id = ?',
    [playerId]
  );
  const ban = row ? { playerId, until: row.until_at === null ? null : Number(row.until_at) } : null;
  return banHolds(ban, now) ? ban : null;
}

export async function writeBan(
  playerId: string,
  until: number | null,
  reason: string | null,
  by: Actor,
  now: number
): Promise<void> {
  await db.runAsync(
    `INSERT INTO pickup_bans (player_id, until_at, reason, banned_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (player_id) DO UPDATE
       SET until_at = EXCLUDED.until_at, reason = EXCLUDED.reason,
           banned_by = EXCLUDED.banned_by, created_at = EXCLUDED.created_at`,
    [playerId, until, reason, by.playerId, now]
  );
  log.warn('[AUDIT] Player banned from pickup', { playerId, by: by.playerId, until });
}

/** Lift a ban. False when there was none. */
export async function liftBan(playerId: string, by: Actor): Promise<boolean> {
  const gone = await db.runAsync('DELETE FROM pickup_bans WHERE player_id = ?', [playerId]);
  if (gone.changes !== 1) return false;
  log.warn('[AUDIT] Pickup ban lifted', { playerId, by: by.playerId });
  return true;
}

export interface BanRow {
  playerId: string;
  name: string;
  until: number | null;
  reason: string | null;
  bannedBy: string;
  at: number;
}

/** The bans that hold now, newest first, for moderators. */
export async function listBans(now: number): Promise<BanRow[]> {
  const rows = await db.queryAsync<{
    player_id: string;
    name: string;
    until_at: number | null;
    reason: string | null;
    banned_by: string;
    created_at: number;
  }>(
    `SELECT b.player_id, p.name, b.until_at, b.reason, b.banned_by, b.created_at
       FROM pickup_bans b JOIN players p ON p.id = b.player_id
      WHERE b.until_at IS NULL OR b.until_at > ?
      ORDER BY b.created_at DESC`,
    [now]
  );
  return rows.map((row) => ({
    playerId: row.player_id,
    name: row.name,
    until: row.until_at === null ? null : Number(row.until_at),
    reason: row.reason,
    bannedBy: row.banned_by,
    at: Number(row.created_at),
  }));
}

export async function setModerator(playerId: string, on: boolean, by: Actor, now: number) {
  if (on) {
    await db.runAsync(
      `INSERT INTO pickup_moderators (player_id, added_by, added_at) VALUES (?, ?, ?)
       ON CONFLICT (player_id) DO NOTHING`,
      [playerId, by.playerId, now]
    );
  } else {
    await db.runAsync('DELETE FROM pickup_moderators WHERE player_id = ?', [playerId]);
  }
  log.warn('[AUDIT] Pickup moderator changed', { playerId, on, by: by.playerId });
}

export async function listModerators(): Promise<Array<{ playerId: string; name: string }>> {
  const rows = await db.queryAsync<{ player_id: string; name: string }>(
    `SELECT m.player_id, p.name FROM pickup_moderators m JOIN players p ON p.id = m.player_id
      ORDER BY p.name`
  );
  return rows.map((row) => ({ playerId: row.player_id, name: row.name }));
}

function namesOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: Untrusted = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export interface PlayerSetting {
  playerId: string;
  name: string;
  multiplier: number | null;
  displayNames: string[];
}

/** What admins set per player; only rows that still say something. */
export async function listPlayerSettings(): Promise<PlayerSetting[]> {
  const rows = await db.queryAsync<{
    player_id: string;
    name: string;
    multiplier: number | null;
    display_names: string | null;
  }>(
    `SELECT s.player_id, p.name, s.multiplier, s.display_names
       FROM pickup_player_settings s JOIN players p ON p.id = s.player_id ORDER BY p.name`
  );
  return rows
    .map((row) => ({
      playerId: row.player_id,
      name: row.name,
      multiplier: row.multiplier === null ? null : Number(row.multiplier),
      displayNames: namesOf(row.display_names),
    }))
    .filter((row) => row.multiplier !== null || row.displayNames.length > 0);
}

/** Set a player's multiplier and display names; undefined leaves one as it is. */
export async function writePlayerSetting(
  playerId: string,
  change: { multiplier?: number | null; displayNames?: string[] },
  by: Actor,
  now: number
): Promise<void> {
  const current = await db.queryOneAsync<{
    multiplier: number | null;
    display_names: string | null;
  }>('SELECT multiplier, display_names FROM pickup_player_settings WHERE player_id = ?', [
    playerId,
  ]);
  const multiplier =
    change.multiplier === undefined ? (current?.multiplier ?? null) : change.multiplier;
  const names = change.displayNames ?? namesOf(current?.display_names ?? null);
  await db.runAsync(
    `INSERT INTO pickup_player_settings (player_id, multiplier, display_names, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (player_id) DO UPDATE
       SET multiplier = EXCLUDED.multiplier, display_names = EXCLUDED.display_names,
           updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [playerId, multiplier, names.length > 0 ? JSON.stringify(names) : null, by.playerId, now]
  );
  // Which setting, never its value: the multiplier is for admins only.
  log.warn('[AUDIT] Pickup player setting changed', {
    playerId,
    by: by.playerId,
    setting: Object.keys(change).join(','),
  });
}

/** The multipliers of these players that are not 1. */
export async function multipliersOf(playerIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (playerIds.length === 0) return out;
  const rows = await db.queryAsync<{ player_id: string; multiplier: number | null }>(
    'SELECT player_id, multiplier FROM pickup_player_settings WHERE player_id = ANY(?::text[])',
    [[...new Set(playerIds)]]
  );
  for (const row of rows) {
    if (row.multiplier !== null) out.set(row.player_id, Number(row.multiplier));
  }
  return out;
}

/** The name shown today in place of each of these players' own, where an admin set some. */
export async function displayNamesOf(
  playerIds: readonly string[],
  now: number
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (playerIds.length === 0) return out;
  const rows = await db.queryAsync<{ player_id: string; display_names: string | null }>(
    `SELECT player_id, display_names FROM pickup_player_settings
      WHERE player_id = ANY(?::text[]) AND display_names IS NOT NULL`,
    [[...new Set(playerIds)]]
  );
  for (const row of rows) {
    const shown = displayNameFor(namesOf(row.display_names), row.player_id, now);
    if (shown) out.set(row.player_id, shown);
  }
  return out;
}

/** Whether a player of the site exists (not deleted). */
export async function playerExists(playerId: string): Promise<boolean> {
  const row = await db.queryOneAsync<{ id: string }>(
    'SELECT id FROM players WHERE id = ? AND deleted_at IS NULL',
    [playerId]
  );
  return Boolean(row);
}

/** Delete what pickup keeps about a player; `keepSettings` leaves their ban and admin settings. */
export async function forgetRows(playerId: string, keepSettings: boolean): Promise<void> {
  await db.runAsync('DELETE FROM pickup_lobby_invites WHERE player_id = ?', [playerId]);
  await db.runAsync('DELETE FROM pickup_moderators WHERE player_id = ?', [playerId]);
  if (keepSettings) return;
  await db.runAsync('DELETE FROM pickup_bans WHERE player_id = ?', [playerId]);
  await db.runAsync('DELETE FROM pickup_player_settings WHERE player_id = ?', [playerId]);
}
