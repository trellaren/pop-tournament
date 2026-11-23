/**
 * The pickup lobby's rules (docs/design/pickup-lobby.md), as pure functions:
 * a lobby and a command in, the next lobby and what happened out, or a
 * refusal. No database, clock or randomness in here; the service passes them.
 */

export type Side = 'a' | 'b';
export const SIDES: readonly Side[] = ['a', 'b'];

export const MIN_TEAM_SIZE = 1;
export const MAX_TEAM_SIZE = 5;
export const DEFAULT_TEAM_SIZE = 5;
/** Everyone in a lobby, seated or waiting. */
export const MAX_LOBBY_PLAYERS = 40;

export type LobbyState = 'gathering' | 'closed';

export interface LobbyPlayer {
  playerId: string;
  /** The side the player is seated on; null in the waiting room. */
  side: Side | null;
  joinedAt: number;
  /** Since when the player has been in the waiting room; null while seated. */
  waitingSince: number | null;
}

export interface LobbySettings {
  teamSize: number;
}

export interface Lobby {
  id: string;
  state: LobbyState;
  hostId: string;
  /** Goes up by one with every change. */
  version: number;
  settings: LobbySettings;
  teamsLocked: boolean;
  players: LobbyPlayer[];
}

export interface Actor {
  playerId: string;
  isAdmin: boolean;
}

export type Command =
  | { type: 'join'; side: Side | null }
  | { type: 'leave' }
  | { type: 'move'; playerId: string; side: Side | null }
  | { type: 'kick'; playerId: string }
  | { type: 'make_host'; playerId: string }
  | { type: 'scramble' }
  | { type: 'balance'; ratings: Readonly<Record<string, number>> }
  | { type: 'lock_teams'; locked: boolean }
  | { type: 'set_settings'; teamSize: number }
  | { type: 'close' };

export type CommandType = Command['type'];

/** Commands that must name the version they were drawn for. */
const ONE_SHOT: ReadonlySet<CommandType> = new Set(['scramble', 'balance', 'close']);

export type RefusalCode =
  | 'closed'
  | 'stale'
  | 'not_allowed'
  | 'not_in_lobby'
  | 'side_full'
  | 'lobby_full'
  | 'teams_locked'
  | 'no_change'
  | 'invalid_settings'
  | 'team_size_below_seated'
  | 'not_enough_players';

export type EventData = Readonly<Record<string, string | number | boolean | null>>;

export interface LobbyEvent {
  type: string;
  actorId: string;
  data: EventData;
}

export type Outcome =
  | { ok: true; lobby: Lobby; events: LobbyEvent[] }
  | { ok: false; code: RefusalCode };

export interface Context {
  /** Epoch seconds. */
  now: number;
  /** A number in [0, 1), as Math.random gives. */
  random: () => number;
  /** The version the command was drawn for, when the client sent one. */
  version?: number;
}

const refuse = (code: RefusalCode): Outcome => ({ ok: false, code });

export function newLobby(id: string, hostId: string, now: number): Lobby {
  return {
    id,
    state: 'gathering',
    hostId,
    version: 1,
    settings: { teamSize: DEFAULT_TEAM_SIZE },
    teamsLocked: false,
    players: [{ playerId: hostId, side: 'a', joinedAt: now, waitingSince: null }],
  };
}

export const seated = (lobby: Lobby, side: Side): LobbyPlayer[] =>
  lobby.players.filter((p) => p.side === side);

/** The waiting room, longest wait first. */
export function waiting(lobby: Lobby): LobbyPlayer[] {
  return lobby.players
    .filter((p) => p.side === null)
    .sort((x, y) => (x.waitingSince ?? 0) - (y.waitingSince ?? 0) || x.joinedAt - y.joinedAt);
}

export const hasRoom = (lobby: Lobby, side: Side): boolean =>
  seated(lobby, side).length < lobby.settings.teamSize;

export const mayManage = (lobby: Lobby, actor: Actor): boolean =>
  actor.isAdmin || actor.playerId === lobby.hostId;

/** What the actor may do now; the page and the panel show buttons from this. */
export function allowed(lobby: Lobby, actor: Actor): Record<CommandType, boolean> {
  const open = lobby.state !== 'closed';
  const manage = open && mayManage(lobby, actor);
  const mine = lobby.players.find((p) => p.playerId === actor.playerId);
  const seatedCount = lobby.players.filter((p) => p.side !== null).length;
  return {
    join: open && (!mine || !lobby.teamsLocked || manage),
    leave: open && Boolean(mine),
    move: manage,
    kick: manage,
    make_host: manage,
    scramble: manage && seatedCount >= 2,
    balance: manage && seatedCount >= 2,
    lock_teams: manage,
    set_settings: manage,
    close: manage,
  };
}

function withPlayer(lobby: Lobby, next: LobbyPlayer): Lobby {
  const others = lobby.players.filter((p) => p.playerId !== next.playerId);
  return { ...lobby, players: [...others, next] };
}

function place(player: LobbyPlayer, side: Side | null, now: number): LobbyPlayer {
  return { ...player, side, waitingSince: side === null ? now : null };
}

function done(lobby: Lobby, events: LobbyEvent[]): Outcome {
  return { ok: true, lobby: { ...lobby, version: lobby.version + 1 }, events };
}

