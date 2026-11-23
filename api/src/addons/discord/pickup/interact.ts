/**
 * What Discord users do to the pickup lobby: the panel's buttons and the
 * /pickup command. A press runs the same lobby command the page runs, as the
 * platform account that Discord account belongs to.
 */
import { db } from '../../../config/database';
import { log } from '../../../utils/logger';
import type { Untrusted } from '../../../utils/untrusted';
import { PickupError, pickupService } from '../../../services/pickup/pickupService';
import type { Actor } from '../../../services/pickup/rules';
import { commandOf, doneText, parseCustomId } from './panelText';
import { schedulePanel } from './panel';
import { setPickupDiscordSettings, siteUrl } from './settings';

const ADMINISTRATOR = 1n << 3n;

/** The /pickup command as registered with Discord. */
export const PICKUP_COMMAND = {
  name: 'pickup',
  description: 'The pickup lobby: pick teams and play',
  dm_permission: false,
  options: [
    { type: 1, name: 'show', description: 'Where the lobby is and who is in it' },
    { type: 1, name: 'open', description: 'Open a lobby, with you as its host' },
    {
      type: 1,
      name: 'join',
      description: 'Join the open lobby',
      options: [
        {
          type: 3,
          name: 'where',
          description: 'Team A, Team B or the waiting room (default)',
          choices: [
            { name: 'Team A', value: 'a' },
            { name: 'Team B', value: 'b' },
            { name: 'Waiting room', value: 'waiting' },
          ],
        },
      ],
    },
    { type: 1, name: 'leave', description: 'Leave the lobby' },
    {
      type: 1,
      name: 'setup',
      description: 'Admins: where the panel is posted and which voice channel the lobby uses',
      options: [
        { type: 7, name: 'channel', description: 'Text channel for the panel', channel_types: [0] },
        { type: 7, name: 'voice', description: 'The lobby voice channel', channel_types: [2] },
      ],
    },
  ],
};

const NOT_LINKED =
  'I do not know your account yet: sign in on the site and connect Discord there, once. Then press again.';

/** The platform account a Discord user acts as, or null when none has that Discord account. */
async function actorOf(discordUserId: string): Promise<Actor | null> {
  const row = await db.queryOneAsync<{ id: string | null; is_admin: number | null }>(
    `SELECT p.id, p.is_admin FROM players p
      WHERE p.id = COALESCE(
        (SELECT steam_id FROM auth_identities WHERE provider = 'discord' AND provider_user_id = ? ORDER BY id DESC LIMIT 1),
        (SELECT id FROM players WHERE discord_id = ? LIMIT 1)
      ) AND p.deleted_at IS NULL AND p.banned_at IS NULL`,
    [discordUserId, discordUserId]
  );
  return row?.id ? { playerId: row.id, isAdmin: Number(row.is_admin) === 1 } : null;
}

function userIdOf(interaction: Record<string, Untrusted>): string | null {
  const member = interaction.member as { user?: { id?: Untrusted } } | undefined;
  const user = interaction.user as { id?: Untrusted } | undefined;
  const id = user?.id ?? member?.user?.id;
  return typeof id === 'string' ? id : null;
}

