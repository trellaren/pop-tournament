/**
 * The pickup lobby's panel message: one per open lobby, in the channel an
 * admin picked, rewritten as the lobby changes. Only this file writes it.
 */
import { db } from '../../../config/database';
import { log } from '../../../utils/logger';
import { discordIdOf } from '../../../services/notifyChannels';
import { PickupError, pickupService } from '../../../services/pickup/pickupService';
import type { PickupChange } from '../../../services/pickup/pickupBus';
import { turnOf } from '../../../services/pickup/rules';
import type { LobbyView } from '../../../services/pickup/pickupView';
import { botToken } from '../bot';
import { discordFetch } from '../rest';
import { panelMessage } from './panelText';
import { pickupDiscordSettings, siteUrl } from './settings';

/** A burst of changes is one edit, this long after the first. */
const WRITE_DELAY_MS = 1500;
/** The panel is read as nobody in particular: its buttons are the same for everyone. */
const NOBODY = { playerId: '', isAdmin: false };

const pending = new Map<string, NodeJS.Timeout>();
let writing: Promise<void> = Promise.resolve();

async function panelOf(lobbyId: string): Promise<{ channelId: string; messageId: string } | null> {
  const row = await db.queryOneAsync<{ channel_id: string; message_id: string }>(
    'SELECT channel_id, message_id FROM pickup_discord_panels WHERE lobby_id = ?',
    [lobbyId]
  );
  return row ? { channelId: row.channel_id, messageId: row.message_id } : null;
}

async function viewOf(lobbyId: string): Promise<LobbyView | null> {
  try {
    return await pickupService.view(lobbyId, NOBODY);
  } catch (error) {
    if (error instanceof PickupError) return null;
    throw error;
  }
}

async function write(lobbyId: string): Promise<void> {
  const token = await botToken();
  if (!token) return;
  const lobby = await viewOf(lobbyId);
  if (!lobby) return;
  const existing = await panelOf(lobbyId);
  const settings = await pickupDiscordSettings();
  const body = panelMessage(lobby, siteUrl(), { activity: settings.activity });

  if (existing) {
    const edited = await discordFetch(
      token,
      `/channels/${existing.channelId}/messages/${existing.messageId}`,
      { method: 'PATCH', body }
    );
    // 404: someone deleted the message; a new one is posted below while the lobby is open.
    if (edited.ok || edited.status !== 404) {
      if (!edited.ok) log.warn(`[Discord] Editing the pickup panel failed: ${edited.status}`);
      if (lobby.state === 'closed') {
        await db.runAsync('DELETE FROM pickup_discord_panels WHERE lobby_id = ?', [lobbyId]);
      }
      return;
    }
    await db.runAsync('DELETE FROM pickup_discord_panels WHERE lobby_id = ?', [lobbyId]);
  }
  if (lobby.state === 'closed') return;
  const { channelId } = settings;
  if (!channelId) return;
  const posted = await discordFetch(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body,
  });
  if (!posted.ok || typeof posted.body.id !== 'string') {
    log.warn(`[Discord] Posting the pickup panel failed: ${posted.status}`);
    return;
  }
  await db.runAsync(
    `INSERT INTO pickup_discord_panels (lobby_id, channel_id, message_id) VALUES (?, ?, ?)
     ON CONFLICT (lobby_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id`,
    [lobbyId, channelId, posted.body.id]
  );
}

/** Rewrite a lobby's panel soon; writes never overlap. */
export function schedulePanel(lobbyId: string): void {
  if (pending.has(lobbyId)) return;
  const timer = setTimeout(() => {
    pending.delete(lobbyId);
    writing = writing
      .then(() => write(lobbyId))
      .catch((error: unknown) => {
        log.warn('[Discord] Writing the pickup panel failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, WRITE_DELAY_MS);
  timer.unref();
  pending.set(lobbyId, timer);
}

export function stopPanels(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

/** Mention the seated players who have a Discord account, once, in the panel's channel. */
async function ping(lobbyId: string, playerIds: string[], text: string): Promise<void> {
  const token = await botToken();
  const { channelId } = await pickupDiscordSettings();
  const panel = await panelOf(lobbyId);
  const where = panel?.channelId ?? channelId;
  if (!token || !where) return;
  const users: string[] = [];
  for (const playerId of playerIds) {
    const discordId = await discordIdOf(playerId);
    if (discordId) users.push(discordId);
  }
  if (users.length === 0) return;
  const sent = await discordFetch(token, `/channels/${where}/messages`, {
    method: 'POST',
    body: {
      content: `${users.map((id) => `<@${id}>`).join(' ')} ${text}`.slice(0, 2000),
      allowed_mentions: { users: users.slice(0, 100) },
    },
  });
  if (!sent.ok) log.warn(`[Discord] A pickup ping failed: ${sent.status}`);
}

/** What the panel's channel is told when the lobby changes. */
export async function announce(change: PickupChange): Promise<void> {
  const seatedIds = (ready?: boolean) =>
    change.lobby.players
      .filter((p) => p.side !== null && (ready === undefined || p.ready === ready))
      .map((p) => p.playerId);
  const types = new Set(change.events.map((e) => e.type));
  if (types.has('ready_check') && change.lobby.state === 'ready_check') {
    await ping(change.lobby.id, seatedIds(false), 'Ready check: press **Ready** on the panel.');
  }
  if (types.has('match_starting') && change.lobby.matchSlug) {
    const where = `${siteUrl()}/match/${encodeURIComponent(change.lobby.matchSlug)}`;
    await ping(change.lobby.id, seatedIds(), `Your match is starting. Connect here: ${where}`);
  }
  const draft = change.lobby.draft;
  const picking = change.effects.some((e) => e.type === 'pick_timer');
  if (draft && picking) {
    const side = turnOf(change.lobby);
    if (side)
      await ping(
        change.lobby.id,
        [draft.captains[side]],
        'Your pick: choose a player on the panel.'
      );
  }
  const invited = change.events.flatMap((e) =>
    e.type === 'invited' && typeof e.data.playerId === 'string' ? [e.data.playerId] : []
  );
  if (invited.length > 0) {
    await ping(change.lobby.id, invited, 'You are invited to the lobby: join on the panel.');
  }
  const subbedIn = change.events.flatMap((e) =>
    e.type === 'substituted' && typeof e.data.playerId === 'string' ? [e.data.playerId] : []
  );
  if (subbedIn.length > 0 && change.lobby.matchSlug) {
    const where = `${siteUrl()}/match/${encodeURIComponent(change.lobby.matchSlug)}`;
    await ping(change.lobby.id, subbedIn, `You are coming into the match. Connect here: ${where}`);
  }
  const rolledIn = change.events.flatMap((e) =>
    e.type === 'rolled_in' && typeof e.data.playerId === 'string' ? [e.data.playerId] : []
  );
  if (rolledIn.length > 0) {
    await ping(change.lobby.id, rolledIn, 'You are in for the next match.');
  }
}
