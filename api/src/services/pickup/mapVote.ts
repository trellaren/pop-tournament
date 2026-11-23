/**
 * The lobby's map vote and the step from "everyone is ready" to the match
 * (docs/design/pickup-lobby.md). Pure.
 */
import {
  SYSTEM_ACTOR,
  VOTE_SECONDS,
  allSeated,
  done,
  matchSlugOf,
  refuse,
  toGathering,
  type Actor,
  type Context,
  type Lobby,
  type LobbyEvent,
  type Outcome,
} from './lobby';

/** The match is made: by veto when the lobby asks for one, else on the map chosen (or drawn). */
function createMatch(lobby: Lobby, events: LobbyEvent[]): Outcome {
  const matchNo = lobby.matchNo + 1;
  const slug = matchSlugOf(lobby.id, matchNo);
  events.push({ type: 'match_starting', actorId: SYSTEM_ACTOR, data: { matchNo } });
  return done(
    {
      ...toGathering(lobby),
      // toGathering forgets the votes; the map they chose is kept.
      pickedMap: lobby.pickedMap,
      state: 'in_match',
      matchNo,
      matchSlug: slug,
    },
    events,
    [{ type: 'create_match', slug, veto: lobby.settings.mapMethod === 'veto' }]
  );
}

/** Everyone seated is ready: the map vote when the lobby votes, else the match. */
export function launch(lobby: Lobby, events: LobbyEvent[], ctx: Context): Outcome {
  if (lobby.settings.mapMethod !== 'vote') return createMatch(lobby, events);
  const deadline = ctx.now + VOTE_SECONDS;
  events.push({ type: 'map_vote', actorId: SYSTEM_ACTOR, data: {} });
  return done(
    {
      ...lobby,
      state: 'map_vote',
      deadline,
      votes: {},
      players: lobby.players.map((p) => (p.ready ? { ...p, ready: false } : p)),
    },
    events,
    [{ type: 'vote_timer', deadline }]
  );
}

/** The map with the most votes; a tie is drawn among the tied, in a stable order. */
export function voteWinner(
  votes: Readonly<Record<string, string>>,
  random: () => number
): string | null {
  const counts = new Map<string, number>();
  for (const map of Object.values(votes)) counts.set(map, (counts.get(map) ?? 0) + 1);
  if (counts.size === 0) return null;
  const most = Math.max(...counts.values());
  const top = [...counts.keys()].filter((map) => counts.get(map) === most).sort();
  return top[Math.floor(random() * top.length)];
}

/** Close the vote: the winner is the map (none voted: one is drawn when the match is made). */
function closeVote(lobby: Lobby, ctx: Context): Outcome {
  const map = voteWinner(lobby.votes, ctx.random);
  const events: LobbyEvent[] = [{ type: 'map_voted', actorId: SYSTEM_ACTOR, data: { map } }];
  return createMatch({ ...lobby, pickedMap: map }, events);
}

/** A seated player votes, or changes their vote. When everyone has voted the vote closes. */
export function voteMap(lobby: Lobby, actor: Actor, map: string, ctx: Context): Outcome {
  if (lobby.state !== 'map_vote') return refuse('wrong_state');
  const voters = allSeated(lobby).map((p) => p.playerId);
  if (!voters.includes(actor.playerId)) return refuse('not_in_lobby');
  if (lobby.votes[actor.playerId] === map) return refuse('no_change');
  const voted: Lobby = { ...lobby, votes: { ...lobby.votes, [actor.playerId]: map } };
  if (voters.every((id) => id in voted.votes)) return closeVote(voted, ctx);
  return done(voted, []);
}

export function voteTimeout(lobby: Lobby, deadline: number, ctx: Context): Outcome {
  if (lobby.state !== 'map_vote' || lobby.deadline !== deadline) return refuse('stale');
  if (ctx.now < deadline) return refuse('stale');
  return closeVote(lobby, ctx);
}
