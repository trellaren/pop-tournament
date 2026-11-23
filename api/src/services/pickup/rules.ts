/**
 * The pickup lobby's rules (docs/design/pickup-lobby.md), as pure functions:
 * a lobby and a command in, the next lobby, what happened and what to do
 * next out, or a refusal. The service passes the clock and the randomness.
 */
import {
  MAX_LOBBY_PLAYERS,
  READY_SECONDS,
  SYSTEM_ACTOR,
  allSeated,
  done,
  hasRoom,
  mayManage,
  place,
  refuse,
  teamsFull,
  toGathering,
  withPlayer,
  type Actor,
  type Command,
  type CommandType,
  type Context,
  type Lobby,
  type LobbyEvent,
  type LobbyPlayer,
  type Outcome,
  type Side,
  type SystemCommand,
} from './lobby';
import { invite, mayEnter, revokeInvite, withInvited, withoutInvite } from './invites';
import { cancelDraft, isCaptain, pick, pickTimeout, startDraft, turnOf } from './draft';
import { launch, voteMap, voteTimeout } from './mapVote';
import { rollOutAfterMatch, rollOutByHand } from './rollout';
import { setSettings } from './settings';
import { substitute, substitutionAction, substitutionFailed, substitutes } from './substitution';
import { balance, scramble } from './teams';

export * from './lobby';
export { balancedSplit, shuffled } from './teams';
export { draftPool, sideOfPick, turnOf } from './draft';
export { voteWinner } from './mapVote';
export { isInvited, mayEnter } from './invites';
export { substitutes } from './substitution';

/** Commands that must name the version they were drawn for. */
const ONE_SHOT: ReadonlySet<CommandType> = new Set([
  'start_draft',
  'roll_out',
  'scramble',
  'balance',
  'start',
  'cancel',
  'close',
  'substitute',
  'substitution_action',
]);

/** Commands only the host and admins may send. */
const MANAGE_ONLY: ReadonlySet<CommandType> = new Set([
  'move',
  'kick',
  'make_host',
  'scramble',
  'balance',
  'lock_teams',
  'invite',
  'revoke_invite',
  'substitute',
  'substitution_action',
  'set_settings',
  'roll_out',
  'start_draft',
  'pick_map',
  'start',
  'cancel',
  'close',
]);

/** Commands that change the teams or the match to come: only while gathering. */
const GATHERING_ONLY: ReadonlySet<CommandType> = new Set([
  'move',
  'scramble',
  'balance',
  'set_settings',
  'roll_out',
  'start_draft',
  'pick_map',
  'start',
]);

/** The captain whose pick it is, if a draft is running. */
function turnCaptain(lobby: Lobby): string | null {
  const side = turnOf(lobby);
  return side && lobby.draft ? lobby.draft.captains[side] : null;
}

/** What the actor may do now; the page and the panel show buttons from this. */
export function allowed(lobby: Lobby, actor: Actor): Record<CommandType, boolean> {
  const open = lobby.state !== 'closed';
  const gathering = lobby.state === 'gathering';
  const manage = open && mayManage(lobby, actor);
  const mine = lobby.players.find((p) => p.playerId === actor.playerId);
  const seatedCount = allSeated(lobby).length;
  const playing = lobby.state === 'in_match' && Boolean(mine?.side);
  return {
    join:
      open && (mine ? gathering && (!lobby.teamsLocked || manage) : mayEnter(lobby, actor, false)),
    invite: manage,
    substitute: manage && !lobby.subFailed && substitutes(lobby).length > 0,
    substitution_action: manage && lobby.state === 'in_match' && lobby.subFailed !== null,
    revoke_invite: manage,
    leave: open && Boolean(mine) && !playing,
    move: manage && gathering,
    kick: manage,
    make_host: manage,
    scramble: manage && gathering && seatedCount >= 2,
    balance: manage && gathering && seatedCount >= 2,
    lock_teams: manage,
    set_settings: manage && gathering,
    roll_out: manage && gathering && seatedCount >= 1,
    pick_map: manage && gathering,
    start_draft: manage && gathering && lobby.players.length >= 2,
    pick: lobby.state === 'drafting' && turnCaptain(lobby) === actor.playerId,
    vote_map: lobby.state === 'map_vote' && Boolean(mine?.side),
    start: manage && gathering && teamsFull(lobby),
    ready: lobby.state === 'ready_check' && Boolean(mine?.side) && !mine?.ready,
    cancel: manage && lobby.state !== 'gathering',
    close: manage && lobby.state !== 'in_match',
  };
}

