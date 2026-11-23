/**
 * The pickup lobby (docs/design/pickup-lobby.md): every change goes through
 * `command`, one at a time: read the lobby, run the rule, write the lobby and
 * its log lines in one transaction, then tell the pages.
 */
import { randomUUID } from 'crypto';
import { log } from '../../utils/logger';
import { emitTopic } from '../socketService';
import {
  IDLE_SECONDS,
  decide,
  decideSystem,
  mayManage,
  newLobby,
  type Actor,
  type CaptainMethod,
  type Command,
  type Lobby,
  type Effect,
  type Outcome,
  type RefusalCode,
  type Side,
  type SystemCommand,
} from './rules';
import { cancelPickupMatch, createPickupMatch, mapPoolFor, mapPools } from './pickupMatch';
import { emitPickupChange } from './pickupBus';
import { isKnownPlayer } from './pickupInvites';
import { inviteTokenFor, linkAdmits } from './pickupInviteLinks';
import { buildList, buildView, ratingsOf, type LobbySummary, type LobbyView } from './pickupView';
import {
  endPickupMatch,
  insertLobby,
  lobbyIdOfMatch,
  lobbyTouchedAt,
  loadMatchState,
  loadLobby,
  loadOpenLobbies,
  openLobbyIdOf,
  saveLobby,
} from './pickupStore';

/** The page topic: every pickup page re-reads when it is emitted. */
export const PICKUP_TOPIC = 'pickup';

export type PickupErrorCode =
  | RefusalCode
  | 'not_found'
  | 'lobby_exists'
  | 'in_other_lobby'
  | 'invalid_map'
  | 'unknown_player'
  | 'invite_link_invalid';

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
  wrong_state: 'That cannot be done right now',
  in_match: 'Not while the match is running',
  teams_not_full: 'Both teams must be full first',
  invalid_map: 'That map is not in the pool',
  not_your_turn: 'It is not your pick',
  invalid_captains: 'Choose two different players in the lobby as captains',
  not_found: 'No such lobby',
  lobby_exists: 'A lobby is already open',
  in_other_lobby: 'You are already in another lobby',
  invite_only: 'This lobby is for invited players only',
  already_invited: 'That player is already invited',
  not_invited: 'That player is not invited',
  invite_limit: 'The invite list is full',
  unknown_player: 'No such player on the site',
  invite_link_invalid: 'That invite link no longer works',
};

function refusal(code: PickupErrorCode): PickupError {
  if (code === 'not_found') return new PickupError(404, code, REFUSALS[code]);
  return new PickupError(code === 'not_allowed' ? 403 : 409, code, REFUSALS[code]);
}

/** A command as the API takes it: Balance's ratings are read here, never sent. */
export type CommandInput =
  | Exclude<Command, { type: 'balance' | 'start_draft' | 'join' }>
  | { type: 'join'; side: Side | null; /** An invite link's token. */ invite?: string }
  | { type: 'balance' }
  | { type: 'start_draft'; method: CaptainMethod; captainA?: string; captainB?: string };

/** How long a completed match may wait for its result before the lobby moves on without one. */
const RESULT_GRACE_SECONDS = 30;

