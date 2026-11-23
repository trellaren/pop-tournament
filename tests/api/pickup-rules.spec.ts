import { test, expect } from '@playwright/test';
import {
  allowed,
  balancedSplit,
  decide,
  decideSystem,
  newLobby,
  seated,
  shuffled,
  waiting,
  READY_SECONDS,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
  type Side,
} from '../../api/src/services/pickup/rules';

/**
 * The pickup lobby's rules (docs/design/pickup-lobby.md), as pure functions:
 * no server needed.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };

const HOST: Actor = { playerId: 'host', isAdmin: false };
const player = (playerId: string): Actor => ({ playerId, isAdmin: false });

/** Apply commands in order; each must be accepted. */
function run(lobby: Lobby, steps: Array<[Actor, Command, number?]>): Lobby {
  let current = lobby;
  let now = 100;
  for (const [actor, command] of steps) {
    now += 1;
    const outcome = decide(current, actor, command, {
      now,
      random: () => 0.5,
      version: current.version,
    });
    if (!outcome.ok) throw new Error(`${command.type} refused: ${outcome.code}`);
    current = outcome.lobby;
  }
  return current;
}

function attempt(lobby: Lobby, actor: Actor, command: Command, version?: number): Outcome {
  return decide(lobby, actor, command, { now: 500, random: () => 0.5, version });
}

const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);
const ids = (lobby: Lobby, side: Side) =>
  seated(lobby, side)
    .map((p) => p.playerId)
    .sort();

/** A lobby with `count` players seated, filling Team A first. */
function filled(count: number): Lobby {
  const steps: Array<[Actor, Command]> = [];
  for (let i = 1; i < count; i++) {
    steps.push([player(`p${i}`), { type: 'join', side: i < 5 ? 'a' : 'b' }]);
  }
  return run(newLobby('l', 'host', 100), steps);
}