function join(
  lobby: Lobby,
  actor: Actor,
  side: Side | null,
  byLink: boolean,
  ctx: Context
): Outcome {
  const mine = lobby.players.find((p) => p.playerId === actor.playerId);
  const gathering = lobby.state === 'gathering';
  if (mine) {
    if (mine.side === side) return refuse('no_change');
    if (!gathering) return refuse('wrong_state');
    if (lobby.teamsLocked && !mayManage(lobby, actor)) return refuse('teams_locked');
  } else {
    if (!mayEnter(lobby, actor, byLink)) return refuse('invite_only');
    if (lobby.players.length >= MAX_LOBBY_PLAYERS) return refuse('lobby_full');
    if (side !== null && !gathering) return refuse('wrong_state');
    if (side !== null && lobby.teamsLocked && !mayManage(lobby, actor)) {
      return refuse('teams_locked');
    }
  }
  if (side !== null && !hasRoom(lobby, side)) return refuse('side_full');
  const base: LobbyPlayer = mine ?? {
    playerId: actor.playerId,
    side: null,
    joinedAt: ctx.now,
    waitingSince: ctx.now,
    ready: false,
    gamesInRow: 0,
  };
  // Whoever comes by a link goes on the list, so they can come back without it.
  const invited = !mine && byLink ? (withInvited(lobby, [actor.playerId]) ?? lobby.invited) : null;
  const entered = invited ? { ...lobby, invited } : lobby;
  return done(withPlayer(entered, place(base, side, ctx.now)), [
    {
      type: mine ? 'moved' : 'joined',
      actorId: actor.playerId,
      data: { playerId: actor.playerId, side },
    },
  ]);
}

/**
 * Take a player out. A seated player cannot go while their match runs, and
 * one going during the ready check ends it. The host's place passes to
 * whoever has been in longest; an empty lobby closes.
 */
function remove(lobby: Lobby, playerId: string, event: LobbyEvent): Outcome {
  const target = lobby.players.find((p) => p.playerId === playerId);
  if (!target) return refuse('not_in_lobby');
  if (target.side !== null && lobby.state === 'in_match') return refuse('in_match');
  const events = [event];
  let next = lobby;
  if (target.side !== null && (lobby.state === 'ready_check' || lobby.state === 'map_vote')) {
    next = toGathering(lobby);
    events.push({ type: 'start_cancelled', actorId: event.actorId, data: {} });
  }
  // A draft cannot go on without one of its captains.
  if (lobby.state === 'drafting' && isCaptain(lobby, playerId)) {
    const cancelled = cancelDraft(lobby, event.actorId);
    next = cancelled.lobby;
    events.push(cancelled.event);
  }
  const players = next.players.filter((p) => p.playerId !== playerId);
  if (players.length === 0) {
    events.push({ type: 'closed', actorId: event.actorId, data: { reason: 'empty' } });
    return done({ ...toGathering(next), players, state: 'closed' }, events);
  }
  let hostId = next.hostId;
  if (hostId === playerId) {
    hostId = [...players].sort((x, y) => x.joinedAt - y.joinedAt)[0].playerId;
    events.push({ type: 'host_changed', actorId: event.actorId, data: { playerId: hostId } });
  }
  return done({ ...next, players, hostId }, events);
}

function move(lobby: Lobby, actor: Actor, playerId: string, side: Side | null, ctx: Context) {
  const target = lobby.players.find((p) => p.playerId === playerId);
  if (!target) return refuse('not_in_lobby');
  if (target.side === side) return refuse('no_change');
  if (side !== null && !hasRoom(lobby, side)) return refuse('side_full');
  return done(withPlayer(lobby, place(target, side, ctx.now)), [
    { type: 'moved', actorId: actor.playerId, data: { playerId, side } },
  ]);
}