function isUniqueViolation(error: Error): boolean {
  return 'code' in error && error.code === '23505';
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

  /** Open a lobby with the actor as its host, seated on Team A. */
  open(actor: Actor): Promise<string> {
    return this.locked(async () => {
      // An idle lobby closes here, so it cannot block a new one.
      await this.openLobbies();
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
      emitPickupChange({ lobby, events: [], effects: [] });
      emitTopic(PICKUP_TOPIC);
      return lobby.id;
    });
  }

  /** Apply one command to a lobby. `version` is the version the client drew its button for. */
  command(lobbyId: string, actor: Actor, input: CommandInput, version?: number): Promise<void> {
    return this.locked(async () => {
      const lobby = await this.current(lobbyId);
      if (!lobby) throw refusal('not_found');
      if (input.type === 'pick_map' && input.map !== null) {
        const pool = await mapPoolFor(lobby.settings.format, lobby.settings.poolId);
        if (!pool.some((m) => m.id === input.map)) throw refusal('invalid_map');
      }
      if (input.type === 'vote_map') {
        const pool = await mapPoolFor(lobby.settings.format, lobby.settings.poolId);
        if (!pool.some((m) => m.id === input.map)) throw refusal('invalid_map');
      }
      if (input.type === 'set_settings' && typeof input.poolId === 'number') {
        const pools = await mapPools();
        if (!pools.some((pool) => pool.id === input.poolId)) throw refusal('invalid_settings');
      }
      const inLobby = lobby.players.some((p) => p.playerId === actor.playerId);
      if (input.type === 'join' && !inLobby) {
        const other = await openLobbyIdOf(actor.playerId);
        if (other && other !== lobbyId) throw refusal('in_other_lobby');
      }
      if (input.type === 'invite' && !(await isKnownPlayer(input.playerId))) {
        throw refusal('unknown_player');
      }
      const now = this.clock();
      const command = await this.asCommand(lobby, input, now);
      const outcome = decide(lobby, actor, command, { now, random: this.random, version });
      if (!outcome.ok) {
        const badLink = outcome.code === 'invite_only' && input.type === 'join' && input.invite;
        throw refusal(badLink ? 'invite_link_invalid' : outcome.code);
      }
      await this.apply(lobby, outcome, now);
    });
  }

  /**
   * The command the rules take. Balance and the draft go by ratings, and a
   * join by its invite link: both are read here and never taken from a client.
   */
  private async asCommand(lobby: Lobby, input: CommandInput, now: number): Promise<Command> {
    if (input.type === 'join') {
      const byLink = input.invite !== undefined && linkAdmits(lobby, input.invite, now);
      return { type: 'join', side: input.side, byLink };
    }
    if (input.type === 'balance') {
      const seatedIds = lobby.players.filter((p) => p.side !== null).map((p) => p.playerId);
      return { type: 'balance', ratings: await ratingsOf(seatedIds) };
    }
    if (input.type === 'start_draft') {
      return { ...input, ratings: await ratingsOf(lobby.players.map((p) => p.playerId)) };
    }
    return input;
  }

  /** Write a decided change, tell the pages, then do what it asked for. */
  private async apply(
    before: Lobby,
    outcome: Extract<Outcome, { ok: true }>,
    now: number
  ): Promise<void> {
    await saveLobby(outcome.lobby, before.version, outcome.events, now);
    if (outcome.lobby.state === 'closed') log.info(`[PICKUP] lobby ${before.id} closed`);
    emitTopic(PICKUP_TOPIC);
    for (const effect of outcome.effects) await this.run(outcome.lobby, effect, now);
    emitPickupChange({ lobby: outcome.lobby, events: outcome.events, effects: outcome.effects });
  }

  private async run(lobby: Lobby, effect: Effect, now: number): Promise<void> {
    if (effect.type !== 'create_match' && effect.type !== 'cancel_match') {
      const wait = Math.max(0, effect.deadline - now) * 1000 + 500;
      setTimeout(() => void this.refresh(lobby.id), wait).unref();
      return;
    }
    if (effect.type === 'cancel_match') {
      await endPickupMatch(effect.slug, 'cancelled', now);
      try {
        await cancelPickupMatch(effect.slug);
      } catch (error) {
        log.error(`[PICKUP] could not cancel match ${effect.slug}`, error as Error);
      }
      return;
    }
    try {
      await createPickupMatch(lobby, effect.slug, now, effect.veto);
    } catch (error) {
      log.error(`[PICKUP] could not create match ${effect.slug}`, error as Error);
      await this.system(lobby, { type: 'match_failed', slug: effect.slug });
    }
  }

  /** Apply a report from the server itself; one that no longer fits is dropped. */
  private async system(lobby: Lobby, command: SystemCommand): Promise<Lobby> {
    const now = this.clock();
    const outcome = decideSystem(lobby, command, { now, random: this.random });
    if (!outcome.ok) return lobby;
    await this.apply(lobby, outcome, now);
    return outcome.lobby;
  }

  /**
   * The lobby as it stands now: a ready check that ran out is ended, and a
   * match that is over on the platform (ended, cancelled or deleted) is taken
   * off the lobby. Called under the lock.
   */
  private async current(lobbyId: string): Promise<Lobby | null> {
    const lobby = await loadLobby(lobbyId);
    if (!lobby) return null;
    if (lobby.state === 'gathering') {
      const touched = await lobbyTouchedAt(lobbyId);
      if (touched !== null && this.clock() - touched >= IDLE_SECONDS) {
        return this.system(lobby, { type: 'idle_timeout' });
      }
    }
    if (lobby.state === 'map_vote' && lobby.deadline !== null && this.clock() >= lobby.deadline) {
      return this.system(lobby, { type: 'vote_timeout', deadline: lobby.deadline });
    }
    if (lobby.state === 'drafting' && lobby.deadline !== null && this.clock() >= lobby.deadline) {
      // One pick per overdue deadline; the next pick gets its own timer.
      return this.system(lobby, { type: 'pick_timeout', deadline: lobby.deadline });
    }
    if (
      lobby.state === 'ready_check' &&
      lobby.deadline !== null &&
      this.clock() >= lobby.deadline
    ) {
      return this.system(lobby, { type: 'ready_timeout', deadline: lobby.deadline });
    }
    if (lobby.state === 'in_match' && lobby.matchSlug) {
      const match = await loadMatchState(lobby.matchSlug);
      // The row is written just after the lobby: a match with no row yet is still being made.
      if (match?.status === 'cancelled') {
        await endPickupMatch(lobby.matchSlug, 'cancelled', this.clock());
        return this.system(lobby, { type: 'match_cancelled', slug: lobby.matchSlug });
      }
      // The result normally arrives through applyMatchResult; this catches one that did not.
      const settled = (match?.completedAt ?? Infinity) <= this.clock() - RESULT_GRACE_SECONDS;
      if (match?.status === 'completed' && settled) {
        await endPickupMatch(lobby.matchSlug, 'draw', this.clock());
        return this.system(lobby, { type: 'match_ended', slug: lobby.matchSlug, winner: null });
      }
    }
    return lobby;
  }

  /** Bring a lobby up to date outside a command (a timer ran out). */
  private refresh(lobbyId: string): Promise<void> {
    return this.locked(async () => {
      await this.current(lobbyId);
    });
  }

  /**
   * A pickup match ended (core/matchLifecycle): the lobby goes back to
   * gathering with the same teams. A result that arrives twice counts once.
   */
  applyMatchResult(matchSlug: string, winner: 'team1' | 'team2' | 'none'): Promise<boolean> {
    return this.locked(async () => {
      const lobbyId = await lobbyIdOfMatch(matchSlug);
      const lobby = lobbyId ? await loadLobby(lobbyId) : null;
      if (!lobby) return false;
      const sides: Record<typeof winner, Side | null> = { team1: 'a', team2: 'b', none: null };
      const side = sides[winner];
      await endPickupMatch(matchSlug, side ?? 'draw', this.clock());
      const after = await this.system(lobby, {
        type: 'match_ended',
        slug: matchSlug,
        winner: side,
      });
      return after !== lobby;
    });
  }

  /** The lobbies still open once each is brought up to date (an idle one closes). */
  private async openLobbies(): Promise<Lobby[]> {
    const out: Lobby[] = [];
    for (const lobby of await loadOpenLobbies()) {
      const current = await this.current(lobby.id);
      if (current && current.state !== 'closed') out.push(current);
    }
    return out;
  }

  /** The open lobby, if one is: there is at most one. */
  async openLobbyId(): Promise<string | null> {
    const open = await this.locked(() => this.openLobbies());
    return open[0]?.id ?? null;
  }

  /** A new invite link's token for this lobby; only its host or an admin gets one. */
  async inviteToken(lobbyId: string, actor: Actor): Promise<string> {
    const lobby = await this.current(lobbyId);
    if (!lobby) throw refusal('not_found');
    if (lobby.state === 'closed') throw refusal('closed');
    if (!mayManage(lobby, actor)) throw refusal('not_allowed');
    return inviteTokenFor(lobby, actor, this.clock());
  }

  /** The lobby as one viewer sees it. */
  async view(lobbyId: string, viewer: Actor): Promise<LobbyView> {
    const lobby = await this.locked(() => this.current(lobbyId));
    if (!lobby) throw refusal('not_found');
    return buildView(lobby, viewer);
  }

  /** The open lobbies, and the one the viewer is in. */
  async list(viewer: Actor): Promise<{ lobbies: LobbySummary[]; mine: string | null }> {
    const open = await this.locked(() => this.openLobbies());
    return buildList(open, viewer);
  }
}

export const pickupService = new PickupService();
