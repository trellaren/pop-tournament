/**
 * The pickup lobby (docs/design/pickup-lobby.md): every change goes through
 * `command`, one at a time: read the lobby, run the rule, write the lobby and
 * its log lines in one transaction, then tell the pages.
 */
import { randomUUID } from 'crypto';
import { log } from '../../utils/logger';
import { emitTopic } from '../socketService';
import { getGameRatings } from '../gameRatings';
import {
  allowed,
  decide,
  newLobby,
  seated,
  waiting,
  type Actor,
  type Command,
  type CommandType,
  type EventData,
  type Lobby,
  type LobbyPlayer,
  type LobbySettings,
  type RefusalCode,
  type Side,
} from './rules';
import {
  PICKUP_GAME,
  insertLobby,
  loadEvents,
  loadLobby,
  loadNames,
  loadOpenLobbies,
  openLobbyIdOf,
  saveLobby,
  type PlayerName,
} from './pickupStore';

/** The page topic: every pickup page re-reads when it is emitted. */
export const PICKUP_TOPIC = 'pickup';

export type PickupErrorCode = RefusalCode | 'not_found' | 'lobby_exists' | 'in_other_lobby';

export class PickupError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: PickupErrorCode | 'bad_request',
    message: string
  ) {
    super(message);
  }
}

const REFUSALS: Record<PickupErrorCode, string> = {
  closed: 'This lobby is closed',
  stale: 'The lobby changed; try again',
  not_allowed: 'Only the host or an admin can do that',
  not_in_lobby: 'That player is not in the lobby',
  side_full: 'That team is full',
  lobby_full: 'The lobby is full',
  teams_locked: 'The teams are locked',
  no_change: 'Nothing to change',
  invalid_settings: 'Those settings are not valid',
  team_size_below_seated: 'A team has more players than that team size',
  not_enough_players: 'Seat at least two players first',
  not_found: 'No such lobby',
  lobby_exists: 'A lobby is already open',
  in_other_lobby: 'You are already in another lobby',
};

function refusal(code: PickupErrorCode): PickupError {
  if (code === 'not_found') return new PickupError(404, code, REFUSALS[code]);
  return new PickupError(code === 'not_allowed' ? 403 : 409, code, REFUSALS[code]);
}

/** A command as the API takes it: Balance's ratings are read here, never sent. */
export type CommandInput = Exclude<Command, { type: 'balance' }> | { type: 'balance' };

export interface PlayerView {
  playerId: string;
  name: string;
  avatarUrl: string | null;
  /** The rating shown on the row and used by Balance teams. */
  rating: number | null;
  isHost: boolean;
}

export interface LogLine {
  id: number;
  type: string;
  at: number;
  actorId: string;
  actorName: string;
  /** The player the line is about, when it is about one. */
  playerName: string | null;
  data: EventData;
}

export interface LobbySummary {
  id: string;
  state: Lobby['state'];
  hostId: string;
  hostName: string;
  teamSize: number;
  teamsLocked: boolean;
  seated: number;
  waiting: number;
}

export interface LobbyView {
  id: string;
  state: Lobby['state'];
  version: number;
  hostId: string;
  teamsLocked: boolean;
  settings: LobbySettings;
  teams: Record<Side, PlayerView[]>;
  waiting: PlayerView[];
  log: LogLine[];
  /** Where the viewer is: a side, 'waiting', or null when not in the lobby. */
  me: Side | 'waiting' | null;
  can: Record<CommandType, boolean>;
}

const UNKNOWN_PLAYER = 'Unknown player';

function isUniqueViolation(error: Error): boolean {
  return 'code' in error && error.code === '23505';
}

function whereIs(lobby: Lobby, playerId: string): Side | 'waiting' | null {
  const mine = lobby.players.find((p) => p.playerId === playerId);
  if (!mine) return null;
  return mine.side ?? 'waiting';
}