function join(lobby: Lobby, actor: Actor, side: Side | null, ctx: Context): Outcome {
  const mine = lobby.players.find((p) => p.playerId === actor.playerId);
  if (mine) {
    if (mine.side === side) return refuse('no_change');
    if (lobby.teamsLocked && !mayManage(lobby, actor)) return refuse('teams_locked');
  } else {
    if (lobby.players.length >= MAX_LOBBY_PLAYERS) return refuse('lobby_full');
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
  };
  return done(withPlayer(lobby, place(base, side, ctx.now)), [
    {
      type: mine ? 'moved' : 'joined',
      actorId: actor.playerId,
      data: { playerId: actor.playerId, side },
    },
  ]);
}

/** Take a player out. The host's place passes to whoever has been in longest; an empty lobby closes. */
function remove(lobby: Lobby, playerId: string, event: LobbyEvent): Outcome {
  const players = lobby.players.filter((p) => p.playerId !== playerId);
  const events = [event];
  if (players.length === 0) {
    events.push({ type: 'closed', actorId: event.actorId, data: { reason: 'empty' } });
    return done({ ...lobby, players, state: 'closed' }, events);
  }
  let hostId = lobby.hostId;
  if (hostId === playerId) {
    hostId = [...players].sort((x, y) => x.joinedAt - y.joinedAt)[0].playerId;
    events.push({ type: 'host_changed', actorId: event.actorId, data: { playerId: hostId } });
  }
  return done({ ...lobby, players, hostId }, events);
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

/** Fisher-Yates with the given randomness. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How many of `count` seated players go to each side: even, the odd one to Team A, within the team size. */
function sideSizes(count: number, teamSize: number): [number, number] {
  const a = Math.min(teamSize, Math.ceil(count / 2));
  return [a, count - a];
}

/**
 * The split of `ids` into two sides of the given sizes whose rating sums are
 * closest. Every split is tried: ten players are 252 of them. Ties keep the
 * first found, so the same input gives the same teams.
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
  return lobby.players
    .filter((p) => p.side !== null)
    .map((p) => p.playerId)
    .sort();
}

function scramble(lobby: Lobby, actor: Actor, ctx: Context): Outcome {
  const ids = seatedIds(lobby);
  if (ids.length < 2) return refuse('not_enough_players');
  const order = shuffled(ids, ctx.random);
  const [sizeA] = sideSizes(ids.length, lobby.settings.teamSize);
  return done(reseat(lobby, order.slice(0, sizeA), order.slice(sizeA)), [
    { type: 'scrambled', actorId: actor.playerId, data: {} },
  ]);
}

function balance(lobby: Lobby, actor: Actor, ratings: Readonly<Record<string, number>>): Outcome {
  const ids = seatedIds(lobby);
  if (ids.length < 2) return refuse('not_enough_players');
  const [sizeA] = sideSizes(ids.length, lobby.settings.teamSize);
  const split = balancedSplit(ids, ratings, sizeA);
  return done(reseat(lobby, split.a, split.b), [
    { type: 'balanced', actorId: actor.playerId, data: {} },
  ]);
}

function setSettings(lobby: Lobby, actor: Actor, teamSize: number): Outcome {
  if (!Number.isInteger(teamSize) || teamSize < MIN_TEAM_SIZE || teamSize > MAX_TEAM_SIZE) {
    return refuse('invalid_settings');
  }
  if (teamSize === lobby.settings.teamSize) return refuse('no_change');
  if (SIDES.some((side) => seated(lobby, side).length > teamSize)) {
    return refuse('team_size_below_seated');
  }
  return done({ ...lobby, settings: { ...lobby.settings, teamSize } }, [
    { type: 'settings_changed', actorId: actor.playerId, data: { teamSize } },
  ]);
}

/** Commands only the host and admins may send. */
const MANAGE_ONLY: ReadonlySet<CommandType> = new Set([
  'move',
  'kick',
  'make_host',
  'scramble',
  'balance',
  'lock_teams',
  'set_settings',
  'close',
]);

export function decide(lobby: Lobby, actor: Actor, command: Command, ctx: Context): Outcome {
  if (lobby.state === 'closed') return refuse('closed');
  if (ctx.version !== undefined && ctx.version !== lobby.version) return refuse('stale');
  if (ONE_SHOT.has(command.type) && ctx.version === undefined) return refuse('stale');
  if (MANAGE_ONLY.has(command.type) && !mayManage(lobby, actor)) return refuse('not_allowed');

  switch (command.type) {
    case 'join':
      return join(lobby, actor, command.side, ctx);
    case 'leave': {
      if (!lobby.players.some((p) => p.playerId === actor.playerId)) return refuse('not_in_lobby');
      return remove(lobby, actor.playerId, {
        type: 'left',
        actorId: actor.playerId,
        data: { playerId: actor.playerId },
      });
    }
    case 'move':
      return move(lobby, actor, command.playerId, command.side, ctx);
    case 'kick': {
      if (command.playerId === actor.playerId) return refuse('not_allowed');
      if (!lobby.players.some((p) => p.playerId === command.playerId)) {
        return refuse('not_in_lobby');
      }
      return remove(lobby, command.playerId, {
        type: 'kicked',
        actorId: actor.playerId,
        data: { playerId: command.playerId },
      });
    }
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
      return setSettings(lobby, actor, command.teamSize);
    case 'close':
      return done({ ...lobby, state: 'closed' }, [
        { type: 'closed', actorId: actor.playerId, data: { reason: 'closed' } },
      ]);
  }
}
