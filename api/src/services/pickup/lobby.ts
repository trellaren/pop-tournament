/**
 * The pickup lobby as a value (docs/design/pickup-lobby.md): its shape, the
 * commands, and the small helpers the rules share. Pure: no database, clock
 * or randomness in here.
 */

export type Side = 'a' | 'b';
export const SIDES: readonly Side[] = ['a', 'b'];

export const MIN_TEAM_SIZE = 1;
export const MAX_TEAM_SIZE = 5;
export const DEFAULT_TEAM_SIZE = 5;
/** Classic is the full game; wingman is one bomb site, 1v1 or 2v2, at MR8. */
export type LobbyFormat = 'classic' | 'wingman';
export const FORMATS: readonly LobbyFormat[] = ['classic', 'wingman'];
export const WINGMAN_TEAM_SIZE = 2;
/** Everyone in a lobby, seated or waiting. */
export const MAX_LOBBY_PLAYERS = 40;
/** How long the seated players have to press Ready after Start. */
export const READY_SECONDS = 60;

export type LobbyState =
  | 'gathering'
  | 'drafting'
  | 'ready_check'
  | 'map_vote'
  | 'in_match'
  | 'closed';

/** How long the seated players have to vote for a map. */
export const VOTE_SECONDS = 30;

/**
 * How the map is chosen: the host's pick (or a random one), the platform's
 * veto between the two teams once the match exists, or a vote in the lobby.
 */
export type MapMethod = 'pick' | 'veto' | 'vote';
export const MAP_METHODS: readonly MapMethod[] = ['pick', 'veto', 'vote'];

/** How long a captain has for one pick. */
export const PICK_SECONDS = 30;

/** How the two captains of a draft are chosen. */
export type CaptainMethod = 'random' | 'rating' | 'host';
export const CAPTAIN_METHODS: readonly CaptainMethod[] = ['random', 'rating', 'host'];

/** A running captain draft. Whose turn it is follows from how many picks were made. */
export interface Draft {
  captains: Record<Side, string>;
  picks: number;
  /** Each player's rating when the draft began: a pick that times out takes the highest left. */
  ratings: Readonly<Record<string, number>>;
}

export interface LobbyPlayer {
  playerId: string;
  /** The side the player is seated on; null in the waiting room. */
  side: Side | null;
  joinedAt: number;
  /** Since when the player has been in the waiting room; null while seated. */
  waitingSince: number | null;
  /** Pressed Ready in the running ready check. */
  ready: boolean;
  /** Matches played in a row without going to the waiting room. */
  gamesInRow: number;
}

/** Who goes out after a match while others wait: those who played longest, or the losing team. */
export type RollOutRule = 'most_played' | 'losers';
export const ROLL_OUT_RULES: readonly RollOutRule[] = ['most_played', 'losers'];
/** A gathering lobby nobody has touched for this long closes. */
export const IDLE_SECONDS = 2 * 60 * 60;

/** Who can join: everyone, or only those the host invited. Never who can see. */
export type Visibility = 'open' | 'invite';
export const VISIBILITIES: readonly Visibility[] = ['open', 'invite'];
/** No more than this many people on a lobby's invite list. */
export const MAX_INVITES = 100;

export interface LobbySettings {
  format: LobbyFormat;
  visibility: Visibility;
  teamSize: number;
  rollOut: RollOutRule;
  mapMethod: MapMethod;
  /** The platform's map pool the lobby plays from; null: the default for the team size. */
  poolId: number | null;
}

/** A substitution: who went out, who came in, on which side. */
export interface FailedSubstitution {
  outId: string;
  inId: string;
  side: Side;
}

export interface Lobby {
  id: string;
  state: LobbyState;
  hostId: string;
  /** Goes up by one with every change. */
  version: number;
  settings: LobbySettings;
  teamsLocked: boolean;
  /** The map the host picked; null draws one from the pool at Start. */
  pickedMap: string | null;
  /** When the ready check ends (epoch seconds); null outside one. */
  deadline: number | null;
  /** How many matches the lobby has started. */
  matchNo: number;
  /** The running match; null outside one. */
  matchSlug: string | null;
  /** The running captain draft; null outside one. */
  draft: Draft | null;
  /** The running map vote: player id to map id. */
  votes: Readonly<Record<string, string>>;
  /** Who was substituted out of the running match: nobody comes back into the same match. */
  leavers: readonly string[];
  /** A substitution the match server did not take, until the host retries or undoes it. */
  subFailed: FailedSubstitution | null;
  /** Who may join while only the invited can; kept whatever the setting, and when they leave. */
  invited: readonly string[];
  players: LobbyPlayer[];
}

export interface Actor {
  playerId: string;
  isAdmin: boolean;
}

export type Command =
  | {
      type: 'join';
      side: Side | null;
      /** Came by an invite link that checked out. */ byLink?: boolean;
    }
  | { type: 'substitute'; outId: string; inId: string }
  | { type: 'substitution_action'; action: 'retry' | 'undo' }
  | { type: 'invite'; playerId: string }
  | { type: 'revoke_invite'; playerId: string }
  | { type: 'leave' }
  | { type: 'move'; playerId: string; side: Side | null }
  | { type: 'kick'; playerId: string }
  | { type: 'make_host'; playerId: string }
  | { type: 'scramble' }
  | { type: 'balance'; ratings: Readonly<Record<string, number>> }
  | { type: 'lock_teams'; locked: boolean }
  | {
      type: 'set_settings';
      format?: LobbyFormat;
      visibility?: Visibility;
      teamSize?: number;
      rollOut?: RollOutRule;
      mapMethod?: MapMethod;
      poolId?: number | null;
    }
  | { type: 'vote_map'; map: string }
  | { type: 'roll_out'; playerId: string }
  | { type: 'pick_map'; map: string | null }
  | {
      type: 'start_draft';
      method: CaptainMethod;
      ratings: Readonly<Record<string, number>>;
      captainA?: string;
      captainB?: string;
    }
  | { type: 'pick'; playerId: string }
  | { type: 'start' }
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'close' };