export class PickupService {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
    private readonly random: () => number = Math.random
  ) {}

  /** Run `fn` after every change before it, so two commands never interleave. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async ratingsOf(playerIds: string[]): Promise<Record<string, number>> {
    const ratings = await getGameRatings(playerIds, PICKUP_GAME);
    const out: Record<string, number> = {};
    for (const [id, rating] of ratings) out[id] = rating.elo;
    return out;
  }

  /** Open a lobby with the actor as its host, seated on Team A. */
  open(actor: Actor): Promise<string> {
    return this.locked(async () => {
      if (await openLobbyIdOf(actor.playerId)) throw refusal('in_other_lobby');
      const now = this.clock();
      const lobby = newLobby(randomUUID(), actor.playerId, now);
      try {
        await insertLobby(
          lobby,
          [{ type: 'opened', actorId: actor.playerId, data: { playerId: actor.playerId } }],
          now
        );
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) throw refusal('lobby_exists');
        throw error;
      }
      log.info(`[PICKUP] lobby ${lobby.id} opened`);
      emitTopic(PICKUP_TOPIC);
      return lobby.id;
    });
  }

  /** Apply one command to a lobby. `version` is the version the client drew its button for. */
  command(lobbyId: string, actor: Actor, input: CommandInput, version?: number): Promise<void> {
    return this.locked(async () => {
      const lobby = await loadLobby(lobbyId);
      if (!lobby) throw refusal('not_found');
      const inLobby = lobby.players.some((p) => p.playerId === actor.playerId);
      if (input.type === 'join' && !inLobby) {
        const other = await openLobbyIdOf(actor.playerId);
        if (other && other !== lobbyId) throw refusal('in_other_lobby');
      }
      const command: Command =
        input.type === 'balance'
          ? {
              type: 'balance',
              ratings: await this.ratingsOf(
                lobby.players.filter((p) => p.side !== null).map((p) => p.playerId)
              ),
            }
          : input;
      const now = this.clock();
      const outcome = decide(lobby, actor, command, { now, random: this.random, version });
      if (!outcome.ok) throw refusal(outcome.code);
      await saveLobby(outcome.lobby, lobby.version, outcome.events, now);
      if (outcome.lobby.state === 'closed') log.info(`[PICKUP] lobby ${lobbyId} closed`);
      emitTopic(PICKUP_TOPIC);
    });
  }

  private playerView(
    player: LobbyPlayer,
    lobby: Lobby,
    names: Map<string, PlayerName>,
    ratings: Record<string, number>
  ): PlayerView {
    const known = names.get(player.playerId);
    return {
      playerId: player.playerId,
      name: known?.name ?? UNKNOWN_PLAYER,
      avatarUrl: known?.avatarUrl ?? null,
      rating: ratings[player.playerId] ?? null,
      isHost: player.playerId === lobby.hostId,
    };
  }

  /** The lobby as one viewer sees it. */
  async view(lobbyId: string, viewer: Actor): Promise<LobbyView> {
    const lobby = await loadLobby(lobbyId);
    if (!lobby) throw refusal('not_found');
    const events = await loadEvents(lobbyId);
    const ids = lobby.players.map((p) => p.playerId);
    const mentioned = events.flatMap((e) => {
      const about = e.data.playerId;
      return typeof about === 'string' ? [e.actorId, about] : [e.actorId];
    });
    const [names, ratings] = await Promise.all([
      loadNames([...ids, ...mentioned]),
      this.ratingsOf(ids),
    ]);
    const row = (p: LobbyPlayer) => this.playerView(p, lobby, names, ratings);
    const bySeat = (x: LobbyPlayer, y: LobbyPlayer) => x.joinedAt - y.joinedAt;
    return {
      id: lobby.id,
      state: lobby.state,
      version: lobby.version,
      hostId: lobby.hostId,
      teamsLocked: lobby.teamsLocked,
      settings: lobby.settings,
      teams: {
        a: seated(lobby, 'a').sort(bySeat).map(row),
        b: seated(lobby, 'b').sort(bySeat).map(row),
      },
      waiting: waiting(lobby).map(row),
      log: events.map((e) => {
        const about = e.data.playerId;
        return {
          id: e.id,
          type: e.type,
          at: e.at,
          actorId: e.actorId,
          actorName: names.get(e.actorId)?.name ?? UNKNOWN_PLAYER,
          playerName: typeof about === 'string' ? (names.get(about)?.name ?? UNKNOWN_PLAYER) : null,
          data: e.data,
        };
      }),
      me: whereIs(lobby, viewer.playerId),
      can: allowed(lobby, viewer),
    };
  }

  /** The open lobbies, and the one the viewer is in. */
  async list(viewer: Actor): Promise<{ lobbies: LobbySummary[]; mine: string | null }> {
    const lobbies = await loadOpenLobbies();
    const names = await loadNames(lobbies.map((l) => l.hostId));
    const mine = lobbies.find((l) => l.players.some((p) => p.playerId === viewer.playerId));
    return {
      mine: mine?.id ?? null,
      lobbies: lobbies.map((l) => ({
        id: l.id,
        state: l.state,
        hostId: l.hostId,
        hostName: names.get(l.hostId)?.name ?? UNKNOWN_PLAYER,
        teamSize: l.settings.teamSize,
        teamsLocked: l.teamsLocked,
        seated: l.players.filter((p) => p.side !== null).length,
        waiting: l.players.filter((p) => p.side === null).length,
      })),
    };
  }
}

export const pickupService = new PickupService();