function markReady(lobby: Lobby, playerId: string, events: LobbyEvent[], ctx: Context): Outcome {
  const next: Lobby = {
    ...lobby,
    players: lobby.players.map((p) => (p.playerId === playerId ? { ...p, ready: true } : p)),
  };
  if (allSeated(next).every((p) => p.ready)) return launch(next, events, ctx);
  return done(next, events);
}

function start(lobby: Lobby, actor: Actor, ctx: Context): Outcome {
  if (!teamsFull(lobby)) return refuse('teams_not_full');
  const deadline = ctx.now + READY_SECONDS;
  const checking: Lobby = { ...lobby, state: 'ready_check', deadline };
  const events: LobbyEvent[] = [{ type: 'ready_check', actorId: actor.playerId, data: {} }];
  const starter = checking.players.find((p) => p.playerId === actor.playerId);
  // Whoever pressed Start is ready, when they play.
  const outcome = starter?.side
    ? markReady(checking, actor.playerId, events, ctx)
    : done(checking, events);
  if (outcome.ok && outcome.lobby.state === 'ready_check') {
    outcome.effects.push({ type: 'ready_timer', deadline });
  }
  return outcome;
}

function cancel(lobby: Lobby, actor: Actor): Outcome {
  if (lobby.state === 'drafting') {
    const cancelled = cancelDraft(lobby, actor.playerId);
    return done(cancelled.lobby, [cancelled.event]);
  }
  if (lobby.state === 'ready_check' || lobby.state === 'map_vote') {
    return done(toGathering(lobby), [
      { type: 'start_cancelled', actorId: actor.playerId, data: {} },
    ]);
  }
  if (lobby.state === 'in_match' && lobby.matchSlug) {
    return done(
      toGathering(lobby),
      [{ type: 'match_cancelled', actorId: actor.playerId, data: { matchNo: lobby.matchNo } }],
      [{ type: 'cancel_match', slug: lobby.matchSlug }]
    );
  }
  return refuse('wrong_state');
}

export function decide(lobby: Lobby, actor: Actor, command: Command, ctx: Context): Outcome {
  if (lobby.state === 'closed') return refuse('closed');
  if (ctx.version !== undefined && ctx.version !== lobby.version) return refuse('stale');
  if (ONE_SHOT.has(command.type) && ctx.version === undefined) return refuse('stale');
  if (MANAGE_ONLY.has(command.type) && !mayManage(lobby, actor)) return refuse('not_allowed');
  if (GATHERING_ONLY.has(command.type) && lobby.state !== 'gathering') {
    return refuse('wrong_state');
  }

  switch (command.type) {
    case 'join':
      return join(lobby, actor, command.side, command.byLink === true, ctx);
    case 'substitute':
      return substitute(lobby, actor, command.outId, command.inId, ctx);
    case 'substitution_action':
      return substitutionAction(lobby, actor, command.action, ctx);
    case 'invite':
      return invite(lobby, actor, command.playerId);
    case 'revoke_invite':
      return revokeInvite(lobby, actor, command.playerId);
    case 'leave':
      return remove(lobby, actor.playerId, {
        type: 'left',
        actorId: actor.playerId,
        data: { playerId: actor.playerId },
      });
    case 'move':
      return move(lobby, actor, command.playerId, command.side, ctx);
    case 'kick':
      if (command.playerId === actor.playerId) return refuse('not_allowed');
      // A kick takes the invite too, or the person walks straight back in.
      return remove(withoutInvite(lobby, command.playerId), command.playerId, {
        type: 'kicked',
        actorId: actor.playerId,
        data: { playerId: command.playerId },
      });
    case 'make_host': {
      if (!lobby.players.some((p) => p.playerId === command.playerId)) {
        return refuse('not_in_lobby');
      }
      if (command.playerId === lobby.hostId) return refuse('no_change');
      return done({ ...lobby, hostId: command.playerId }, [
        { type: 'host_changed', actorId: actor.playerId, data: { playerId: command.playerId } },
      ]);
    }
    case 'scramble':
      return scramble(lobby, actor, ctx);
    case 'balance':
      return balance(lobby, actor, command.ratings);
    case 'lock_teams': {
      if (command.locked === lobby.teamsLocked) return refuse('no_change');
      return done({ ...lobby, teamsLocked: command.locked }, [
        {
          type: command.locked ? 'teams_locked' : 'teams_unlocked',
          actorId: actor.playerId,
          data: {},
        },
      ]);
    }
    case 'set_settings':
      return setSettings(lobby, actor, command);
    case 'roll_out': {
      const rolled = rollOutByHand(lobby, command.playerId, actor.playerId, ctx.now);
      return rolled ? done(rolled.lobby, rolled.events) : refuse('not_in_lobby');
    }
    case 'pick_map': {
      if (command.map === lobby.pickedMap) return refuse('no_change');
      return done({ ...lobby, pickedMap: command.map }, [
        { type: 'map_picked', actorId: actor.playerId, data: { map: command.map } },
      ]);
    }
    case 'start_draft':
      return startDraft(lobby, actor, command, ctx);
    case 'pick':
      return pick(lobby, actor, command.playerId, ctx);
    case 'vote_map':
      return voteMap(lobby, actor, command.map, ctx);
    case 'start':
      return start(lobby, actor, ctx);
    case 'ready': {
      if (lobby.state !== 'ready_check') return refuse('wrong_state');
      const mine = lobby.players.find((p) => p.playerId === actor.playerId);
      if (!mine?.side) return refuse('not_in_lobby');
      if (mine.ready) return refuse('no_change');
      return markReady(lobby, actor.playerId, [], ctx);
    }
    case 'cancel':
      return cancel(lobby, actor);
    case 'close':
      if (lobby.state === 'in_match') return refuse('in_match');
      return done({ ...toGathering(lobby), state: 'closed' }, [
        { type: 'closed', actorId: actor.playerId, data: { reason: 'closed' } },
      ]);
  }
}