test.describe('pickup rules (pure)', () => {
  test('a new lobby seats its host on Team A at version 1', TAGS, () => {
    const lobby = newLobby('l', 'host', 100);
    expect(lobby.version).toBe(1);
    expect(ids(lobby, 'a')).toEqual(['host']);
    expect(lobby.state).toBe('gathering');
  });

  test('joining a side, switching and the waiting room', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [[player('p1'), { type: 'join', side: 'b' }]]);
    expect(ids(lobby, 'b')).toEqual(['p1']);
    expect(lobby.version).toBe(2);
    lobby = run(lobby, [[player('p1'), { type: 'join', side: null }]]);
    expect(waiting(lobby).map((p) => p.playerId)).toEqual(['p1']);
    expect(codeOf(attempt(lobby, player('p1'), { type: 'join', side: null }))).toBe('no_change');
  });

  test('a full side refuses, and the waiting room is longest wait first', TAGS, () => {
    let lobby = filled(5);
    expect(codeOf(attempt(lobby, player('late'), { type: 'join', side: 'a' }))).toBe('side_full');
    lobby = run(lobby, [
      [player('w1'), { type: 'join', side: null }],
      [player('w2'), { type: 'join', side: null }],
    ]);
    expect(waiting(lobby).map((p) => p.playerId)).toEqual(['w1', 'w2']);
  });

  test('locked teams: players cannot seat themselves, the host still moves them', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [
      [player('p1'), { type: 'join', side: 'b' }],
      [HOST, { type: 'lock_teams', locked: true }],
    ]);
    expect(codeOf(attempt(lobby, player('p1'), { type: 'join', side: 'a' }))).toBe('teams_locked');
    expect(codeOf(attempt(lobby, player('new'), { type: 'join', side: 'a' }))).toBe('teams_locked');
    lobby = run(lobby, [
      [player('new'), { type: 'join', side: null }],
      [HOST, { type: 'move', playerId: 'new', side: 'a' }],
    ]);
    expect(ids(lobby, 'a')).toEqual(['host', 'new']);
  });

  test("the host's commands are refused for anyone else, and allowed for an admin", TAGS, () => {
    const lobby = run(newLobby('l', 'host', 100), [[player('p1'), { type: 'join', side: 'b' }]]);
    const commands: Command[] = [
      { type: 'move', playerId: 'host', side: null },
      { type: 'kick', playerId: 'host' },
      { type: 'make_host', playerId: 'p1' },
      { type: 'scramble' },
      { type: 'balance', ratings: {} },
      { type: 'lock_teams', locked: true },
      { type: 'set_settings', teamSize: 2 },
      { type: 'close' },
    ];
    for (const command of commands) {
      expect(codeOf(attempt(lobby, player('p1'), command, lobby.version))).toBe('not_allowed');
    }
    const admin: Actor = { playerId: 'admin', isAdmin: true };
    expect(codeOf(attempt(lobby, admin, { type: 'close' }, lobby.version))).toBe('ok');
    expect(allowed(lobby, player('p1')).close).toBe(false);
    expect(allowed(lobby, HOST).close).toBe(true);
  });

  test('one-shot commands need the current version', TAGS, () => {
    const lobby = filled(4);
    expect(codeOf(attempt(lobby, HOST, { type: 'scramble' }))).toBe('stale');
    expect(codeOf(attempt(lobby, HOST, { type: 'close' }, lobby.version - 1))).toBe('stale');
    expect(codeOf(attempt(lobby, HOST, { type: 'close' }, lobby.version))).toBe('ok');
  });

  test('the host leaving passes the lobby on; the last one leaving closes it', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [
      [player('p1'), { type: 'join', side: 'b' }],
      [player('p2'), { type: 'join', side: null }],
      [HOST, { type: 'leave' }],
    ]);
    expect(lobby.hostId).toBe('p1');
    lobby = run(lobby, [
      [player('p1'), { type: 'leave' }],
      [player('p2'), { type: 'leave' }],
    ]);
    expect(lobby.state).toBe('closed');
    expect(codeOf(attempt(lobby, player('p3'), { type: 'join', side: 'a' }))).toBe('closed');
  });

  test('kick and make host', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [[player('p1'), { type: 'join', side: 'b' }]]);
    expect(codeOf(attempt(lobby, HOST, { type: 'kick', playerId: 'host' }))).toBe('not_allowed');
    expect(codeOf(attempt(lobby, HOST, { type: 'kick', playerId: 'nobody' }))).toBe('not_in_lobby');
    lobby = run(lobby, [[HOST, { type: 'make_host', playerId: 'p1' }]]);
    expect(lobby.hostId).toBe('p1');
    lobby = run(lobby, [[player('p1'), { type: 'kick', playerId: 'host' }]]);
    expect(lobby.players.map((p) => p.playerId)).toEqual(['p1']);
  });

  test('scramble keeps everyone seated, evenly, and leaves the waiting room alone', TAGS, () => {
    let lobby = run(filled(7), [[player('w'), { type: 'join', side: null }]]);
    const before = [...ids(lobby, 'a'), ...ids(lobby, 'b')].sort();
    lobby = run(lobby, [[HOST, { type: 'scramble' }]]);
    expect([...ids(lobby, 'a'), ...ids(lobby, 'b')].sort()).toEqual(before);
    expect(ids(lobby, 'a')).toHaveLength(4);
    expect(ids(lobby, 'b')).toHaveLength(3);
    expect(waiting(lobby).map((p) => p.playerId)).toEqual(['w']);
    expect(codeOf(attempt(newLobby('x', 'host', 1), HOST, { type: 'scramble' }, 1))).toBe(
      'not_enough_players'
    );
  });

  test('shuffled is a permutation driven by the randomness given', TAGS, () => {
    const items = ['a', 'b', 'c', 'd'];
    expect(shuffled(items, () => 0.999)).toEqual(items);
    expect([...shuffled(items, () => 0)].sort()).toEqual(items);
  });

  test('balanced split: the smallest gap in total rating', TAGS, () => {
    const ratings = { a: 2000, b: 1900, c: 1500, d: 1400, e: 1000, f: 900 };
    const split = balancedSplit(Object.keys(ratings), ratings, 3);
    const sum = (list: string[]) =>
      list.reduce((total, id) => total + ratings[id as keyof typeof ratings], 0);
    expect(split.a).toHaveLength(3);
    expect(split.b).toHaveLength(3);
    expect(Math.abs(sum(split.a) - sum(split.b))).toBe(100);
  });

  test('balance seats the split and puts the odd player on Team A', TAGS, () => {
    const lobby = filled(5);
    const ratings = { host: 3000, p1: 1000, p2: 1000, p3: 1000, p4: 1000 };
    const outcome = attempt(lobby, HOST, { type: 'balance', ratings }, lobby.version);
    if (!outcome.ok) throw new Error(outcome.code);
    expect(ids(outcome.lobby, 'a')).toHaveLength(3);
    expect(ids(outcome.lobby, 'b')).toHaveLength(2);
    expect(ids(outcome.lobby, 'b')).toContain('host');
  });

  test('team size: 1 to 5, never below the players already seated', TAGS, () => {
    const lobby = filled(5);
    expect(codeOf(attempt(lobby, HOST, { type: 'set_settings', teamSize: 6 }))).toBe(
      'invalid_settings'
    );
    expect(codeOf(attempt(lobby, HOST, { type: 'set_settings', teamSize: 2 }))).toBe(
      'team_size_below_seated'
    );
    expect(codeOf(attempt(lobby, HOST, { type: 'set_settings', teamSize: 5 }))).toBe('no_change');
    const small = run(newLobby('l', 'host', 100), [[HOST, { type: 'set_settings', teamSize: 2 }]]);
    expect(small.settings.teamSize).toBe(2);
  });
});

