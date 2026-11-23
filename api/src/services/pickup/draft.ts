/**
 * The captain draft (docs/design/pickup-lobby.md): two captains pick in turn
 * from everyone else in the lobby, 1-2-2-2-1, with a timer per pick. Pure.
 */
import {
  PICK_SECONDS,
  SYSTEM_ACTOR,
  done,
  hasRoom,
  place,
  refuse,
  teamsFull,
  toGathering,
  type Actor,
  type CaptainMethod,
  type Context,
  type Lobby,
  type LobbyEvent,
  type LobbyPlayer,
  type Outcome,
  type Side,
} from './lobby';
import { shuffled } from './teams';

/** Whose pick the nth is (0-based): A, then B B, A A, B B… */
export function sideOfPick(n: number): Side {
  if (n === 0) return 'a';
  return Math.floor((n - 1) / 2) % 2 === 0 ? 'b' : 'a';
}

/** The side picking now. A side that is full passes to the other. */
export function turnOf(lobby: Lobby): Side | null {
  if (!lobby.draft) return null;
  const side = sideOfPick(lobby.draft.picks);
  if (hasRoom(lobby, side)) return side;
  const other: Side = side === 'a' ? 'b' : 'a';
  return hasRoom(lobby, other) ? other : null;
}

/** The players a captain can pick: everyone not seated, best rated first. */
export function draftPool(lobby: Lobby): LobbyPlayer[] {
  const rating = (p: LobbyPlayer) => lobby.draft?.ratings[p.playerId] ?? 0;
  return lobby.players
    .filter((p) => p.side === null)
    .sort((x, y) => rating(y) - rating(x) || x.playerId.localeCompare(y.playerId));
}

function captainsFor(
  lobby: Lobby,
  method: CaptainMethod,
  input: { ratings: Readonly<Record<string, number>>; captainA?: string; captainB?: string },
  random: () => number
): [string, string] | null {
  const ids = lobby.players.map((p) => p.playerId).sort();
  if (ids.length < 2) return null;
  if (method === 'host') {
    const { captainA, captainB } = input;
    if (!captainA || !captainB || captainA === captainB) return null;
    if (!ids.includes(captainA) || !ids.includes(captainB)) return null;
    return [captainA, captainB];
  }
  if (method === 'rating') {
    const best = [...ids].sort((x, y) => (input.ratings[y] ?? 0) - (input.ratings[x] ?? 0));
    // The lower rated of the two picks first.
    return [best[1], best[0]];
  }
  const mixed = shuffled(ids, random);
  return [mixed[0], mixed[1]];
}

/** With the draft over (teams full or nobody left), the lobby gathers with the teams locked. */
function settle(lobby: Lobby, events: LobbyEvent[], ctx: Context): Outcome {
  if (teamsFull(lobby) || draftPool(lobby).length === 0 || turnOf(lobby) === null) {
    events.push({ type: 'draft_finished', actorId: SYSTEM_ACTOR, data: {} });
    return done({ ...toGathering(lobby), teamsLocked: true }, events);
  }
  const deadline = ctx.now + PICK_SECONDS;
  return done({ ...lobby, deadline }, events, [{ type: 'pick_timer', deadline }]);
}

export function startDraft(
  lobby: Lobby,
  actor: Actor,
  command: {
    method: CaptainMethod;
    ratings: Readonly<Record<string, number>>;
    captainA?: string;
    captainB?: string;
  },
  ctx: Context
): Outcome {
  const captains = captainsFor(lobby, command.method, command, ctx.random);
  if (!captains)
    return refuse(command.method === 'host' ? 'invalid_captains' : 'not_enough_players');
  const [captainA, captainB] = captains;
  const sideOf = (id: string): Side | null => {
    if (id === captainA) return 'a';
    return id === captainB ? 'b' : null;
  };
  const drafting: Lobby = {
    ...lobby,
    state: 'drafting',
    teamsLocked: false,
    draft: { captains: { a: captainA, b: captainB }, picks: 0, ratings: command.ratings },
    // Everyone but the captains goes back into the pool, keeping their place in the waiting order.
    players: lobby.players.map((p) => {
      const side = sideOf(p.playerId);
      if (side) return { ...place(p, side, ctx.now), gamesInRow: p.gamesInRow };
      return p.side === null ? p : { ...place(p, null, ctx.now), gamesInRow: p.gamesInRow };
    }),
  };
  return settle(
    drafting,
    [
      {
        type: 'draft_started',
        actorId: actor.playerId,
        data: { captainA, captainB, method: command.method },
      },
    ],
    ctx
  );
}

function seat(lobby: Lobby, playerId: string, side: Side, actorId: string, ctx: Context): Outcome {
  if (!lobby.draft) return refuse('wrong_state');
  const target = lobby.players.find((p) => p.playerId === playerId);
  if (target?.side !== null) return refuse('not_in_lobby');
  const next: Lobby = {
    ...lobby,
    draft: { ...lobby.draft, picks: lobby.draft.picks + 1 },
    players: lobby.players.map((p) =>
      p.playerId === playerId ? { ...place(p, side, ctx.now), gamesInRow: p.gamesInRow } : p
    ),
  };
  return settle(next, [{ type: 'picked', actorId, data: { playerId, side } }], ctx);
}

/** A captain picks. Only the captain whose turn it is. */
export function pick(lobby: Lobby, actor: Actor, playerId: string, ctx: Context): Outcome {
  const side = turnOf(lobby);
  if (lobby.state !== 'drafting' || !lobby.draft || !side) return refuse('wrong_state');
  if (lobby.draft.captains[side] !== actor.playerId) return refuse('not_your_turn');
  return seat(lobby, playerId, side, actor.playerId, ctx);
}

/** The pick's time ran out: the best rated player left goes to the side whose turn it is. */
export function pickTimeout(lobby: Lobby, deadline: number, ctx: Context): Outcome {
  const side = turnOf(lobby);
  if (lobby.state !== 'drafting' || lobby.deadline !== deadline || !side) return refuse('stale');
  if (ctx.now < deadline) return refuse('stale');
  const [best] = draftPool(lobby);
  return seat(lobby, best.playerId, side, SYSTEM_ACTOR, ctx);
}

/** The draft stops where it is: the picks made stand, the rest stay unseated. */
export function cancelDraft(lobby: Lobby, actorId: string): { lobby: Lobby; event: LobbyEvent } {
  return {
    lobby: toGathering(lobby),
    event: { type: 'draft_cancelled', actorId, data: {} },
  };
}

export const isCaptain = (lobby: Lobby, playerId: string): boolean =>
  lobby.draft !== null &&
  (lobby.draft.captains.a === playerId || lobby.draft.captains.b === playerId);
