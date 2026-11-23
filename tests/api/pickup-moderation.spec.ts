import { test, expect } from '@playwright/test';
import {
  MAX_BAN_SECONDS,
  MIN_BAN_SECONDS,
  banHolds,
  banUntil,
  cleanDisplayNames,
  cleanReason,
  displayNameFor,
  validMultiplier,
  weighted,
} from '../../api/src/services/pickup/moderationRules';
import { balancedSplit } from '../../api/src/services/pickup/rules';

/**
 * Pickup moderation as pure functions (docs/design/pickup-lobby.md): how long
 * a ban lasts and whether it holds, the balance multiplier, display names.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const NOW = 1_800_000_000;

test.describe('pickup moderation (pure)', () => {
  test('a ban lasts an hour to thirty days, or until lifted', TAGS, () => {
    expect(banUntil(null, NOW)).toBeNull();
    expect(banUntil(MIN_BAN_SECONDS, NOW)).toBe(NOW + 3600);
    expect(banUntil(MAX_BAN_SECONDS, NOW)).toBe(NOW + 30 * 86400);
    expect(banUntil(MIN_BAN_SECONDS - 1, NOW)).toBeUndefined();
    expect(banUntil(MAX_BAN_SECONDS + 1, NOW)).toBeUndefined();
    expect(banUntil(3600.5, NOW)).toBeUndefined();
  });

  test('a ban holds until its end, and one with no end until lifted', TAGS, () => {
    expect(banHolds(null, NOW)).toBe(false);
    expect(banHolds({ playerId: '1', until: null }, NOW)).toBe(true);
    expect(banHolds({ playerId: '1', until: NOW + 1 }, NOW)).toBe(true);
    expect(banHolds({ playerId: '1', until: NOW }, NOW)).toBe(false);
  });

  test('a reason is trimmed, cut at 200 characters, and empty is none', TAGS, () => {
    expect(cleanReason('  griefing  ')).toBe('griefing');
    expect(cleanReason('   ')).toBeNull();
    expect(cleanReason(null)).toBeNull();
    expect(cleanReason('x'.repeat(500))).toHaveLength(200);
  });

  test('the multiplier is a weight from 0.1 to 1', TAGS, () => {
    expect(validMultiplier(1)).toBe(true);
    expect(validMultiplier(0.1)).toBe(true);
    expect(validMultiplier(0.05)).toBe(false);
    expect(validMultiplier(1.2)).toBe(false);
    expect(validMultiplier(Number.NaN)).toBe(false);
  });

  test('Balance teams weighs a rating by its multiplier', TAGS, () => {
    const ratings = { a: 2000, b: 1000, c: 1000, d: 1000 };
    expect(weighted(ratings, new Map())).toEqual(ratings);
    const adjusted = weighted(ratings, new Map([['a', 0.5]]));
    expect(adjusted).toEqual({ a: 1000, b: 1000, c: 1000, d: 1000 });
    // Unweighted, the strong player is balanced by two others; weighted, the split is even.
    const sum = (ids: string[], by: Record<string, number>) =>
      ids.reduce((total, id) => total + by[id], 0);
    const split = balancedSplit(['a', 'b', 'c', 'd'], adjusted, 2);
    expect(sum(split.a, adjusted)).toBe(sum(split.b, adjusted));
  });

  test('display names: cleaned, limited, and one a day per player', TAGS, () => {
    expect(cleanDisplayNames([' Scribbles ', 'Scrabble', 'Scrabble', ''])).toEqual([
      'Scribbles',
      'Scrabble',
    ]);
    expect(cleanDisplayNames(['x'.repeat(33)])).toBeNull();
    expect(cleanDisplayNames(Array.from({ length: 13 }, (_, i) => `n${i}`))).toBeNull();

    const names = ['Scribbles', 'Scrabble', 'Scruples'];
    expect(displayNameFor([], '7', NOW)).toBeNull();
    const today = displayNameFor(names, '7', NOW);
    expect(names).toContain(today);
    expect(displayNameFor(names, '7', NOW + 60)).toBe(today);
    const over = new Set(
      Array.from({ length: 30 }, (_, day) => displayNameFor(names, '7', NOW + day * 86400))
    );
    expect(over.size).toBeGreaterThan(1);
  });
});
