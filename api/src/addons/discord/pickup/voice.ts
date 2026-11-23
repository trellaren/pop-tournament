/**
 * Voice channels for a pickup match: at its start the bot makes "#N Team A"
 * and "#N Team B" beside the lobby voice channel and moves each side into its
 * own; when the match is over it moves everyone back and deletes them.
 */
import { db } from '../../../config/database';
import { log } from '../../../utils/logger';
import { discordIdOf } from '../../../services/notifyChannels';
import { matchSlugOf } from '../../../services/pickup/rules';
import { loadMatchRoster } from '../../../services/pickup/pickupStore';
import type { PickupChange } from '../../../services/pickup/pickupBus';
import { botToken, pickedGuildId } from '../bot';
import { discordFetch } from '../rest';
import { pickupDiscordSettings } from './settings';

const VOICE_CHANNEL = 2;
const now = () => Math.floor(Date.now() / 1000);

interface VoiceRow {
  lobby_channel_id: string;
  team_a_channel_id: string | null;
  team_b_channel_id: string | null;
}

/** Move players into a voice channel. Discord refuses for someone not in voice: they are left alone. */
async function move(
  token: string,
  guildId: string,
  playerIds: readonly string[],
  channelId: string
): Promise<void> {
  for (const playerId of playerIds) {
    const discordId = await discordIdOf(playerId);
    if (!discordId) continue;
    await discordFetch(token, `/guilds/${guildId}/members/${discordId}`, {
      method: 'PATCH',
      body: { channel_id: channelId },
    });
  }
}

async function makeChannel(
  token: string,
  guildId: string,
  name: string,
  parentId: string | null
): Promise<string | null> {
  // No permission overwrites: the channel takes its category's, as the lobby channel does.
  const made = await discordFetch(token, `/guilds/${guildId}/channels`, {
    method: 'POST',
    body: { name, type: VOICE_CHANNEL, ...(parentId ? { parent_id: parentId } : {}) },
  });
  if (!made.ok || typeof made.body.id !== 'string') {
    log.warn(`[Discord] Making a pickup team voice channel failed: ${made.status}`);
    return null;
  }
  return made.body.id;
}

/** The match was made: split the teams into their own channels. Once per match. */
async function splitTeams(slug: string, matchNo: number): Promise<void> {
  const token = await botToken();
  const guildId = await pickedGuildId();
  const { voiceChannelId } = await pickupDiscordSettings();
  if (!token || !guildId || !voiceChannelId) return;
  const claimed = await db.runAsync(
    `INSERT INTO pickup_discord_voice (match_slug, lobby_channel_id, created_at)
     VALUES (?, ?, ?) ON CONFLICT (match_slug) DO NOTHING`,
    [slug, voiceChannelId, now()]
  );
  if (claimed.changes !== 1) return;
  const roster = await loadMatchRoster(slug);
  if (!roster) return;
  const lobbyChannel = await discordFetch(token, `/channels/${voiceChannelId}`);
  const parentId =
    lobbyChannel.ok && typeof lobbyChannel.body.parent_id === 'string'
      ? lobbyChannel.body.parent_id
      : null;
  const teamA = await makeChannel(token, guildId, `#${matchNo} Team A`, parentId);
  const teamB = await makeChannel(token, guildId, `#${matchNo} Team B`, parentId);
  await db.runAsync(
    'UPDATE pickup_discord_voice SET team_a_channel_id = ?, team_b_channel_id = ? WHERE match_slug = ?',
    [teamA, teamB, slug]
  );
  if (teamA) await move(token, guildId, roster.a, teamA);
  if (teamB) await move(token, guildId, roster.b, teamB);
}

/** The match is over: everyone back to the lobby channel, then the team channels go. */
async function bringBack(slug: string): Promise<void> {
  const row = await db.queryOneAsync<VoiceRow>(
    'SELECT lobby_channel_id, team_a_channel_id, team_b_channel_id FROM pickup_discord_voice WHERE match_slug = ?',
    [slug]
  );
  if (!row) return;
  const token = await botToken();
  const guildId = await pickedGuildId();
  if (!token || !guildId) return;
  const roster = await loadMatchRoster(slug);
  if (roster) await move(token, guildId, [...roster.a, ...roster.b], row.lobby_channel_id);
  let allGone = true;
  for (const channelId of [row.team_a_channel_id, row.team_b_channel_id]) {
    if (!channelId) continue;
    const gone = await discordFetch(token, `/channels/${channelId}`, { method: 'DELETE' });
    // 404: someone deleted it already.
    if (!gone.ok && gone.status !== 404) {
      allGone = false;
      log.warn(`[Discord] Removing a pickup team voice channel failed: ${gone.status}`);
    }
  }
  if (allGone) await db.runAsync('DELETE FROM pickup_discord_voice WHERE match_slug = ?', [slug]);
}

/** A substitution: the substitute to their team's channel, the leaver back to the lobby channel. */
async function followSubstitution(slug: string, side: string, inId: string, outId: string) {
  const row = await db.queryOneAsync<VoiceRow>(
    'SELECT lobby_channel_id, team_a_channel_id, team_b_channel_id FROM pickup_discord_voice WHERE match_slug = ?',
    [slug]
  );
  const token = await botToken();
  const guildId = await pickedGuildId();
  if (!row || !token || !guildId) return;
  const teamChannel = side === 'a' ? row.team_a_channel_id : row.team_b_channel_id;
  if (teamChannel) await move(token, guildId, [inId], teamChannel);
  await move(token, guildId, [outId], row.lobby_channel_id);
}

const MATCH_OVER = new Set(['match_ended', 'match_cancelled', 'match_failed']);

/** Follow a lobby change: split at the match's start, bring everyone back at its end. */
export async function followVoice(change: PickupChange): Promise<void> {
  for (const event of change.events) {
    const matchNo = event.data.matchNo;
    if (MATCH_OVER.has(event.type) && typeof matchNo === 'number') {
      await bringBack(matchSlugOf(change.lobby.id, matchNo));
    }
    const { playerId, outId, side } = event.data;
    const swapped = event.type === 'substituted' || event.type === 'substitution_undone';
    if (swapped && change.lobby.matchSlug && typeof playerId === 'string') {
      if (typeof outId !== 'string') continue;
      // Undone: the two change places again.
      const [incoming, leaving] =
        event.type === 'substituted' ? [playerId, outId] : [outId, playerId];
      const seat = change.lobby.players.find((p) => p.playerId === incoming)?.side ?? side;
      await followSubstitution(change.lobby.matchSlug, String(seat), incoming, leaving);
    }
  }
  for (const effect of change.effects) {
    if (effect.type === 'create_match' && change.lobby.matchSlug === effect.slug) {
      await splitTeams(effect.slug, change.lobby.matchNo);
    }
  }
}
