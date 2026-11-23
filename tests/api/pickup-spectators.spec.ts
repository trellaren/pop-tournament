import { test, expect } from '@playwright/test';
import {
  decide,
  newLobby,
  type Actor,
  type Command,
  type Lobby,
} from '../../api/src/services/pickup/rules';
import { maySpectate } from '../../api/src/services/pickup/spectators';

/**
 * Who may watch a pickup lobby's match from inside its server
 * (docs/design/pickup-lobby.md), as a pure rule.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: '1', isAdmin: false };
const ADMIN: Actor = { playerId: '9', isAdmin: true };
const actor = (playerId: string): Actor => ({ playerId, isAdmin: false });

function after(lobby: Lobby, who: Actor, command: Command, now = 900): Lobby {
  const outcome = decide(lobby, who, command, { now, random: () => 0, version: lobby.version });
  if (!outcome.ok) throw new Error(`${command.type}: ${outcome.code}`);
  return outcome.lobby;
}

/** A 1v1 in its match: 1 against 2, with 3 and 4 in the waiting room. */
function playing(): Lobby {
  let lobby = after(newLobby('0f8fad5b-d9cb-469f-a165-70867728950e', '1', 100), HOST, {
    type: 'set_settings',
    teamSize: 1,
  });
  lobby = after(lobby, actor('2'), { type: 'join', side: 'b' });
  lobby = after(lobby, actor('3'), { type: 'join', side: null });
  lobby = after(lobby, actor('4'), { type: 'join', side: null });
  lobby = after(lobby, HOST, { type: 'start' });
  return after(lobby, actor('2'), { type: 'ready' });
}

test.describe('pickup spectators (pure)', () => {
  test('those waiting may watch; those playing may not', TAGS, () => {
    const lobby = playing();
    expect(maySpectate(lobby, actor('3'))).toBe(true);
    expect(maySpectate(lobby, actor('1'))).toBe(false);
    expect(maySpectate(lobby, actor('2'))).toBe(false);
  });

  test('an admin may without being in the lobby; a stranger may not', TAGS, () => {
    const lobby = playing();
    expect(maySpectate(lobby, ADMIN)).toBe(true);
    expect(maySpectate(lobby, actor('77'))).toBe(false);
  });

  test('someone substituted out of the match may not watch it', TAGS, () => {
    const lobby = after(playing(), HOST, { type: 'substitute', outId: '2', inId: '3' });
    expect(maySpectate(lobby, actor('2'))).toBe(false);
    expect(maySpectate(lobby, actor('4'))).toBe(true);
    expect(maySpectate(lobby, actor('3'))).toBe(false);
  });

  test('nobody spectates outside a match', TAGS, () => {
    const lobby = after(playing(), HOST, { type: 'cancel' });
    expect(maySpectate(lobby, actor('3'))).toBe(false);
    expect(maySpectate(lobby, ADMIN)).toBe(false);
  });
});
