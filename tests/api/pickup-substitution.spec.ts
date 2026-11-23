import { test, expect } from '@playwright/test';
import {
  allowed,
  decide,
  decideSystem,
  newLobby,
  substitutes,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
  type SystemCommand,
} from '../../api/src/services/pickup/rules';
import { parseSubstitution } from '../../api/src/services/pickup/pickupParse';

/**
 * Mid-match substitution (docs/design/pickup-lobby.md) as pure rules: who may
 * come in, where both players end up, and a substitution the match server
 * did not take.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: '1', isAdmin: false };
const actor = (playerId: string): Actor => ({ playerId, isAdmin: false });

function act(lobby: Lobby, who: Actor, command: Command, now = 900): Outcome {
  return decide(lobby, who, command, { now, random: () => 0, version: lobby.version });
}
function after(lobby: Lobby, who: Actor, command: Command, now = 900): Lobby {
  const outcome = act(lobby, who, command, now);
  if (!outcome.ok) throw new Error(`${command.type}: ${outcome.code}`);
  return outcome.lobby;
}
function report(lobby: Lobby, command: SystemCommand): Outcome {
  return decideSystem(lobby, command, { now: 950, random: () => 0 });
}
const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);
const where = (lobby: Lobby, id: string) => lobby.players.find((p) => p.playerId === id)?.side;

/** A 1v1 in its match: 1 on Team A, 2 on Team B; 3 then 4 in the waiting room. */
function playing(): Lobby {
  let lobby = after(newLobby('0f8fad5b-d9cb-469f-a165-70867728950e', '1', 100), HOST, {
    type: 'set_settings',
    teamSize: 1,
  });
  lobby = after(lobby, actor('2'), { type: 'join', side: 'b' });
  lobby = after(lobby, actor('3'), { type: 'join', side: null }, 300);
  lobby = after(lobby, actor('4'), { type: 'join', side: null }, 400);
  lobby = after(lobby, HOST, { type: 'start' });
  lobby = after(lobby, actor('2'), { type: 'ready' });
  expect(lobby.state).toBe('in_match');
  return lobby;
}
const swap = (outId: string, inId: string): Command => ({ type: 'substitute', outId, inId });