/** A full 1v1 lobby: the host on Team A, p1 on Team B. */
function duel(): Lobby {
  return run(newLobby('lobby-0001', 'host', 100), [
    [HOST, { type: 'set_settings', teamSize: 1 }],
    [player('p1'), { type: 'join', side: 'b' }],
  ]);
}

function accepted(outcome: Outcome): Extract<Outcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome;
}

test.describe('pickup rules: start and the match (pure)', () => {
  test('Start needs full teams and begins the ready check with the starter ready', TAGS, () => {
    const short = newLobby('l', 'host', 100);
    expect(codeOf(attempt(short, HOST, { type: 'start' }, short.version))).toBe('teams_not_full');
    const outcome = accepted(attempt(duel(), HOST, { type: 'start' }, duel().version));
    expect(outcome.lobby.state).toBe('ready_check');
    expect(outcome.lobby.deadline).toBe(500 + READY_SECONDS);
    expect(outcome.lobby.players.find((p) => p.playerId === 'host')?.ready).toBe(true);
    expect(outcome.effects).toEqual([{ type: 'ready_timer', deadline: 500 + READY_SECONDS }]);
  });

  test('everyone ready starts the match, with its slug and number', TAGS, () => {
    const checking = run(duel(), [[HOST, { type: 'start' }]]);
    expect(codeOf(attempt(checking, HOST, { type: 'ready' }))).toBe('no_change');
    expect(codeOf(attempt(checking, player('nobody'), { type: 'ready' }))).toBe('not_in_lobby');
    const outcome = accepted(attempt(checking, player('p1'), { type: 'ready' }));
    expect(outcome.lobby.state).toBe('in_match');
    expect(outcome.lobby.matchNo).toBe(1);
    expect(outcome.lobby.matchSlug).toBe('pu-lobby-00-1');
    expect(outcome.lobby.players.every((p) => !p.ready)).toBe(true);
    expect(outcome.effects).toEqual([{ type: 'create_match', slug: 'pu-lobby-00-1' }]);
  });

  test('the ready check: teams are frozen, a seated player leaving ends it', TAGS, () => {
    const checking = run(duel(), [[HOST, { type: 'start' }]]);
    expect(codeOf(attempt(checking, HOST, { type: 'scramble' }, checking.version))).toBe(
      'wrong_state'
    );
    expect(codeOf(attempt(checking, player('p1'), { type: 'join', side: null }))).toBe(
      'wrong_state'
    );
    expect(codeOf(attempt(checking, player('late'), { type: 'join', side: null }))).toBe('ok');
    const left = accepted(attempt(checking, player('p1'), { type: 'leave' }));
    expect(left.lobby.state).toBe('gathering');
    expect(left.lobby.deadline).toBeNull();
    expect(left.events.map((e) => e.type)).toEqual(['left', 'start_cancelled']);
  });

  test('the ready check running out moves those not ready to the waiting room', TAGS, () => {
    const checking = run(duel(), [[HOST, { type: 'start' }]]);
    const deadline = checking.deadline ?? 0;
    const context = { now: deadline, random: () => 0.5 };
    const early = decideSystem(
      checking,
      { type: 'ready_timeout', deadline },
      { ...context, now: 1 }
    );
    expect(codeOf(early)).toBe('stale');
    const outcome = accepted(decideSystem(checking, { type: 'ready_timeout', deadline }, context));
    expect(outcome.lobby.state).toBe('gathering');
    expect(waiting(outcome.lobby).map((p) => p.playerId)).toEqual(['p1']);
    expect(ids(outcome.lobby, 'a')).toEqual(['host']);
  });

  test('during the match: nobody seated leaves, no close; Cancel stops it', TAGS, () => {
    const playing = run(duel(), [
      [HOST, { type: 'start' }],
      [player('p1'), { type: 'ready' }],
    ]);
    expect(codeOf(attempt(playing, player('p1'), { type: 'leave' }))).toBe('in_match');
    expect(codeOf(attempt(playing, HOST, { type: 'kick', playerId: 'p1' }))).toBe('in_match');
    expect(codeOf(attempt(playing, HOST, { type: 'close' }, playing.version))).toBe('in_match');
    expect(allowed(playing, HOST).cancel).toBe(true);
    expect(allowed(playing, player('p1')).leave).toBe(false);
    const outcome = accepted(attempt(playing, HOST, { type: 'cancel' }, playing.version));
    expect(outcome.lobby.state).toBe('gathering');
    expect(outcome.lobby.matchSlug).toBeNull();
    expect(outcome.effects).toEqual([{ type: 'cancel_match', slug: 'pu-lobby-00-1' }]);
  });

  test('the match ending returns the lobby to gathering with the same teams', TAGS, () => {
    const playing = run(duel(), [
      [HOST, { type: 'start' }],
      [player('p1'), { type: 'ready' }],
    ]);
    const context = { now: 900, random: () => 0.5 };
    const other = decideSystem(
      playing,
      { type: 'match_ended', slug: 'pu-x-9', winner: 'a' },
      context
    );
    expect(codeOf(other)).toBe('stale');
    const outcome = accepted(
      decideSystem(playing, { type: 'match_ended', slug: 'pu-lobby-00-1', winner: 'b' }, context)
    );
    expect(outcome.lobby.state).toBe('gathering');
    expect(outcome.lobby.matchNo).toBe(1);
    expect(ids(outcome.lobby, 'a')).toEqual(['host']);
    expect(ids(outcome.lobby, 'b')).toEqual(['p1']);
    expect(outcome.events[0]).toMatchObject({ type: 'match_ended', data: { winner: 'b' } });
    const again = decideSystem(
      outcome.lobby,
      { type: 'match_ended', slug: 'pu-lobby-00-1', winner: 'b' },
      context
    );
    expect(codeOf(again)).toBe('stale');
  });

  test('picking a map, and a new team size forgets it', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [[HOST, { type: 'pick_map', map: 'de_dust2' }]]);
    expect(lobby.pickedMap).toBe('de_dust2');
    expect(codeOf(attempt(lobby, player('p1'), { type: 'pick_map', map: null }))).toBe(
      'not_allowed'
    );
    lobby = run(lobby, [[HOST, { type: 'set_settings', teamSize: 2 }]]);
    expect(lobby.pickedMap).toBeNull();
  });
});
