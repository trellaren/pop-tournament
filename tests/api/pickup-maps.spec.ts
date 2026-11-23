import { test, expect } from '@playwright/test';
import {
  VOTE_SECONDS,
  decide,
  decideSystem,
  newLobby,
  voteWinner,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
} from '../../api/src/services/pickup/rules';

/**
 * How the pickup lobby chooses its map (docs/design/pickup-lobby.md), as pure
 * rules: the settings, the lobby's vote, and the veto flag on the match.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: 'host', isAdmin: false };
const P1: Actor = { playerId: 'p1', isAdmin: false };

function accepted(outcome: Outcome): Extract<Outcome, { ok: true }> {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome;
}
const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);
function act(lobby: Lobby, actor: Actor, command: Command, now = 500): Outcome {
  return decide(lobby, actor, command, { now, random: () => 0, version: lobby.version });
}

/** A full 1v1 with the given map method, everyone ready but p1. */
function checking(mapMethod: 'pick' | 'veto' | 'vote'): Lobby {
  let lobby = accepted(
    act(newLobby('lobby-0001', 'host', 100), HOST, { type: 'set_settings', teamSize: 1 })
  ).lobby;
  if (mapMethod !== 'pick') {
    lobby = accepted(act(lobby, HOST, { type: 'set_settings', mapMethod })).lobby;
  }
  lobby = accepted(act(lobby, P1, { type: 'join', side: 'b' })).lobby;
  return accepted(act(lobby, HOST, { type: 'start' })).lobby;
}

test.describe('pickup maps (pure)', () => {
  test('settings: the map method and the pool; a new pool forgets the picked map', TAGS, () => {
    let lobby = accepted(
      act(newLobby('l', 'host', 1), HOST, { type: 'pick_map', map: 'de_dust2' })
    ).lobby;
    lobby = accepted(act(lobby, HOST, { type: 'set_settings', mapMethod: 'vote' })).lobby;
    expect(lobby.settings.mapMethod).toBe('vote');
    expect(lobby.pickedMap).toBe('de_dust2');
    const pooled = accepted(act(lobby, HOST, { type: 'set_settings', poolId: 3 }));
    expect(pooled.lobby.settings.poolId).toBe(3);
    expect(pooled.lobby.pickedMap).toBeNull();
    expect(pooled.events.map((e) => e.type)).toEqual(['map_pool']);
    expect(codeOf(act(lobby, HOST, { type: 'set_settings', poolId: 0 }))).toBe('invalid_settings');
    expect(codeOf(act(lobby, HOST, { type: 'set_settings', mapMethod: 'vote' }))).toBe('no_change');
    expect(codeOf(act(lobby, P1, { type: 'set_settings', mapMethod: 'veto' }))).toBe('not_allowed');
  });

  test("host's pick: everyone ready makes the match on that map, no veto", TAGS, () => {
    const outcome = accepted(act(checking('pick'), P1, { type: 'ready' }));
    expect(outcome.lobby.state).toBe('in_match');
    expect(outcome.effects).toEqual([{ type: 'create_match', slug: 'pu-lobby-00-1', veto: false }]);
  });

  test('veto: the match is made at once and vetoes its map', TAGS, () => {
    const outcome = accepted(act(checking('veto'), P1, { type: 'ready' }));
    expect(outcome.lobby.state).toBe('in_match');
    expect(outcome.effects).toEqual([{ type: 'create_match', slug: 'pu-lobby-00-1', veto: true }]);
  });

  test('vote: everyone ready opens the vote; all votes in closes it', TAGS, () => {
    const opened = accepted(act(checking('vote'), P1, { type: 'ready' }, 600));
    expect(opened.lobby.state).toBe('map_vote');
    expect(opened.lobby.deadline).toBe(600 + VOTE_SECONDS);
    expect(opened.effects).toEqual([{ type: 'vote_timer', deadline: 600 + VOTE_SECONDS }]);

    const stranger: Actor = { playerId: 'x', isAdmin: false };
    expect(codeOf(act(opened.lobby, stranger, { type: 'vote_map', map: 'de_dust2' }))).toBe(
      'not_in_lobby'
    );
    let lobby = accepted(act(opened.lobby, HOST, { type: 'vote_map', map: 'de_dust2' })).lobby;
    expect(lobby.state).toBe('map_vote');
    expect(codeOf(act(lobby, HOST, { type: 'vote_map', map: 'de_dust2' }))).toBe('no_change');
    // A vote can be changed while the vote runs.
    lobby = accepted(act(lobby, HOST, { type: 'vote_map', map: 'de_mirage' })).lobby;
    const closed = accepted(act(lobby, P1, { type: 'vote_map', map: 'de_mirage' }));
    expect(closed.lobby.state).toBe('in_match');
    expect(closed.lobby.pickedMap).toBe('de_mirage');
    expect(closed.lobby.votes).toEqual({});
    expect(closed.events.map((e) => e.type)).toEqual(['map_voted', 'match_starting']);
    expect(closed.effects).toEqual([{ type: 'create_match', slug: 'pu-lobby-00-1', veto: false }]);
  });

  test(
    'the vote running out takes the votes there are; none leaves the map to the draw',
    TAGS,
    () => {
      const opened = accepted(act(checking('vote'), P1, { type: 'ready' }, 600)).lobby;
      const deadline = opened.deadline ?? 0;
      const context = { now: deadline, random: () => 0 };
      const early = decideSystem(
        opened,
        { type: 'vote_timeout', deadline },
        { ...context, now: 601 }
      );
      expect(codeOf(early)).toBe('stale');
      const none = accepted(decideSystem(opened, { type: 'vote_timeout', deadline }, context));
      expect(none.lobby.state).toBe('in_match');
      expect(none.lobby.pickedMap).toBeNull();
      const one = accepted(act(opened, P1, { type: 'vote_map', map: 'de_nuke' })).lobby;
      const some = accepted(decideSystem(one, { type: 'vote_timeout', deadline }, context));
      expect(some.lobby.pickedMap).toBe('de_nuke');
    }
  );

  test('the winner has the most votes; a tie is drawn among the tied', TAGS, () => {
    expect(voteWinner({}, () => 0)).toBeNull();
    expect(voteWinner({ a: 'x', b: 'y', c: 'y' }, () => 0)).toBe('y');
    expect(voteWinner({ a: 'x', b: 'y' }, () => 0)).toBe('x');
    expect(voteWinner({ a: 'x', b: 'y' }, () => 0.99)).toBe('y');
  });

  test('Cancel during the vote returns to gathering', TAGS, () => {
    const opened = accepted(act(checking('vote'), P1, { type: 'ready' })).lobby;
    const cancelled = accepted(act(opened, HOST, { type: 'cancel' }));
    expect(cancelled.lobby.state).toBe('gathering');
    expect(cancelled.lobby.votes).toEqual({});
  });
});
