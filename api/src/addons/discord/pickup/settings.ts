/** Where the pickup lobby lives in Discord: the panel's channel and the lobby voice channel. */
import { db } from '../../../config/database';

const PANEL_CHANNEL_KEY = 'pickup_discord_channel';
const VOICE_CHANNEL_KEY = 'pickup_discord_voice';

export interface PickupDiscordSettings {
  /** The text channel the panel is posted in; null: no panel. */
  channelId: string | null;
  /** The voice channel players gather in; null: nobody is moved. */
  voiceChannelId: string | null;
}

const idOrNull = (raw: string | null): string | null =>
  raw && /^\d{15,22}$/.test(raw) ? raw : null;

export async function pickupDiscordSettings(): Promise<PickupDiscordSettings> {
  return {
    channelId: idOrNull(await db.getAppSettingAsync(PANEL_CHANNEL_KEY)),
    voiceChannelId: idOrNull(await db.getAppSettingAsync(VOICE_CHANNEL_KEY)),
  };
}

export async function setPickupDiscordSettings(
  change: Partial<PickupDiscordSettings>
): Promise<PickupDiscordSettings> {
  if (change.channelId !== undefined) {
    await db.setAppSettingAsync(PANEL_CHANNEL_KEY, idOrNull(change.channelId));
  }
  if (change.voiceChannelId !== undefined) {
    await db.setAppSettingAsync(VOICE_CHANNEL_KEY, idOrNull(change.voiceChannelId));
  }
  return pickupDiscordSettings();
}

/** The site's address, for links in Discord. */
export const siteUrl = (): string =>
  (process.env.FRONTEND_BASE_URL ?? '').trim().replace(/\/+$/, '');
