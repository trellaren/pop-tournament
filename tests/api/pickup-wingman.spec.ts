import { test, expect } from '@playwright/test';
import {
  decide,
  newLobby,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
} from '../../api/src/services/pickup/rules';
import { parseSettings } from '../../api/src/services/pickup/pickupParse';

/**
 * The pickup lobby's format (docs/design/pickup-lobby.md): Classic or
 * Wingman, and what choosing one brings, as pure rules.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: 'host', isAdmin: false };
const actor = (playerId: string): Actor => ({ playerId, isAdmin: false });

function act(lobby: Lobby, who: Actor, command: Command): Outcome {
  return decide(lobby, who, command, { now: 500, random: () => 0, version: lobby.version });
}
function after(lobby: Lobby, who: Actor, command: Command): Lobby {
  const outcome = act(lobby, who, command);
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.lobby;
}
const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);
const fresh = () => newLobby('lobby-0001', 'host', 100);

test.describe('pickup format (pure)', () => {
  test('a new lobby is Classic 5v5', TAGS, () => {
    expect(fresh().settings).toMatchObject({ format: 'classic', teamSize: 5 });
  });

  test('Wingman brings 2v2 and its own maps; Classic gives 5v5 back', TAGS, () => {
    const pooled = after(fresh(), HOST, { type: 'set_settings', poolId: 7 });
    const picked = after(pooled, HOST, { type: 'pick_map', map: 'de_dust2' });
    const outcome = act(picked, HOST, { type: 'set_settings', format: 'wingman' });
    if (!outcome.ok) throw new Error(outcome.code);
    expect(outcome.lobby.settings).toMatchObject({ format: 'wingman', teamSize: 2, poolId: null });
    expect(outcome.lobby.pickedMap).toBeNull();
    expect(outcome.events.map((e) => e.type)).toEqual(['format', 'settings_changed', 'map_pool']);

    const back = after(outcome.lobby, HOST, { type: 'set_settings', format: 'classic' });
    expect(back.settings).toMatchObject({ format: 'classic', teamSize: 5, poolId: null });
  });

  test('a 1v1 stays a 1v1 in Wingman', TAGS, () => {
    const one = after(fresh(), HOST, { type: 'set_settings', teamSize: 1 });
    const wingman = after(one, HOST, { type: 'set_settings', format: 'wingman' });
    expect(wingman.settings.teamSize).toBe(1);
  });

  test('the same change may name the team size and the pool', TAGS, () => {
    const wingman = after(fresh(), HOST, {
      type: 'set_settings',
      format: 'wingman',
      teamSize: 1,
      poolId: 3,
    });
    expect(wingman.settings).toMatchObject({ format: 'wingman', teamSize: 1, poolId: 3 });
  });

  test('Wingman has no team size above two', TAGS, () => {
    const wingman = after(fresh(), HOST, { type: 'set_settings', format: 'wingman' });
    expect(codeOf(act(wingman, HOST, { type: 'set_settings', teamSize: 3 }))).toBe(
      'invalid_settings'
    );
    expect(
      codeOf(act(fresh(), HOST, { type: 'set_settings', format: 'wingman', teamSize: 5 }))
    ).toBe('invalid_settings');
    expect(codeOf(act(wingman, HOST, { type: 'set_settings', format: 'wingman' }))).toBe(
      'no_change'
    );
  });

  test('Wingman is refused while more than two sit on a side', TAGS, () => {
    let lobby = fresh();
    for (const id of ['p1', 'p2', 'p3']) {
      lobby = after(lobby, actor(id), { type: 'join', side: 'a' });
    }
    expect(codeOf(act(lobby, HOST, { type: 'set_settings', format: 'wingman' }))).toBe(
      'team_size_below_seated'
    );
  });

  test('only the host or an admin changes the format', TAGS, () => {
    expect(codeOf(act(fresh(), actor('p1'), { type: 'set_settings', format: 'wingman' }))).toBe(
      'not_allowed'
    );
  });

  test('settings stored before the format read as Classic', TAGS, () => {
    expect(parseSettings('{"teamSize":2}')).toMatchObject({ format: 'classic', teamSize: 2 });
    expect(parseSettings('{"format":"wingman","teamSize":2}').format).toBe('wingman');
    expect(parseSettings('{"format":"duel"}').format).toBe('classic');
  });
});
