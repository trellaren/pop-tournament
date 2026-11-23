/**
 * The pickup Activity's token (docs/design/pickup-lobby.md): Discord's frame
 * does not carry the site's cookie, so after signing in through Discord the
 * Activity sends this short-lived token with every request instead. It names
 * one player and is good for one hour, for the pickup routes only.
 */
import crypto from 'crypto';

const PURPOSE = 'pickup-activity';
export const ACTIVITY_TOKEN_SECONDS = 60 * 60;

function mac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function signActivityToken(secret: string, playerId: string, nowSeconds: number): string {
  const payload = `${PURPOSE}.${playerId}.${nowSeconds + ACTIVITY_TOKEN_SECONDS}`;
  return `${payload}.${mac(secret, payload)}`;
}

/** The player a token names, or null when it is not ours, was changed, or has run out. */
export function verifyActivityToken(
  secret: string,
  token: string,
  nowSeconds: number
): string | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [purpose, playerId, expiresRaw, signature] = parts;
  if (purpose !== PURPOSE || !/^\d{1,32}$/.test(playerId)) return null;
  const expected = Buffer.from(mac(secret, `${purpose}.${playerId}.${expiresRaw}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires <= nowSeconds) return null;
  return playerId;
}

/** The token in an Authorization header, if it carries a bearer one. */
export function bearerOf(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._-]{16,512})$/.exec(header ?? '');
  return match ? match[1] : null;
}
