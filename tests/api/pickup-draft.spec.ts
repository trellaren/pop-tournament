import { test, expect } from '@playwright/test';
import {
  PICK_SECONDS,
  allowed,
  decide,
  decideSystem,
  draftPool,
  newLobby,
  seated,
  sideOfPick,
  turnOf,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
  type Side,
} from '../../api/src/services/pickup/rules';

/**
 * The captain draft in the pickup lobby (docs/design/pickup-lobby.md), as
 * pure rules: captains, the pick order, the timer, and how it ends.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: 'host', isAdmin: false };
const player = (playerId: string): Actor => ({ playerId, isAdmin: false });
const RATINGS = { host: 1500, p1: 2000, p2: 1900, p3: 1200, p4: 1100, p5: 1000 };

function accepted(outcome: Outcome): Extract<Outcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome;
}
const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);

let clock = 1000;
function act(lobby: Lobby, actor: Actor, command: Command): Outcome {
  clock += 1;
  return decide(lobby, actor, command, { now: clock, random: () => 0, version: lobby.version });
}
const ids = (lobby: Lobby, side: Side) =>
  seated(lobby, side)
    .map((p) => p.playerId)
    .sort();

/** A 3v3 lobby with the host and five others, all in the waiting room but the host. */
function crowd(): Lobby {
  let lobby = accepted(
    act(newLobby('l', 'host', 100), HOST, { type: 'set_settings', teamSize: 3 })
  ).lobby;
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
    lobby = accepted(act(lobby, player(id), { type: 'join', side: null })).lobby;
  }
  return lobby;
}

function byHost(lobby: Lobby): Lobby {
  return accepted(
    act(lobby, HOST, {
      type: 'start_draft',
      method: 'host',
      ratings: RATINGS,
      captainA: 'host',
      captainB: 'p1',
    })
  ).lobby;
}

