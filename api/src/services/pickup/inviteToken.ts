/**
 * A pickup lobby's invite link (docs/design/pickup-lobby.md): a signed token
 * that names the lobby and who made it, good for twelve hours. Whoever holds
 * one may join that lobby while it is open and its maker still runs it. The
 * token is a secret of the lobby: never logged, never put in the lobby log.
 */
import crypto from 'crypto';

const PURPOSE = 'pickup-invite';
export const INVITE_LINK_SECONDS = 12 * 60 * 60;

/** Who made the link: the lobby's host, or a site admin. */
export type InviteMaker = 'host' | 'admin';

export interface InviteLink {
  lobbyId: string;
  makerId: string;
  maker: InviteMaker;
}

function mac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function signInviteToken(secret: string, link: InviteLink, nowSeconds: number): string {
  const role = link.maker === 'admin' ? 'a' : 'h';
  const payload = [PURPOSE, link.lobbyId, link.makerId, role, nowSeconds + INVITE_LINK_SECONDS];
  const text = payload.join('.');
  return `${text}.${mac(secret, text)}`;
}

/** What a token names, or null when it is not ours, was changed, or has run out. */
export function verifyInviteToken(
  secret: string,
  token: string,
  nowSeconds: number
): InviteLink | null {
  const parts = token.split('.');
  if (parts.length !== 6) return null;
  const [purpose, lobbyId, makerId, role, expiresRaw, signature] = parts;
  if (purpose !== PURPOSE || !/^[0-9a-f-]{36}$/.test(lobbyId) || !/^\d{1,32}$/.test(makerId)) {
    return null;
  }
  if (role !== 'a' && role !== 'h') return null;
  const expected = Buffer.from(mac(secret, parts.slice(0, 5).join('.')));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= nowSeconds) return null;
  return { lobbyId, makerId, maker: role === 'a' ? 'admin' : 'host' };
}

/** A token as a client may send it: its shape only. */
export const looksLikeInviteToken = (value: string): boolean =>
  /^[A-Za-z0-9._-]{40,400}$/.test(value);
