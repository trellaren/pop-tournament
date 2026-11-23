/**
 * Pickup moderation as pure functions (docs/design/pickup-lobby.md): how long
 * a ban may last, whether one holds, the balance multiplier's range, and
 * which of a player's display names is shown.
 */

/** A ban lasts an hour to thirty days, or until lifted (null). */
export const MIN_BAN_SECONDS = 60 * 60;
export const MAX_BAN_SECONDS = 30 * 24 * 60 * 60;
export const MAX_REASON_LENGTH = 200;

export interface Ban {
  playerId: string;
  /** When it ends (epoch seconds); null: until lifted. */
  until: number | null;
}

/** A ban holds while it has no end or its end is still ahead. */
export const banHolds = (ban: Ban | null, now: number): ban is Ban =>
  ban !== null && (ban.until === null || ban.until > now);

/** When a ban of this length ends; undefined when the length is not allowed. */
export function banUntil(lengthSeconds: number | null, now: number): number | null | undefined {
  if (lengthSeconds === null) return null;
  if (!Number.isInteger(lengthSeconds)) return undefined;
  if (lengthSeconds < MIN_BAN_SECONDS || lengthSeconds > MAX_BAN_SECONDS) return undefined;
  return now + lengthSeconds;
}

/** A reason as stored: trimmed, at most 200 characters, null when empty. */
export function cleanReason(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim().slice(0, MAX_REASON_LENGTH);
  return text === '' ? null : text;
}

/** The balance multiplier: a weight from 0.1 up to 1. */
export const MIN_MULTIPLIER = 0.1;
export const validMultiplier = (value: number): boolean =>
  Number.isFinite(value) && value >= MIN_MULTIPLIER && value <= 1;

export const MAX_DISPLAY_NAMES = 12;
export const MAX_NAME_LENGTH = 32;

/** Display names as stored: trimmed, without empties or repeats; null when the list is bad. */
export function cleanDisplayNames(names: readonly string[]): string[] | null {
  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (cleaned.length > MAX_DISPLAY_NAMES) return null;
  return cleaned.every((name) => name.length <= MAX_NAME_LENGTH) ? cleaned : null;
}

/**
 * Which of a player's display names is shown today: one of the list, the
 * same for everyone all day, another the next. Null when the list is empty.
 */
export function displayNameFor(
  names: readonly string[],
  playerId: string,
  now: number
): string | null {
  if (names.length === 0) return null;
  let seed = Math.floor(now / 86400);
  for (const char of playerId) seed = (seed * 31 + char.charCodeAt(0)) % 1_000_003;
  return names[seed % names.length];
}

/** Ratings as Balance teams and the draft weigh them: each times its player's multiplier. */
export function weighted(
  ratings: Readonly<Record<string, number>>,
  multipliers: ReadonlyMap<string, number>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, rating] of Object.entries(ratings)) {
    out[id] = Math.round(rating * (multipliers.get(id) ?? 1));
  }
  return out;
}
