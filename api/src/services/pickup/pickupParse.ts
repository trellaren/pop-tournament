/** The JSON columns of a pickup lobby, read back with care: settings, the draft, the map votes. */
import {
  DEFAULT_TEAM_SIZE,
  FORMATS,
  MAP_METHODS,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  ROLL_OUT_RULES,
  type Draft,
  type LobbySettings,
} from './rules';
import type { Untrusted } from '../../utils/untrusted';

export function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const parsed: Untrusted = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const fields: Record<string, Untrusted> = { ...parsed };
    const captains: Record<string, Untrusted> =
      typeof fields.captains === 'object' && fields.captains !== null ? { ...fields.captains } : {};
    if (typeof captains.a !== 'string' || typeof captains.b !== 'string') return null;
    const ratings: Record<string, number> = {};
    if (typeof fields.ratings === 'object' && fields.ratings !== null) {
      for (const [id, value] of Object.entries(fields.ratings)) {
        if (typeof value === 'number') ratings[id] = value;
      }
    }
    const picks = Number(fields.picks);
    return {
      captains: { a: captains.a, b: captains.b },
      picks: Number.isInteger(picks) && picks >= 0 ? picks : 0,
      ratings,
    };
  } catch {
    return null;
  }
}

/** Settings as stored; anything unreadable or out of range reads as its default. */
export function parseSettings(raw: string): LobbySettings {
  const settings: LobbySettings = {
    format: 'classic',
    teamSize: DEFAULT_TEAM_SIZE,
    rollOut: 'most_played',
    mapMethod: 'pick',
    poolId: null,
  };
  try {
    const parsed: Untrusted = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return settings;
    const fields: Record<string, Untrusted> = { ...parsed };
    settings.format = FORMATS.find((f) => f === fields.format) ?? settings.format;
    const size = Number(fields.teamSize);
    if (Number.isInteger(size) && size >= MIN_TEAM_SIZE && size <= MAX_TEAM_SIZE) {
      settings.teamSize = size;
    }
    settings.rollOut = ROLL_OUT_RULES.find((rule) => rule === fields.rollOut) ?? settings.rollOut;
    settings.mapMethod = MAP_METHODS.find((m) => m === fields.mapMethod) ?? settings.mapMethod;
    if (typeof fields.poolId === 'number' && Number.isInteger(fields.poolId)) {
      settings.poolId = fields.poolId;
    }
  } catch {
    // An unreadable value reads as the defaults.
  }
  return settings;
}

/** The running map vote: player id to map id. */
export function parseVotes(raw: string | null): Record<string, string> {
  const votes: Record<string, string> = {};
  if (!raw) return votes;
  try {
    const parsed: Untrusted = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return votes;
    for (const [id, map] of Object.entries(parsed)) {
      if (typeof map === 'string') votes[id] = map;
    }
  } catch {
    // Unreadable votes read as none.
  }
  return votes;
}
