/**
 * Roll-out (docs/design/pickup-lobby.md): after a match, while others wait,
 * players leave their seats for the waiting room and those who waited longest
 * take them. Pure.
 */
import {
  SYSTEM_ACTOR,
  allSeated,
  place,
  seated,
  waiting,
  type Lobby,
  type LobbyEvent,
  type LobbyPlayer,
  type Side,
} from './lobby';
import { shuffled } from './teams';

/** Seat the longest-waiting players on the seats `leavers` give up; the leavers go to the back of the waiting room. */
function swapOut(
  lobby: Lobby,
  leavers: readonly LobbyPlayer[],
  actorId: string,
  now: number
): { lobby: Lobby; events: LobbyEvent[] } {
  const incoming = waiting(lobby).slice(0, leavers.length);
  const sideOfIncoming = new Map<string, Side | null>();
  incoming.forEach((p, i) => sideOfIncoming.set(p.playerId, leavers[i].side));
  const leaving = new Set(leavers.map((p) => p.playerId));
  const events: LobbyEvent[] = [];
  for (const p of leavers) {
    events.push({ type: 'rolled_out', actorId, data: { playerId: p.playerId } });
  }
  for (const p of incoming) {
    events.push({
      type: 'rolled_in',
      actorId,
      data: { playerId: p.playerId, side: sideOfIncoming.get(p.playerId) ?? null },
    });
  }
  return {
    lobby: {
      ...lobby,
      players: lobby.players.map((p) => {
        if (leaving.has(p.playerId)) return place(p, null, now);
        const side = sideOfIncoming.get(p.playerId);
        return side ? place(p, side, now) : p;
      }),
    },
    events,
  };
}

/** Who leaves: the losing team first under that rule, else whoever has played most in a row; ties at random. */
function pickLeavers(
  lobby: Lobby,
  count: number,
  winner: Side | null,
  random: () => number
): LobbyPlayer[] {
  const byId = (x: LobbyPlayer, y: LobbyPlayer) => x.playerId.localeCompare(y.playerId);
  const mixed = shuffled([...allSeated(lobby)].sort(byId), random);
  if (lobby.settings.rollOut === 'losers' && winner !== null) {
    const losers = mixed.filter((p) => p.side !== winner);
    return losers.slice(0, count);
  }
  // A stable sort keeps the shuffled order among equals.
  return [...mixed].sort((x, y) => y.gamesInRow - x.gamesInRow).slice(0, count);
}

/**
 * A match ended: everyone who played has one more game in a row, then as many
 * players as are waiting (at most one team's worth) roll out and the longest
 * waiters roll in.
 */
export function rollOutAfterMatch(
  lobby: Lobby,
  winner: Side | null,
  ctx: { now: number; random: () => number }
): { lobby: Lobby; events: LobbyEvent[] } {
  const counted: Lobby = {
    ...lobby,
    players: lobby.players.map((p) =>
      p.side === null ? p : { ...p, gamesInRow: p.gamesInRow + 1 }
    ),
  };
  const count = Math.min(waiting(counted).length, counted.settings.teamSize);
  if (count === 0) return { lobby: counted, events: [] };
  const leavers = pickLeavers(counted, count, winner, ctx.random);
  return swapOut(counted, leavers, SYSTEM_ACTOR, ctx.now);
}

/** The host rolls one seated player out by hand; the longest waiter, if any, takes the seat. */
export function rollOutByHand(
  lobby: Lobby,
  playerId: string,
  actorId: string,
  now: number
): { lobby: Lobby; events: LobbyEvent[] } | null {
  const target = lobby.players.find((p) => p.playerId === playerId);
  if (target?.side == null) return null;
  return swapOut(lobby, [target], actorId, now);
}

/** How many would roll out if the running match ended now; the page says so. */
export function rollOutCount(lobby: Lobby): number {
  return Math.min(waiting(lobby).length, lobby.settings.teamSize, seated(lobby, 'a').length * 2);
}