test.describe('pickup captain draft (pure)', () => {
  test('the pick order is 1-2-2-2-1', TAGS, () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(sideOfPick).join('')).toBe('abbaabba');
  });

  test('captains by the host: they are seated, everyone else is to pick', TAGS, () => {
    const outcome = accepted(
      act(crowd(), HOST, {
        type: 'start_draft',
        method: 'host',
        ratings: RATINGS,
        captainA: 'host',
        captainB: 'p1',
      })
    );
    const lobby = outcome.lobby;
    expect(lobby.state).toBe('drafting');
    expect(ids(lobby, 'a')).toEqual(['host']);
    expect(ids(lobby, 'b')).toEqual(['p1']);
    expect(draftPool(lobby).map((p) => p.playerId)).toEqual(['p2', 'p3', 'p4', 'p5']);
    expect(turnOf(lobby)).toBe('a');
    expect(lobby.deadline).toBe(clock + PICK_SECONDS);
    expect(outcome.effects).toEqual([{ type: 'pick_timer', deadline: clock + PICK_SECONDS }]);
    expect(allowed(lobby, HOST).pick).toBe(true);
    expect(allowed(lobby, player('p1')).pick).toBe(false);
  });

  test('captains by rating are the two best; at random follows the randomness', TAGS, () => {
    const rated = accepted(
      act(crowd(), HOST, { type: 'start_draft', method: 'rating', ratings: RATINGS })
    ).lobby;
    // The lower rated of the two picks first.
    expect(rated.draft?.captains).toEqual({ a: 'p2', b: 'p1' });
    const random = accepted(
      act(crowd(), HOST, { type: 'start_draft', method: 'random', ratings: RATINGS })
    ).lobby;
    const captains = Object.values(random.draft?.captains ?? {});
    expect(new Set(captains).size).toBe(2);
  });

  test('bad captains and too few players are refused', TAGS, () => {
    const lobby = crowd();
    const same = act(lobby, HOST, {
      type: 'start_draft',
      method: 'host',
      ratings: RATINGS,
      captainA: 'host',
      captainB: 'host',
    });
    expect(codeOf(same)).toBe('invalid_captains');
    const stranger = act(lobby, HOST, {
      type: 'start_draft',
      method: 'host',
      ratings: RATINGS,
      captainA: 'host',
      captainB: 'nobody',
    });
    expect(codeOf(stranger)).toBe('invalid_captains');
    const alone = newLobby('x', 'host', 1);
    expect(codeOf(act(alone, HOST, { type: 'start_draft', method: 'random', ratings: {} }))).toBe(
      'not_enough_players'
    );
    expect(
      codeOf(act(lobby, player('p1'), { type: 'start_draft', method: 'random', ratings: {} }))
    ).toBe('not_allowed');
  });

  test('picks go in turn until the teams are full, then the teams are locked', TAGS, () => {
    let lobby = byHost(crowd());
    expect(codeOf(act(lobby, player('p1'), { type: 'pick', playerId: 'p2' }))).toBe(
      'not_your_turn'
    );
    expect(codeOf(act(lobby, HOST, { type: 'pick', playerId: 'p1' }))).toBe('not_in_lobby');
    lobby = accepted(act(lobby, HOST, { type: 'pick', playerId: 'p2' })).lobby;
    expect(turnOf(lobby)).toBe('b');
    lobby = accepted(act(lobby, player('p1'), { type: 'pick', playerId: 'p3' })).lobby;
    expect(turnOf(lobby)).toBe('b');
    lobby = accepted(act(lobby, player('p1'), { type: 'pick', playerId: 'p4' })).lobby;
    // Team B is full; the last pick is Team A's.
    expect(turnOf(lobby)).toBe('a');
    const last = accepted(act(lobby, HOST, { type: 'pick', playerId: 'p5' }));
    expect(last.lobby.state).toBe('gathering');
    expect(last.lobby.draft).toBeNull();
    expect(last.lobby.teamsLocked).toBe(true);
    expect(ids(last.lobby, 'a')).toEqual(['host', 'p2', 'p5']);
    expect(ids(last.lobby, 'b')).toEqual(['p1', 'p3', 'p4']);
    expect(last.events.map((e) => e.type)).toEqual(['picked', 'draft_finished']);
    expect(allowed(last.lobby, HOST).start).toBe(true);
  });

  test('a pick that runs out of time takes the best rated player left', TAGS, () => {
    const lobby = byHost(crowd());
    const deadline = lobby.deadline ?? 0;
    const early = decideSystem(
      lobby,
      { type: 'pick_timeout', deadline },
      { now: deadline - 1, random: () => 0 }
    );
    expect(codeOf(early)).toBe('stale');
    const outcome = accepted(
      decideSystem(lobby, { type: 'pick_timeout', deadline }, { now: deadline, random: () => 0 })
    );
    expect(ids(outcome.lobby, 'a')).toEqual(['host', 'p2']);
    expect(outcome.events[0]).toMatchObject({ type: 'picked', actorId: 'system' });
    expect(outcome.lobby.deadline).toBe(deadline + PICK_SECONDS);
  });

  test('fewer players than seats: the draft ends when nobody is left', TAGS, () => {
    let lobby = accepted(
      act(newLobby('l', 'host', 100), player('p1'), { type: 'join', side: 'a' })
    ).lobby;
    lobby = accepted(act(lobby, player('p2'), { type: 'join', side: null })).lobby;
    lobby = accepted(
      act(lobby, HOST, { type: 'start_draft', method: 'rating', ratings: RATINGS })
    ).lobby;
    const captain = lobby.draft?.captains.a ?? '';
    const outcome = accepted(act(lobby, player(captain), { type: 'pick', playerId: 'host' }));
    expect(outcome.lobby.state).toBe('gathering');
    expect(outcome.lobby.teamsLocked).toBe(true);
  });

  test('during the draft the teams are frozen; Cancel and a captain leaving end it', TAGS, () => {
    const lobby = byHost(crowd());
    expect(codeOf(act(lobby, HOST, { type: 'scramble' }))).toBe('wrong_state');
    expect(codeOf(act(lobby, player('p2'), { type: 'join', side: 'a' }))).toBe('wrong_state');
    expect(codeOf(act(lobby, player('new'), { type: 'join', side: null }))).toBe('ok');
    const cancelled = accepted(act(lobby, HOST, { type: 'cancel' }));
    expect(cancelled.lobby.state).toBe('gathering');
    expect(cancelled.lobby.draft).toBeNull();
    expect(cancelled.events[0].type).toBe('draft_cancelled');
    const left = accepted(act(lobby, player('p1'), { type: 'leave' }));
    expect(left.lobby.state).toBe('gathering');
    expect(left.events.map((e) => e.type)).toEqual(['left', 'draft_cancelled']);
    const other = accepted(act(lobby, player('p3'), { type: 'leave' }));
    expect(other.lobby.state).toBe('drafting');
  });
});
