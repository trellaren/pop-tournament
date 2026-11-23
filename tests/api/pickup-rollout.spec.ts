import { test, expect } from '@playwright/test';
import {
  decide,
  decideSystem,
  newLobby,
  seated,
  waiting,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
  type Side,
} from '../../api/src/services/pickup/rules';

/**
 * Roll-out in the pickup lobby (docs/design/pickup-lobby.md), as pure rules:
 * who leaves after a match, who comes in, games in a row, and the idle close.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: 'host', isAdmin: false };
const player = (playerId: string): Actor => ({ playerId, isAdmin: false });

function accepted(outcome: Outcome): Extract<Outcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome;
}

function run(lobby: Lobby, steps: Array<[Actor, Command]>): Lobby {
  let current = lobby;
  let now = 100;
  for (const [actor, command] of steps) {
    now += 1;
    current = accepted(
      decide(current, actor, command, { now, random: () => 0.5, version: current.version })
    ).lobby;
  }
  return current;
}

const ids = (lobby: Lobby, side: Side) =>
  seated(lobby, side)
    .map((p) => p.playerId)
    .sort();
const waitingIds = (lobby: Lobby) => waiting(lobby).map((p) => p.playerId);

/** A 2v2 in its first match: host and a2 against b1 and b2, with the given players waiting. */
function playing(waiters: string[], rule: 'most_played' | 'losers' = 'most_played'): Lobby {
  const steps: Array<[Actor, Command]> = [
    [HOST, { type: 'set_settings', teamSize: 2 }],
    [player('a2'), { type: 'join', side: 'a' }],
    [player('b1'), { type: 'join', side: 'b' }],
    [player('b2'), { type: 'join', side: 'b' }],
    ...waiters.map((id): [Actor, Command] => [player(id), { type: 'join', side: null }]),
  ];
  if (rule === 'losers') steps.push([HOST, { type: 'set_settings', rollOut: 'losers' }]);
  steps.push(
    [HOST, { type: 'start' }],
    [player('a2'), { type: 'ready' }],
    [player('b1'), { type: 'ready' }],
    [player('b2'), { type: 'ready' }]
  );
  return run(newLobby('lobby-0001', 'host', 100), steps);
}

function end(
  lobby: Lobby,
  winner: Side | null,
  random = () => 0.5
): Extract<Outcome, { ok: true }> {
  return accepted(
    decideSystem(
      lobby,
      { type: 'match_ended', slug: lobby.matchSlug ?? '', winner },
      { now: 900, random }
    )
  );
}

