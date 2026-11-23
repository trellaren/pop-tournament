/**
 * What Discord users do to the pickup lobby: the panel's buttons and the
 * /pickup command. A press runs the same lobby command the page runs, as the
 * platform account that Discord account belongs to.
 */
import { log } from '../../../utils/logger';
import type { Untrusted } from '../../../utils/untrusted';
import { PickupError, pickupService } from '../../../services/pickup/pickupService';
import { actorOfDiscord as actorOf } from '../../../services/pickup/activitySignIn';
import { modeServers } from '../../../services/pickup/spectators';
import { commandOf, doneText, parseCustomId, plainName } from './panelText';
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
      name: 'invite',
      description: 'Host: invite someone to the lobby',
      options: [{ type: 6, name: 'user', description: 'Who to invite', required: true }],
    },
    {
      type: 1,
      name: 'spectate',
      description: 'Watch the running match from inside its server (not for its players)',
    },
    { type: 1, name: 'servers', description: 'The practice and retakes servers that are online' },
    {
      type: 1,
      name: 'substitute',
      description: 'Host: during a match, bring someone from the waiting room in for a player',
      options: [
        { type: 6, name: 'out', description: 'Who leaves the match', required: true },
        { type: 6, name: 'in', description: 'Who comes in', required: true },
      ],
    },
    {
      type: 1,
      name: 'invite-link',
      description: 'Host: a link that lets whoever holds it join, for 12 hours',
    },
    {
      type: 1,
      name: 'setup',
      description: 'Admins: where the panel is posted and which voice channel the lobby uses',
      options: [
        { type: 7, name: 'channel', description: 'Text channel for the panel', channel_types: [0] },
        { type: 7, name: 'voice', description: 'The lobby voice channel', channel_types: [2] },
        {
          type: 5,
          name: 'activity',
          description: 'Show Launch Dashboard on the panel (the lobby inside Discord)',
        },
      ],
    },
  ],
};

const NOT_LINKED =
  'I do not know your account yet: sign in on the site and connect Discord there, once. Then press again.';

function userIdOf(interaction: Record<string, Untrusted>): string | null {
  const member = interaction.member as { user?: { id?: Untrusted } } | undefined;
  const user = interaction.user as { id?: Untrusted } | undefined;
  const id = user?.id ?? member?.user?.id;
  return typeof id === 'string' ? id : null;
}

const NOT_LINKED_BOTH = 'Both people need to have connected Discord on the site.';

const NOT_LINKED_OTHER =
  'That person has not connected Discord on the site yet. Send them an invite link instead: /pickup invite-link';

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

/** The answer that opens the Activity for whoever pressed. */
export const LAUNCH_ACTIVITY = Symbol('launch the Activity');

/**
 * A pressed panel button. Answers with what to tell the presser alone, null
 * when the panel itself shows the result, or LAUNCH_ACTIVITY. Not ours: undefined.
 */
export async function pickupComponentAnswer(
  interaction: Record<string, Untrusted>
): Promise<string | null | undefined | typeof LAUNCH_ACTIVITY> {
  const data = interaction.data as { custom_id?: Untrusted; values?: Untrusted } | undefined;
  const parsed = typeof data?.custom_id === 'string' ? parseCustomId(data.custom_id) : null;
  if (!parsed) return undefined;
  if (parsed.action === 'launch') return LAUNCH_ACTIVITY;
  const userId = userIdOf(interaction);
  const actor = userId ? await actorOf(userId) : null;
  if (!actor) return NOT_LINKED;
  const [value] = Array.isArray(data?.values) ? (data.values as Untrusted[]) : [];
  const meant = commandOf(
    parsed.action,
    parsed.version,
    typeof value === 'string' ? value : undefined
  );
  if (!meant) return 'Choose from the menu.';
  return attempt(async () => {
    await pickupService.command(parsed.lobbyId, actor, meant.command, meant.version);
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

/** The practice and retakes servers, as lines for the console. */
async function servers(): Promise<string> {
  const online = await modeServers();
  const lines = (title: string, list: Array<{ name: string; address: string }>) =>
    list.length === 0
      ? [`${title}: none online`]
      : [`${title}:`, ...list.map((s) => `- ${plainName(s.name)}: \`connect ${s.address}\``)];
  return [...lines('Practice', online.practice), ...lines('Retakes', online.retakes)].join('\n');
}

async function setup(permissions: string | undefined, options: Untrusted): Promise<string> {
  if ((BigInt(permissions ?? '0') & ADMINISTRATOR) === 0n) {
    return 'Only an administrator of this Discord server can do that.';
  }
  const opts = optionsOf(options);
  const channel = opts.find((o) => o.name === 'channel')?.value;
  const voice = opts.find((o) => o.name === 'voice')?.value;
  const activity = opts.find((o) => o.name === 'activity')?.value;
  const saved = await setPickupDiscordSettings({
    ...(typeof channel === 'string' ? { channelId: channel } : {}),
    ...(typeof voice === 'string' ? { voiceChannelId: voice } : {}),
    ...(typeof activity === 'boolean' ? { activity } : {}),
  });
  const lobbyId = await pickupService.openLobbyId();
  if (lobbyId) schedulePanel(lobbyId);
  return [
    saved.channelId ? `Panel channel: <#${saved.channelId}>` : 'Panel channel: not set',
    saved.voiceChannelId
      ? `Lobby voice channel: <#${saved.voiceChannelId}>`
      : 'Lobby voice channel: not set (nobody is moved)',
    `Launch Dashboard on the panel: ${saved.activity ? 'on' : 'off'}`,
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
    if (sub.name === 'servers') return servers();
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
    if (sub.name === 'invite') {
      const who = optionsOf(sub.options).find((o) => o.name === 'user')?.value;
      const invited = typeof who === 'string' ? await actorOf(who) : null;
      if (!invited) return NOT_LINKED_OTHER;
      await pickupService.command(lobbyId, actor, { type: 'invite', playerId: invited.playerId });
      return `Invited <@${String(who)}>.`;
    }
    if (sub.name === 'spectate') {
      const connect = await pickupService.spectate(lobbyId, actor);
      if (!connect) return 'You are on the spectator list. The match has no server yet: ask again.';
      const password = connect.password ? `; password ${connect.password}` : '';
      return `In the game console: \`connect ${connect.host}:${connect.port}${password}\``;
    }
    if (sub.name === 'substitute') {
      const named = (name: string) => optionsOf(sub.options).find((o) => o.name === name)?.value;
      const [out, incoming] = await Promise.all(
        ['out', 'in'].map(async (name) => {
          const who = named(name);
          return typeof who === 'string' ? actorOf(who) : null;
        })
      );
      if (!out || !incoming) return NOT_LINKED_BOTH;
      const lobby = await pickupService.view(lobbyId, actor);
      await pickupService.command(
        lobbyId,
        actor,
        { type: 'substitute', outId: out.playerId, inId: incoming.playerId },
        lobby.version
      );
      return 'Substituted. The match server is being told.';
    }
    if (sub.name === 'invite-link') {
      const token = await pickupService.inviteToken(lobbyId, actor);
      return `Whoever opens this can join, for 12 hours: ${siteUrl()}/pickup/${lobbyId}?invite=${token}`;
    }
    return 'I do not know that command.';
  });
  return answer ?? 'Done.';
}