/** Run something for the lobby and answer in words; a refusal is its own words. */
async function attempt(what: () => Promise<string | null>): Promise<string | null> {
  try {
    return await what();
  } catch (error) {
    if (error instanceof PickupError) return `${error.message}.`;
    log.warn('[Discord] A pickup interaction failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'Something went wrong; try again in a moment.';
  }
}

/**
 * A pressed panel button. Answers with what to tell the presser alone, or
 * null when the panel itself shows the result. Not ours: undefined.
 */
export async function pickupComponentAnswer(
  interaction: Record<string, Untrusted>
): Promise<string | null | undefined> {
  const data = interaction.data as { custom_id?: Untrusted } | undefined;
  const parsed = typeof data?.custom_id === 'string' ? parseCustomId(data.custom_id) : null;
  if (!parsed) return undefined;
  const userId = userIdOf(interaction);
  const actor = userId ? await actorOf(userId) : null;
  if (!actor) return NOT_LINKED;
  const { command, version } = commandOf(parsed.action, parsed.version);
  return attempt(async () => {
    await pickupService.command(parsed.lobbyId, actor, command, version);
    return doneText(parsed.action);
  });
}

function optionsOf(
  raw: Untrusted
): Array<{ name?: string; value?: Untrusted; options?: Untrusted }> {
  return Array.isArray(raw)
    ? (raw as Array<{ name?: string; value?: Untrusted; options?: Untrusted }>)
    : [];
}

async function show(): Promise<string> {
  const lobbyId = await pickupService.openLobbyId();
  if (!lobbyId) return `No lobby is open. Open one with /pickup open, or at ${siteUrl()}/pickup`;
  const lobby = await pickupService.view(lobbyId, { playerId: '', isAdmin: false });
  const size = lobby.settings.teamSize;
  return [
    `Lobby: ${siteUrl()}/pickup/${lobbyId}`,
    `Team A ${lobby.teams.a.length}/${size} · Team B ${lobby.teams.b.length}/${size} · waiting ${lobby.waiting.length}`,
  ].join('\n');
}

async function setup(permissions: string | undefined, options: Untrusted): Promise<string> {
  if ((BigInt(permissions ?? '0') & ADMINISTRATOR) === 0n) {
    return 'Only an administrator of this Discord server can do that.';
  }
  const opts = optionsOf(options);
  const channel = opts.find((o) => o.name === 'channel')?.value;
  const voice = opts.find((o) => o.name === 'voice')?.value;
  const saved = await setPickupDiscordSettings({
    ...(typeof channel === 'string' ? { channelId: channel } : {}),
    ...(typeof voice === 'string' ? { voiceChannelId: voice } : {}),
  });
  const lobbyId = await pickupService.openLobbyId();
  if (lobbyId) schedulePanel(lobbyId);
  return [
    saved.channelId ? `Panel channel: <#${saved.channelId}>` : 'Panel channel: not set',
    saved.voiceChannelId
      ? `Lobby voice channel: <#${saved.voiceChannelId}>`
      : 'Lobby voice channel: not set (nobody is moved)',
  ].join('\n');
}

/** What /pickup answers (only the asker sees it). */
export async function pickupCommandAnswer(interaction: Record<string, Untrusted>): Promise<string> {
  const data = interaction.data as { options?: Untrusted } | undefined;
  const sub = optionsOf(data?.options)[0] ?? {};
  const member = interaction.member as { permissions?: string } | undefined;
  const answer = await attempt(async () => {
    if (!sub.name || sub.name === 'show') return show();
    if (sub.name === 'setup') return setup(member?.permissions, sub.options);
    const userId = userIdOf(interaction);
    const actor = userId ? await actorOf(userId) : null;
    if (!actor) return NOT_LINKED;
    if (sub.name === 'open') {
      const id = await pickupService.open(actor);
      return `Your lobby is open: ${siteUrl()}/pickup/${id}`;
    }
    const lobbyId = await pickupService.openLobbyId();
    if (!lobbyId) return 'No lobby is open. Open one with /pickup open.';
    if (sub.name === 'leave') {
      await pickupService.command(lobbyId, actor, { type: 'leave' });
      return 'You left the lobby.';
    }
    if (sub.name === 'join') {
      const where = optionsOf(sub.options).find((o) => o.name === 'where')?.value;
      const side = where === 'a' || where === 'b' ? where : null;
      await pickupService.command(lobbyId, actor, { type: 'join', side });
      return `You are in: ${siteUrl()}/pickup/${lobbyId}`;
    }
    return 'I do not know that command.';
  });
  return answer ?? 'Done.';
}
