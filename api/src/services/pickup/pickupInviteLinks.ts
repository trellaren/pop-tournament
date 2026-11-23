/** Making and checking a pickup lobby's invite links against the lobby as it is now. */
import { sessionSecret } from '../../config/sessionSecret';
import { signInviteToken, verifyInviteToken } from './inviteToken';
import type { Actor, Lobby } from './rules';

/** The token of a new link to this lobby, for its host or an admin. */
export function inviteTokenFor(lobby: Lobby, actor: Actor, nowSeconds: number): string {
  return signInviteToken(
    sessionSecret(),
    {
      lobbyId: lobby.id,
      makerId: actor.playerId,
      maker: actor.playerId === lobby.hostId ? 'host' : 'admin',
    },
    nowSeconds
  );
}

/**
 * Whether a link lets its holder into this lobby: it is ours and in time,
 * names this lobby, and its maker still runs it (a host's link ends when the
 * host changes).
 */
export function linkAdmits(lobby: Lobby, token: string, nowSeconds: number): boolean {
  const link = verifyInviteToken(sessionSecret(), token, nowSeconds);
  if (link?.lobbyId !== lobby.id) return false;
  return link.maker === 'admin' || link.makerId === lobby.hostId;
}
