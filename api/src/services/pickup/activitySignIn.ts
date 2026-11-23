/**
 * Signing in to the pickup Activity: the code Discord's Embedded App SDK
 * gives the page is exchanged with Discord for who the person is, and the
 * platform account with that Discord account gets an Activity token.
 *
 * The Discord application is the one set up for "Sign in with Discord"
 * (Settings, sign-in providers): its client id and secret are used, and it
 * must be the application the bot and the Activity belong to.
 */
import { db } from '../../config/database';
import { actorFor } from './moderation';
import { sessionSecret } from '../../config/sessionSecret';
import { effectiveProviderSettings } from '../../config/signInProviders';
import { log } from '../../utils/logger';
import type { Untrusted } from '../../utils/untrusted';
import { ACTIVITY_TOKEN_SECONDS, signActivityToken, verifyActivityToken } from './activityToken';
import type { Actor } from './rules';

const DISCORD_API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 8000;

export type ActivitySignIn =
  | { ok: true; token: string; expiresAt: number; accessToken: string; playerId: string }
  | { ok: false; code: 'not_configured' | 'discord_refused' | 'not_linked' };

/** The Discord application's id, when Discord sign-in is set up; the Activity authorizes against it. */
export function activityClientId(): string | null {
  const settings = effectiveProviderSettings('discord');
  return settings.clientId && settings.secret ? settings.clientId : null;
}

type FetchResponse = Awaited<ReturnType<typeof globalThis.fetch>>;

async function json(response: FetchResponse): Promise<Record<string, Untrusted>> {
  const body: Untrusted = await response.json().catch(() => null);
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

/** The player whose verified Discord account this is, if they may sign in. */
export async function actorOfDiscord(discordUserId: string): Promise<Actor | null> {
  const row = await db.queryOneAsync<{ id: string | null; is_admin: number | null }>(
    `SELECT p.id, p.is_admin FROM players p
      WHERE p.id = COALESCE(
        (SELECT steam_id FROM auth_identities WHERE provider = 'discord' AND provider_user_id = ? ORDER BY id DESC LIMIT 1),
        (SELECT id FROM players WHERE discord_id = ? LIMIT 1)
      ) AND p.deleted_at IS NULL AND p.banned_at IS NULL`,
    [discordUserId, discordUserId]
  );
  return row?.id ? actorFor(row.id, Number(row.is_admin) === 1) : null;
}

/** The player a request's Activity token names, read again so a ban or a lost admin right holds. */
export async function actorOfActivityToken(
  token: string,
  nowSeconds: number
): Promise<Actor | null> {
  const playerId = verifyActivityToken(sessionSecret(), token, nowSeconds);
  if (!playerId) return null;
  const row = await db.queryOneAsync<{ id: string; is_admin: number | null }>(
    'SELECT id, is_admin FROM players WHERE id = ? AND deleted_at IS NULL AND banned_at IS NULL',
    [playerId]
  );
  return row ? actorFor(row.id, Number(row.is_admin) === 1) : null;
}

export async function signInToActivity(code: string, nowSeconds: number): Promise<ActivitySignIn> {
  const settings = effectiveProviderSettings('discord');
  if (!settings.clientId || !settings.secret) return { ok: false, code: 'not_configured' };
  try {
    // An Activity's code is exchanged with no redirect_uri.
    const exchanged = await globalThis.fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new globalThis.URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: settings.clientId,
        client_secret: settings.secret,
      }),
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    const accessToken = (await json(exchanged)).access_token;
    if (!exchanged.ok || typeof accessToken !== 'string') {
      log.warn(`[PICKUP] Discord refused an Activity code: ${exchanged.status}`);
      return { ok: false, code: 'discord_refused' };
    }
    const me = await globalThis.fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    const discordId = (await json(me)).id;
    if (!me.ok || typeof discordId !== 'string') return { ok: false, code: 'discord_refused' };
    const actor = await actorOfDiscord(discordId);
    if (!actor) return { ok: false, code: 'not_linked' };
    return {
      ok: true,
      token: signActivityToken(sessionSecret(), actor.playerId, nowSeconds),
      expiresAt: nowSeconds + ACTIVITY_TOKEN_SECONDS,
      accessToken,
      playerId: actor.playerId,
    };
  } catch (error) {
    log.warn('[PICKUP] Activity sign-in could not reach Discord', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: 'discord_refused' };
  }
}