export type CommandType = Command['type'];

/** What the server itself reports to a lobby: a timer, or the match's fate. */
export type SystemCommand =
  | { type: 'ready_timeout'; deadline: number }
  | { type: 'pick_timeout'; deadline: number }
  | { type: 'vote_timeout'; deadline: number }
  | { type: 'match_ended'; slug: string; winner: Side | null }
  | { type: 'match_cancelled'; slug: string }
  | { type: 'match_failed'; slug: string }
  | { type: 'substitution_failed'; slug: string; outId: string; inId: string }
  | { type: 'idle_timeout' };

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
  | 'not_enough_players'
  | 'wrong_state'
  | 'in_match'
  | 'teams_not_full'
  | 'not_your_turn'
  | 'invalid_captains'
  | 'invite_only'
  | 'already_invited'
  | 'not_invited'
  | 'invite_limit'
  | 'not_on_roster'
  | 'not_eligible'
  | 'already_subbed_out';

export type EventData = Readonly<Record<string, string | number | boolean | null>>;

export interface LobbyEvent {
  type: string;
  actorId: string;
  data: EventData;
}

/** What the service does after the change is written. */
export type Effect =
  | { type: 'ready_timer'; deadline: number }
  | { type: 'pick_timer'; deadline: number }
  | { type: 'vote_timer'; deadline: number }
  | { type: 'create_match'; slug: string; veto: boolean }
  | { type: 'cancel_match'; slug: string }
  | { type: 'substitute'; slug: string; outId: string; inId: string; side: Side };

export type Outcome =
  | { ok: true; lobby: Lobby; events: LobbyEvent[]; effects: Effect[] }
  | { ok: false; code: RefusalCode };

export interface Context {
  /** Epoch seconds. */
  now: number;
  /** A number in [0, 1), as Math.random gives. */
  random: () => number;
  /** The version the command was drawn for, when the client sent one. */
  version?: number;
}

/** The actor on lines the server itself writes. */
export const SYSTEM_ACTOR = 'system';

export const refuse = (code: RefusalCode): Outcome => ({ ok: false, code });

export function done(lobby: Lobby, events: LobbyEvent[], effects: Effect[] = []): Outcome {
  return { ok: true, lobby: { ...lobby, version: lobby.version + 1 }, events, effects };
}

export function newLobby(id: string, hostId: string, now: number): Lobby {
  return {
    id,
    state: 'gathering',
    hostId,
    version: 1,
    settings: {
      format: 'classic',
      visibility: 'open',
      teamSize: DEFAULT_TEAM_SIZE,
      rollOut: 'most_played',
      mapMethod: 'pick',
      poolId: null,
    },
    teamsLocked: false,
    pickedMap: null,
    deadline: null,
    matchNo: 0,
    matchSlug: null,
    draft: null,
    votes: {},
    leavers: [],
    subFailed: null,
    invited: [],
    players: [
      {
        playerId: hostId,
        side: 'a',
        joinedAt: now,
        waitingSince: null,
        ready: false,
        gamesInRow: 0,
      },
    ],
  };
}

export const seated = (lobby: Lobby, side: Side): LobbyPlayer[] =>
  lobby.players.filter((p) => p.side === side);

export const allSeated = (lobby: Lobby): LobbyPlayer[] =>
  lobby.players.filter((p) => p.side !== null);

/** The waiting room, longest wait first. */
export function waiting(lobby: Lobby): LobbyPlayer[] {
  return lobby.players
    .filter((p) => p.side === null)
    .sort((x, y) => (x.waitingSince ?? 0) - (y.waitingSince ?? 0) || x.joinedAt - y.joinedAt);
}

export const hasRoom = (lobby: Lobby, side: Side): boolean =>
  seated(lobby, side).length < lobby.settings.teamSize;

export const teamsFull = (lobby: Lobby): boolean => SIDES.every((side) => !hasRoom(lobby, side));

export const mayManage = (lobby: Lobby, actor: Actor): boolean =>
  actor.isAdmin || actor.playerId === lobby.hostId;

export function withPlayer(lobby: Lobby, next: LobbyPlayer): Lobby {
  const others = lobby.players.filter((p) => p.playerId !== next.playerId);
  return { ...lobby, players: [...others, next] };
}

export function place(player: LobbyPlayer, side: Side | null, now: number): LobbyPlayer {
  return {
    ...player,
    side,
    waitingSince: side === null ? now : null,
    ready: false,
    // The count is of matches in a row: a turn in the waiting room starts it again.
    gamesInRow: side === null ? 0 : player.gamesInRow,
  };
}

/** Back to gathering: no ready check, no match, nobody marked ready. */
export function toGathering(lobby: Lobby): Lobby {
  return {
    ...lobby,
    state: 'gathering',
    deadline: null,
    matchSlug: null,
    draft: null,
    votes: {},
    leavers: [],
    subFailed: null,
    players: lobby.players.map((p) => (p.ready ? { ...p, ready: false } : p)),
  };
}

/** The slug of a lobby's nth match on the platform. */
export const matchSlugOf = (lobbyId: string, matchNo: number): string =>
  `pu-${lobbyId.slice(0, 8)}-${matchNo}`;
