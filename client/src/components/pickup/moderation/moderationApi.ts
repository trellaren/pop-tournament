/** Pickup moderation's API (api routes/pickupAdmin.ts), for the moderation page. */
import { api } from '../../../utils/api';

export interface PickupBan {
  playerId: string;
  name: string;
  /** Epoch seconds, null until lifted. */
  until: number | null;
  reason: string | null;
}

export interface PickupNamed {
  playerId: string;
  name: string;
}

export interface PickupPlayerSetting extends PickupNamed {
  multiplier: number | null;
  displayNames: string[];
}

export interface PickupModerationView {
  bans: PickupBan[];
  /** Null for a moderator: only site admins see these. */
  moderators: PickupNamed[] | null;
  players: PickupPlayerSetting[] | null;
}

const at = (kind: string, playerId: string) =>
  `/api/pickup/admin/${kind}/${encodeURIComponent(playerId)}`;

export function readPickupModeration(): Promise<PickupModerationView> {
  return api.get('/api/pickup/admin');
}

export async function liftPickupBan(playerId: string): Promise<void> {
  await api.delete(at('bans', playerId));
}

export async function setPickupModerator(playerId: string, on: boolean): Promise<void> {
  await api.put(at('moderators', playerId), { on });
}

export async function setPickupPlayer(
  playerId: string,
  change: { multiplier: number | null; displayNames: string[] }
): Promise<void> {
  await api.put(at('players', playerId), change);
}
