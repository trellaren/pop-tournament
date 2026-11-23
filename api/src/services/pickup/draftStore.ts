/** A running draft as it is stored on its lobby: JSON in `pickup_lobbies.draft`. */
import type { Draft } from './rules';
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
