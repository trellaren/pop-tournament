/**
 * Mid-match substitution (docs/design/pickup-lobby.md): the host or an admin
 * takes one player off the running match and puts someone from the waiting
 * room in their seat. Pure; the match server is told afterwards (the effect
 * `substitute`), and when it does not take the change the host retries or
 * undoes it.
 */
import {
  SYSTEM_ACTOR,
  done,
  place,
  refuse,
  type Actor,
  type Context,
  type Lobby,
  type LobbyPlayer,
  type Outcome,
} from './lobby';

/** Whether this is the lobby's running match. */
const running = (lobby: Lobby): lobby is Lobby & { matchSlug: string } =>
  lobby.state === 'in_match' && lobby.matchSlug !== null;

/** Who may come in: in the lobby, not playing, and not already out of this match. */
export function substitutes(lobby: Lobby): LobbyPlayer[] {
  if (!running(lobby)) return [];
  return lobby.players
    .filter((p) => p.side === null && !lobby.leavers.includes(p.playerId))
    .sort((x, y) => (x.waitingSince ?? 0) - (y.waitingSince ?? 0) || x.joinedAt - y.joinedAt);
}

function swapped(lobby: Lobby, outId: string, inId: string, now: number): LobbyPlayer[] | null {
  const out = lobby.players.find((p) => p.playerId === outId);
  const incoming = lobby.players.find((p) => p.playerId === inId);
  if (!out?.side || !incoming) return null;
  const { side } = out;
  return lobby.players.map((p) => {
    // The substitute takes the seat; the leaver goes to the back of the waiting room.
    if (p.playerId === inId) return { ...place(p, side, now), gamesInRow: 0 };
    if (p.playerId === outId) return place(p, null, now);
    return p;
  });
}

export function substitute(
  lobby: Lobby,
  actor: Actor,
  outId: string,
  inId: string,
  ctx: Context
): Outcome {
  if (!running(lobby) || lobby.subFailed) return refuse('wrong_state');
  const out = lobby.players.find((p) => p.playerId === outId);
  if (!out?.side) return refuse('not_on_roster');
  if (lobby.leavers.includes(inId)) return refuse('already_subbed_out');
  const incoming = lobby.players.find((p) => p.playerId === inId);
  // Someone not in the lobby has no row; someone seated has a side.
  if (incoming?.side !== null) return refuse('not_eligible');
  const players = swapped(lobby, outId, inId, ctx.now);
  if (!players) return refuse('not_eligible');
  const { side } = out;
  return done(
    { ...lobby, players, leavers: [...lobby.leavers, outId] },
    [
      {
        type: 'substituted',
        actorId: actor.playerId,
        data: { playerId: inId, outId, side, matchNo: lobby.matchNo },
      },
    ],
    [{ type: 'substitute', slug: lobby.matchSlug, outId, inId, side }]
  );
}

/** The match server did not take the substitution: the host decides what happens to it. */
export function substitutionFailed(lobby: Lobby, slug: string, outId: string, inId: string) {
  if (!running(lobby) || lobby.matchSlug !== slug || lobby.subFailed) return refuse('stale');
  const incoming = lobby.players.find((p) => p.playerId === inId);
  if (!incoming?.side || !lobby.leavers.includes(outId)) return refuse('stale');
  return done({ ...lobby, subFailed: { outId, inId, side: incoming.side } }, [
    { type: 'substitution_failed', actorId: SYSTEM_ACTOR, data: { playerId: inId, outId } },
  ]);
}

/** Retry sends the same change again; Undo puts both players back where they were. */
export function substitutionAction(
  lobby: Lobby,
  actor: Actor,
  action: 'retry' | 'undo',
  ctx: Context
): Outcome {
  const failed = lobby.subFailed;
  if (!running(lobby) || !failed) return refuse('wrong_state');
  const data = { playerId: failed.inId, outId: failed.outId };
  if (action === 'retry') {
    return done(
      { ...lobby, subFailed: null },
      [{ type: 'substitution_retried', actorId: actor.playerId, data }],
      [{ type: 'substitute', slug: lobby.matchSlug, ...failed }]
    );
  }
  // The server kept the old roster, so only the lobby goes back.
  const players = swapped(lobby, failed.inId, failed.outId, ctx.now);
  if (!players) return refuse('wrong_state');
  return done(
    {
      ...lobby,
      players,
      subFailed: null,
      leavers: lobby.leavers.filter((id) => id !== failed.outId),
    },
    [{ type: 'substitution_undone', actorId: actor.playerId, data }]
  );
}
