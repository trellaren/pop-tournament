/** Scramble and Balance teams: how the seated players are split over the two sides. Pure. */
import {
  allSeated,
  done,
  refuse,
  type Actor,
  type Context,
  type Lobby,
  type Outcome,
} from './lobby';
import type { Side } from './lobby';

/** Fisher-Yates with the given randomness. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How many of `count` seated players go to Team A: even, the odd one to Team A, within the team size. */
function sizeOfA(count: number, teamSize: number): number {
  return Math.min(teamSize, Math.ceil(count / 2));
}

/**
 * The split of `ids` into two sides whose rating sums are closest, Team A
 * getting `sizeA` players. Every split is tried: ten players are 252 of them.
 * Ties keep the first found, so the same input gives the same teams.
 */
export function balancedSplit(
  ids: readonly string[],
  ratings: Readonly<Record<string, number>>,
  sizeA: number
): { a: string[]; b: string[] } {
  const rating = (id: string) => ratings[id] ?? 0;
  const total = ids.reduce((sum, id) => sum + rating(id), 0);
  let best: string[] = ids.slice(0, sizeA);
  let bestGap = Number.POSITIVE_INFINITY;
  const pick = (start: number, chosen: string[], sum: number): void => {
    if (chosen.length === sizeA) {
      const gap = Math.abs(total - 2 * sum);
      if (gap < bestGap) {
        bestGap = gap;
        best = [...chosen];
      }
      return;
    }
    for (let i = start; i <= ids.length - (sizeA - chosen.length); i++) {
      chosen.push(ids[i]);
      pick(i + 1, chosen, sum + rating(ids[i]));
      chosen.pop();
    }
  };
  pick(0, [], 0);
  const inA = new Set(best);
  return { a: best, b: ids.filter((id) => !inA.has(id)) };
}

/** Seat the given players on the given sides; everyone else stays where they are. */
function reseat(lobby: Lobby, a: readonly string[], b: readonly string[]): Lobby {
  const sideOf = new Map<string, Side>();
  for (const id of a) sideOf.set(id, 'a');
  for (const id of b) sideOf.set(id, 'b');
  return {
    ...lobby,
    players: lobby.players.map((p) => {
      const side = sideOf.get(p.playerId);
      return side ? { ...p, side, waitingSince: null } : p;
    }),
  };
}

/** The seated players in a stable order, so a result depends only on the lobby and the randomness. */
function seatedIds(lobby: Lobby): string[] {
  return allSeated(lobby)
    .map((p) => p.playerId)
    .sort();
}

export function scramble(lobby: Lobby, actor: Actor, ctx: Context): Outcome {
  const ids = seatedIds(lobby);
  if (ids.length < 2) return refuse('not_enough_players');
  const order = shuffled(ids, ctx.random);
  const sizeA = sizeOfA(ids.length, lobby.settings.teamSize);
  return done(reseat(lobby, order.slice(0, sizeA), order.slice(sizeA)), [
    { type: 'scrambled', actorId: actor.playerId, data: {} },
  ]);
}

export function balance(
  lobby: Lobby,
  actor: Actor,
  ratings: Readonly<Record<string, number>>
): Outcome {
  const ids = seatedIds(lobby);
  if (ids.length < 2) return refuse('not_enough_players');
  const split = balancedSplit(ids, ratings, sizeOfA(ids.length, lobby.settings.teamSize));
  return done(reseat(lobby, split.a, split.b), [
    { type: 'balanced', actorId: actor.playerId, data: {} },
  ]);
}
