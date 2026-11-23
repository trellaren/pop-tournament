import { test, expect } from '@playwright/test';
import {
  MAX_INVITES,
  decide,
  newLobby,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
} from '../../api/src/services/pickup/rules';
import {
  INVITE_LINK_SECONDS,
  looksLikeInviteToken,
  signInviteToken,
  verifyInviteToken,
} from '../../api/src/services/pickup/inviteToken';

/**
 * Who can join a pickup lobby (docs/design/pickup-lobby.md): the setting, the
 * invite list and the invite link's token, as pure functions.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const HOST: Actor = { playerId: '1', isAdmin: false };
const ADMIN: Actor = { playerId: '9', isAdmin: true };
const actor = (playerId: string): Actor => ({ playerId, isAdmin: false });

function act(lobby: Lobby, who: Actor, command: Command): Outcome {
  return decide(lobby, who, command, { now: 500, random: () => 0, version: lobby.version });
}
function after(lobby: Lobby, who: Actor, command: Command): Lobby {
  const outcome = act(lobby, who, command);
  if (!outcome.ok) throw new Error(`${command.type}: ${outcome.code}`);
  return outcome.lobby;
}
const codeOf = (outcome: Outcome) => (outcome.ok ? 'ok' : outcome.code);
const fresh = () => newLobby('0f8fad5b-d9cb-469f-a165-70867728950e', '1', 100);
const inviteOnly = (lobby: Lobby = fresh()) =>
  after(lobby, HOST, { type: 'set_settings', visibility: 'invite' });
const join: Command = { type: 'join', side: null };

test.describe('pickup invites (pure)', () => {
  test('a new lobby lets everyone join', TAGS, () => {
    expect(fresh().settings.visibility).toBe('open');
    expect(codeOf(act(fresh(), actor('2'), join))).toBe('ok');
  });

  test('invited only: newcomers are refused, the invited and admins are not', TAGS, () => {
    const lobby = inviteOnly();
    expect(codeOf(act(lobby, actor('2'), join))).toBe('invite_only');
    expect(codeOf(act(lobby, ADMIN, join))).toBe('ok');
    const invited = after(lobby, HOST, { type: 'invite', playerId: '2' });
    expect(codeOf(act(invited, actor('2'), join))).toBe('ok');
    expect(codeOf(act(invited, actor('3'), join))).toBe('invite_only');
  });

  test('switching to invited only invites everyone already in', TAGS, () => {
    const open = after(fresh(), actor('2'), join);
    const lobby = inviteOnly(open);
    expect([...lobby.invited].sort()).toEqual(['1', '2']);
    const left = after(lobby, actor('2'), { type: 'leave' });
    expect(codeOf(act(left, actor('2'), join))).toBe('ok');
  });

  test('a checked link lets its holder in and puts them on the list', TAGS, () => {
    const lobby = inviteOnly();
    const entered = after(lobby, actor('2'), { ...join, byLink: true });
    expect(entered.invited).toContain('2');
    expect(entered.players.map((p) => p.playerId)).toContain('2');
  });

  test('only the host or an admin invites, never themselves, never twice', TAGS, () => {
    const lobby = fresh();
    expect(codeOf(act(lobby, actor('2'), { type: 'invite', playerId: '3' }))).toBe('not_allowed');
    expect(codeOf(act(lobby, HOST, { type: 'invite', playerId: '1' }))).toBe('not_allowed');
    const invited = after(lobby, HOST, { type: 'invite', playerId: '2' });
    expect(codeOf(act(invited, HOST, { type: 'invite', playerId: '2' }))).toBe('already_invited');
    expect(codeOf(act(invited, ADMIN, { type: 'invite', playerId: '3' }))).toBe('ok');
  });

  test('the list holds no more than its limit', TAGS, () => {
    let lobby = fresh();
    for (let n = 0; n < MAX_INVITES; n += 1) {
      lobby = after(lobby, HOST, { type: 'invite', playerId: String(1000 + n) });
    }
    expect(codeOf(act(lobby, HOST, { type: 'invite', playerId: '5000' }))).toBe('invite_limit');
  });

  test('Revoke takes the invite, not the seat; Kick takes both', TAGS, () => {
    let lobby = inviteOnly();
    lobby = after(lobby, HOST, { type: 'invite', playerId: '2' });
    lobby = after(lobby, actor('2'), join);
    expect(codeOf(act(lobby, HOST, { type: 'revoke_invite', playerId: '3' }))).toBe('not_invited');
    const revoked = after(lobby, HOST, { type: 'revoke_invite', playerId: '2' });
    expect(revoked.players.map((p) => p.playerId)).toContain('2');
    const gone = after(revoked, actor('2'), { type: 'leave' });
    expect(codeOf(act(gone, actor('2'), join))).toBe('invite_only');

    const kicked = after(lobby, HOST, { type: 'kick', playerId: '2' });
    expect(kicked.invited).not.toContain('2');
    expect(codeOf(act(kicked, actor('2'), join))).toBe('invite_only');
  });

  test('Everyone again keeps the list for the next time', TAGS, () => {
    const lobby = after(inviteOnly(), HOST, { type: 'invite', playerId: '2' });
    const open = after(lobby, HOST, { type: 'set_settings', visibility: 'open' });
    expect(open.invited).toContain('2');
    expect(codeOf(act(open, actor('3'), join))).toBe('ok');
  });
});

test.describe('pickup invite link token', () => {
  const SECRET = 'a-test-secret-of-some-length';
  const NOW = 1_800_000_000;
  const link = { lobbyId: fresh().id, makerId: '1', maker: 'host' as const };

  test('names its lobby and maker until it runs out', TAGS, () => {
    const token = signInviteToken(SECRET, link, NOW);
    expect(looksLikeInviteToken(token)).toBe(true);
    expect(verifyInviteToken(SECRET, token, NOW)).toEqual(link);
    expect(verifyInviteToken(SECRET, token, NOW + INVITE_LINK_SECONDS)).toBeNull();
    const admins = signInviteToken(SECRET, { ...link, maker: 'admin' }, NOW);
    expect(verifyInviteToken(SECRET, admins, NOW)?.maker).toBe('admin');
  });

  test('a changed token, another secret or another purpose is refused', TAGS, () => {
    const token = signInviteToken(SECRET, link, NOW);
    const parts = token.split('.');
    const changed = (index: number, value: string) =>
      parts.map((part, i) => (i === index ? value : part)).join('.');
    expect(verifyInviteToken('another-secret', token, NOW)).toBeNull();
    expect(
      verifyInviteToken(SECRET, changed(1, '1f8fad5b-d9cb-469f-a165-70867728950e'), NOW)
    ).toBeNull();
    expect(verifyInviteToken(SECRET, changed(2, '2'), NOW)).toBeNull();
    expect(verifyInviteToken(SECRET, changed(3, 'a'), NOW)).toBeNull();
    expect(verifyInviteToken(SECRET, changed(4, String(NOW * 2)), NOW)).toBeNull();
    expect(verifyInviteToken(SECRET, changed(0, 'pickup-activity'), NOW)).toBeNull();
    expect(verifyInviteToken(SECRET, 'nonsense', NOW)).toBeNull();
  });
});
