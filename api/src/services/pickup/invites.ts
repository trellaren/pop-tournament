/**
 * Who can join a pickup lobby (docs/design/pickup-lobby.md): the invite list
 * and the rule that reads it. Pure. The setting restricts joining, never
 * seeing.
 */
import {
  MAX_INVITES,
  done,
  mayManage,
  refuse,
  type Actor,
  type Lobby,
  type Outcome,
} from './lobby';

export const isInvited = (lobby: Lobby, playerId: string): boolean =>
  lobby.invited.includes(playerId);

/** Whether someone not in the lobby may come in: `byLink` when their invite link checked out. */
export function mayEnter(lobby: Lobby, actor: Actor, byLink: boolean): boolean {
  if (lobby.settings.visibility === 'open') return true;
  return byLink || mayManage(lobby, actor) || isInvited(lobby, actor.playerId);
}

/** The list with these people on it, oldest kept first, or null when it would be too long. */
export function withInvited(lobby: Lobby, playerIds: readonly string[]): string[] | null {
  const added = playerIds.filter((id) => !lobby.invited.includes(id));
  const next = [...lobby.invited, ...new Set(added)];
  return next.length > MAX_INVITES ? null : next;
}

export const withoutInvite = (lobby: Lobby, playerId: string): Lobby =>
  isInvited(lobby, playerId)
    ? { ...lobby, invited: lobby.invited.filter((id) => id !== playerId) }
    : lobby;

export function invite(lobby: Lobby, actor: Actor, playerId: string): Outcome {
  // The host needs no invite, and nobody invites themselves.
  if (playerId === actor.playerId) return refuse('not_allowed');
  if (isInvited(lobby, playerId)) return refuse('already_invited');
  const invited = withInvited(lobby, [playerId]);
  if (!invited) return refuse('invite_limit');
  return done({ ...lobby, invited }, [
    { type: 'invited', actorId: actor.playerId, data: { playerId } },
  ]);
}

/** Take someone off the list. Someone already in the lobby stays; Kick takes them out. */
export function revokeInvite(lobby: Lobby, actor: Actor, playerId: string): Outcome {
  if (!isInvited(lobby, playerId)) return refuse('not_invited');
  return done(withoutInvite(lobby, playerId), [
    { type: 'invite_revoked', actorId: actor.playerId, data: { playerId } },
  ]);
}
