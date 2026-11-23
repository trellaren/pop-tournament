/**
 * What moderators and admins do in pickup (docs/design/pickup-lobby.md): ban
 * someone from pickup lobbies and lift it, name moderators, and set a
 * player's balance multiplier and display names. Moderators (and admins) ban;
 * only site admins do the rest.
 */
import { emitTopic } from '../socketService';
import type { Actor } from './lobby';
import {
  listBans,
  listModerators,
  listPlayerSettings,
  liftBan,
  forgetRows,
  playerExists,
  setModerator,
  writeBan,
  writePlayerSetting,
  type BanRow,
  type PlayerSetting,
} from './moderation';
import { banUntil, cleanDisplayNames, cleanReason, validMultiplier } from './moderationRules';
import { PickupError } from './pickupErrors';
import { PICKUP_TOPIC, pickupService } from './pickupService';
import { openLobbyIdOf } from './pickupStore';

const now = () => Math.floor(Date.now() / 1000);
const bad = (message: string) => new PickupError(400, 'bad_request', message);
const notAllowed = (message: string) => new PickupError(403, 'not_allowed', message);

function requireModerator(actor: Actor): void {
  if (!actor.isAdmin) throw notAllowed('Only a moderator or an admin can do that');
}
function requireSiteAdmin(actor: Actor): void {
  if (!actor.siteAdmin) throw notAllowed('Only an admin can do that');
}
async function requirePlayer(playerId: string): Promise<void> {
  if (!(await playerExists(playerId))) {
    throw new PickupError(404, 'unknown_player', 'No such player on the site');
  }
}

/** Take someone out of the open lobby they are in; one playing a match stays until it ends. */
export async function removeFromLobby(playerId: string, by: Actor): Promise<void> {
  const lobbyId = await openLobbyIdOf(playerId);
  if (!lobbyId) return;
  const command =
    playerId === by.playerId ? ({ type: 'leave' } as const) : ({ type: 'kick', playerId } as const);
  await pickupService.command(lobbyId, by, command).catch((error: Error) => {
    if (!(error instanceof PickupError)) throw error;
  });
}

/**
 * Ban a player from pickup lobbies for `lengthSeconds` (null: until lifted).
 * The reason is kept for moderators only. Banning again replaces the ban.
 */
export async function banFromPickup(
  by: Actor,
  playerId: string,
  lengthSeconds: number | null,
  reason: string | null
): Promise<void> {
  requireModerator(by);
  if (playerId === by.playerId) throw bad('You cannot ban yourself');
  await requirePlayer(playerId);
  const at = now();
  const until = banUntil(lengthSeconds, at);
  if (until === undefined) throw bad('length must be from one hour to thirty days, or null');
  await writeBan(playerId, until, cleanReason(reason), by, at);
  await removeFromLobby(playerId, by);
}

export async function unbanFromPickup(by: Actor, playerId: string): Promise<void> {
  requireModerator(by);
  if (!(await liftBan(playerId, by))) {
    throw new PickupError(409, 'no_change', 'That player is not banned from pickup');
  }
}

export interface ModerationView {
  bans: BanRow[];
  /** Null for a moderator: only admins see who the moderators are set, multipliers and names. */
  moderators: Array<{ playerId: string; name: string }> | null;
  players: PlayerSetting[] | null;
}

export async function moderationView(by: Actor): Promise<ModerationView> {
  requireModerator(by);
  const bans = await listBans(now());
  if (!by.siteAdmin) return { bans, moderators: null, players: null };
  const [moderators, players] = await Promise.all([listModerators(), listPlayerSettings()]);
  return { bans, moderators, players };
}

export async function changeModerator(by: Actor, playerId: string, on: boolean): Promise<void> {
  requireSiteAdmin(by);
  await requirePlayer(playerId);
  await setModerator(playerId, on, by, now());
}

/** Set a player's multiplier (null: back to 1) and display names (empty: none). */
export async function changePlayerSetting(
  by: Actor,
  playerId: string,
  change: { multiplier?: number | null; displayNames?: string[] }
): Promise<void> {
  requireSiteAdmin(by);
  await requirePlayer(playerId);
  const { multiplier } = change;
  if (multiplier !== undefined && multiplier !== null && !validMultiplier(multiplier)) {
    throw bad('multiplier must be from 0.1 to 1, or null');
  }
  const names =
    change.displayNames === undefined ? undefined : cleanDisplayNames(change.displayNames);
  if (names === null) throw bad('displayNames must be at most 12 names of at most 32 characters');
  await writePlayerSetting(
    playerId,
    {
      // A multiplier of 1 is none at all.
      ...(multiplier === undefined ? {} : { multiplier: multiplier === 1 ? null : multiplier }),
      ...(names === undefined ? {} : { displayNames: names }),
    },
    by,
    now()
  );
  // The lobby pages show names: have them read again.
  emitTopic(PICKUP_TOPIC);
}

/**
 * A player was banned from the site or deleted: out of the open lobby, off
 * every invite list, and nothing an admin set for them in pickup is kept.
 */
export async function forgetPickupPlayer(playerId: string, keepSettings: boolean): Promise<void> {
  await removeFromLobby(playerId, { playerId: 'system', isAdmin: true });
  await forgetRows(playerId, keepSettings);
}