test.describe('pickup substitution (pure)', () => {
  test(
    'the substitute takes the seat; the leaver goes to the back of the waiting room',
    TAGS,
    () => {
      const lobby = playing();
      expect(substitutes(lobby).map((p) => p.playerId)).toEqual(['3', '4']);
      const outcome = act(lobby, HOST, swap('2', '3'));
      if (!outcome.ok) throw new Error(outcome.code);
      expect(where(outcome.lobby, '3')).toBe('b');
      expect(where(outcome.lobby, '2')).toBeNull();
      expect(outcome.lobby.leavers).toEqual(['2']);
      expect(outcome.lobby.state).toBe('in_match');
      expect(outcome.effects).toEqual([
        { type: 'substitute', slug: lobby.matchSlug, outId: '2', inId: '3', side: 'b' },
      ]);
      expect(outcome.events[0]).toMatchObject({
        type: 'substituted',
        data: { playerId: '3', outId: '2', side: 'b' },
      });
      // The leaver waits behind player 4, and is not offered for this match again.
      expect(substitutes(outcome.lobby).map((p) => p.playerId)).toEqual(['4']);
    }
  );

  test('nobody comes back into the same match', TAGS, () => {
    const lobby = after(playing(), HOST, swap('2', '3'));
    expect(codeOf(act(lobby, HOST, swap('3', '2')))).toBe('already_subbed_out');
    expect(codeOf(act(lobby, HOST, swap('1', '4')))).toBe('ok');
  });

  test('who may not: not the host, not playing, not waiting, outside a match', TAGS, () => {
    const lobby = playing();
    expect(codeOf(act(lobby, actor('3'), swap('2', '3')))).toBe('not_allowed');
    expect(codeOf(act(lobby, HOST, swap('3', '4')))).toBe('not_on_roster');
    expect(codeOf(act(lobby, HOST, swap('2', '1')))).toBe('not_eligible');
    expect(codeOf(act(lobby, HOST, swap('2', '99')))).toBe('not_eligible');
    expect(codeOf(decide(lobby, HOST, swap('2', '3'), { now: 900, random: () => 0 }))).toBe(
      'stale'
    );
    const gathering = after(lobby, HOST, { type: 'cancel' });
    expect(codeOf(act(gathering, HOST, swap('2', '3')))).toBe('wrong_state');
    expect(allowed(gathering, HOST).substitute).toBe(false);
    expect(allowed(lobby, HOST).substitute).toBe(true);
  });

  test('a substitution the server did not take: Retry sends it again', TAGS, () => {
    const lobby = after(playing(), HOST, swap('2', '3'));
    const slug = lobby.matchSlug ?? '';
    const failed = report(lobby, { type: 'substitution_failed', slug, outId: '2', inId: '3' });
    if (!failed.ok) throw new Error(failed.code);
    expect(failed.lobby.subFailed).toEqual({ outId: '2', inId: '3', side: 'b' });
    expect(allowed(failed.lobby, HOST).substitution_action).toBe(true);
    // Nothing else is substituted while one is open.
    expect(codeOf(act(failed.lobby, HOST, swap('1', '4')))).toBe('wrong_state');

    const retried = act(failed.lobby, HOST, { type: 'substitution_action', action: 'retry' });
    if (!retried.ok) throw new Error(retried.code);
    expect(retried.lobby.subFailed).toBeNull();
    expect(retried.effects).toEqual([
      { type: 'substitute', slug, outId: '2', inId: '3', side: 'b' },
    ]);
  });

  test('Undo puts both back, and the leaver may be substituted later', TAGS, () => {
    const lobby = after(playing(), HOST, swap('2', '3'));
    const slug = lobby.matchSlug ?? '';
    const failed = report(lobby, { type: 'substitution_failed', slug, outId: '2', inId: '3' });
    if (!failed.ok) throw new Error(failed.code);
    const undone = act(failed.lobby, HOST, { type: 'substitution_action', action: 'undo' });
    if (!undone.ok) throw new Error(undone.code);
    expect(where(undone.lobby, '2')).toBe('b');
    expect(where(undone.lobby, '3')).toBeNull();
    expect(undone.lobby.leavers).toEqual([]);
    expect(undone.lobby.subFailed).toBeNull();
    expect(undone.effects).toEqual([]);
    expect(codeOf(act(undone.lobby, HOST, { type: 'substitution_action', action: 'undo' }))).toBe(
      'wrong_state'
    );
  });

  test('a failure report for another match or an undone substitution is dropped', TAGS, () => {
    const lobby = after(playing(), HOST, swap('2', '3'));
    const other = {
      type: 'substitution_failed' as const,
      slug: 'pu-other-1',
      outId: '2',
      inId: '3',
    };
    expect(codeOf(report(lobby, other))).toBe('stale');
    const slug = lobby.matchSlug ?? '';
    const wrong = { type: 'substitution_failed' as const, slug, outId: '1', inId: '4' };
    expect(codeOf(report(lobby, wrong))).toBe('stale');
  });

  test('the match ending clears who left; the result counts for those on the field', TAGS, () => {
    const lobby = after(playing(), HOST, swap('2', '3'));
    const ended = report(lobby, { type: 'match_ended', slug: lobby.matchSlug ?? '', winner: 'b' });
    if (!ended.ok) throw new Error(ended.code);
    expect(ended.lobby.leavers).toEqual([]);
    expect(ended.lobby.subFailed).toBeNull();
    const games = (id: string) => ended.lobby.players.find((p) => p.playerId === id)?.gamesInRow;
    expect(games('2')).toBe(0);
  });

  test('what is stored reads back, and nonsense reads as nothing', TAGS, () => {
    const stored = JSON.stringify({ leavers: ['2'], failed: { outId: '2', inId: '3', side: 'b' } });
    expect(parseSubstitution(stored)).toEqual({
      leavers: ['2'],
      subFailed: { outId: '2', inId: '3', side: 'b' },
    });
    expect(parseSubstitution(null)).toEqual({ leavers: [], subFailed: null });
    expect(parseSubstitution('{"leavers":[1],"failed":{"side":"c"}}')).toEqual({
      leavers: [],
      subFailed: null,
    });
    expect(parseSubstitution('not json')).toEqual({ leavers: [], subFailed: null });
  });
});