/** A report from the server itself. One that no longer fits the lobby is refused as stale. */
export function decideSystem(lobby: Lobby, command: SystemCommand, ctx: Context): Outcome {
  if (lobby.state === 'closed') return refuse('closed');
  if (command.type === 'ready_timeout') {
    if (lobby.state !== 'ready_check' || lobby.deadline !== command.deadline)
      return refuse('stale');
    if (ctx.now < command.deadline) return refuse('stale');
    const late = allSeated(lobby).filter((p) => !p.ready);
    const lateIds = new Set(late.map((p) => p.playerId));
    const next = toGathering({
      ...lobby,
      players: lobby.players.map((p) => (lateIds.has(p.playerId) ? place(p, null, ctx.now) : p)),
    });
    return done(next, [
      { type: 'ready_timed_out', actorId: SYSTEM_ACTOR, data: { count: late.length } },
    ]);
  }
  if (command.type === 'pick_timeout') return pickTimeout(lobby, command.deadline, ctx);
  if (command.type === 'vote_timeout') return voteTimeout(lobby, command.deadline, ctx);
  if (command.type === 'idle_timeout') {
    if (lobby.state !== 'gathering') return refuse('stale');
    return done({ ...lobby, state: 'closed' }, [
      { type: 'closed', actorId: SYSTEM_ACTOR, data: { reason: 'idle' } },
    ]);
  }
  if (command.type === 'substitution_failed') {
    return substitutionFailed(lobby, command.slug, command.outId, command.inId);
  }
  if (lobby.state !== 'in_match' || lobby.matchSlug !== command.slug) return refuse('stale');
  if (command.type === 'match_ended') {
    const ended: LobbyEvent = {
      type: 'match_ended',
      actorId: SYSTEM_ACTOR,
      data: { matchNo: lobby.matchNo, winner: command.winner },
    };
    const rolled = rollOutAfterMatch(toGathering(lobby), command.winner, ctx);
    return done(rolled.lobby, [ended, ...rolled.events]);
  }
  return done(toGathering(lobby), [
    { type: command.type, actorId: SYSTEM_ACTOR, data: { matchNo: lobby.matchNo } },
  ]);
}