test.describe('pickup roll-out (pure)', () => {
  test('nobody waiting: nobody moves, everyone has one more game in a row', TAGS, () => {
    const after = end(playing([]), 'a').lobby;
    expect(ids(after, 'a')).toEqual(['a2', 'host']);
    expect(ids(after, 'b')).toEqual(['b1', 'b2']);
    expect(after.players.map((p) => p.gamesInRow)).toEqual([1, 1, 1, 1]);
  });

  test('one waiting: one seated player goes out and the waiter takes that seat', TAGS, () => {
    const outcome = end(playing(['w1']), 'a');
    const after = outcome.lobby;
    expect(ids(after, 'a').length + ids(after, 'b').length).toBe(4);
    expect([...ids(after, 'a'), ...ids(after, 'b')]).toContain('w1');
    expect(waitingIds(after)).toHaveLength(1);
    const out = waitingIds(after)[0];
    expect(['host', 'a2', 'b1', 'b2']).toContain(out);
    expect(after.players.find((p) => p.playerId === out)?.gamesInRow).toBe(0);
    expect(after.players.find((p) => p.playerId === 'w1')?.gamesInRow).toBe(0);
    expect(outcome.events.map((e) => e.type)).toEqual(['match_ended', 'rolled_out', 'rolled_in']);
    expect(ids(after, 'a')).toHaveLength(2);
    expect(ids(after, 'b')).toHaveLength(2);
  });

  test('at most one team rolls out, the longest waiters first', TAGS, () => {
    const after = end(playing(['w1', 'w2', 'w3']), 'a').lobby;
    const nowSeated = [...ids(after, 'a'), ...ids(after, 'b')];
    expect(nowSeated).toContain('w1');
    expect(nowSeated).toContain('w2');
    expect(nowSeated).not.toContain('w3');
    // w3 has waited longest now; the two who rolled out are behind them.
    expect(waitingIds(after)[0]).toBe('w3');
    expect(waitingIds(after)).toHaveLength(3);
  });

  test('those who have played most in a row go first', TAGS, () => {
    // Match 1 ends with one waiter: someone rolls out. In match 2 the newcomer
    // has 0 games in a row and the other three have 1.
    let lobby = end(playing(['w1']), null).lobby;
    const benched = waitingIds(lobby)[0];
    lobby = run(lobby, [[HOST, { type: 'start' }]]);
    for (const p of lobby.players.filter((x) => x.side !== null && !x.ready)) {
      lobby = run(lobby, [[player(p.playerId), { type: 'ready' }]]);
    }
    expect(lobby.state).toBe('in_match');
    const after = end(lobby, null).lobby;
    // The newcomer of match 2 has played least, so they stay.
    expect([...ids(after, 'a'), ...ids(after, 'b')]).toContain('w1');
    expect([...ids(after, 'a'), ...ids(after, 'b')]).toContain(benched);
    expect(after.players.find((p) => p.playerId === 'w1')?.gamesInRow).toBe(1);
  });

  test('losing team rule: the losers leave; a draw falls back to games in a row', TAGS, () => {
    const after = end(playing(['w1', 'w2'], 'losers'), 'a').lobby;
    expect(ids(after, 'a')).toEqual(['a2', 'host']);
    expect(ids(after, 'b')).toEqual(['w1', 'w2']);
    expect(waitingIds(after).sort()).toEqual(['b1', 'b2']);
    const drawn = end(playing(['w1'], 'losers'), null).lobby;
    expect(waitingIds(drawn)).toHaveLength(1);
  });

  test('the same randomness gives the same roll-out', TAGS, () => {
    const lobby = playing(['w1']);
    const first = waitingIds(end(lobby, null, () => 0.1).lobby);
    expect(waitingIds(end(lobby, null, () => 0.1).lobby)).toEqual(first);
  });

  test('roll out by hand: to the waiting room, the longest waiter takes the seat', TAGS, () => {
    let lobby = run(newLobby('l', 'host', 100), [
      [player('b1'), { type: 'join', side: 'b' }],
      [player('w1'), { type: 'join', side: null }],
      [player('w2'), { type: 'join', side: null }],
    ]);
    const refused = decide(
      lobby,
      player('b1'),
      { type: 'roll_out', playerId: 'host' },
      { now: 200, random: () => 0.5, version: lobby.version }
    );
    expect(refused.ok ? 'ok' : refused.code).toBe('not_allowed');
    lobby = accepted(
      decide(
        lobby,
        HOST,
        { type: 'roll_out', playerId: 'b1' },
        { now: 200, random: () => 0.5, version: lobby.version }
      )
    ).lobby;
    expect(ids(lobby, 'b')).toEqual(['w1']);
    expect(waitingIds(lobby)).toEqual(['w2', 'b1']);
    const waiter = decide(
      lobby,
      HOST,
      { type: 'roll_out', playerId: 'w2' },
      { now: 200, random: () => 0.5, version: lobby.version }
    );
    expect(waiter.ok ? 'ok' : waiter.code).toBe('not_in_lobby');
  });

  test('the roll-out rule is a setting; an unknown one is refused', TAGS, () => {
    const lobby = run(newLobby('l', 'host', 100), [
      [HOST, { type: 'set_settings', rollOut: 'losers' }],
    ]);
    expect(lobby.settings).toEqual({ teamSize: 5, rollOut: 'losers' });
    const same = decide(
      lobby,
      HOST,
      { type: 'set_settings', rollOut: 'losers' },
      { now: 200, random: () => 0.5 }
    );
    expect(same.ok ? 'ok' : same.code).toBe('no_change');
  });

  test('an idle lobby closes, but not during a ready check or a match', TAGS, () => {
    const context = { now: 99999, random: () => 0.5 };
    const idle = accepted(
      decideSystem(newLobby('l', 'host', 100), { type: 'idle_timeout' }, context)
    );
    expect(idle.lobby.state).toBe('closed');
    expect(idle.events[0]).toMatchObject({ type: 'closed', data: { reason: 'idle' } });
    const busy = decideSystem(playing([]), { type: 'idle_timeout' }, context);
    expect(busy.ok ? 'ok' : busy.code).toBe('stale');
  });
});
