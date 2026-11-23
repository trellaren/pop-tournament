import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from '@playwright/test';
import {
  allowed,
  balancedSplit,
  decide,
  newLobby,
  seated,
  shuffled,
  waiting,
  type Actor,
  type Command,
  type Lobby,
  type Outcome,
  type Side,
} from '../../api/src/services/pickup/rules';
import { signInAsPlayer, signInAsPlayerViaRequest } from '../helpers/auth';

/**
 * Pickup lobby, step 1 (docs/design/pickup-lobby.md): the pure rules, then a
 * lobby end to end with real player sessions: open, sides, the waiting room,
 * the host's controls, the log and close; then the page, with two browsers.
 * One file, one serial run: only one lobby can be open at a time.
 *
 * @tag ui
 * @tag pickup
 */

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3069';
const TAGS = { tag: ['@ui', '@pickup'] };

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

interface LobbyBody {
  lobby: {
    id: string;
    state: string;
    version: number;
    hostId: string;
    teamsLocked: boolean;
    settings: { teamSize: number };
    teams: Record<Side, Array<{ playerId: string; name: string; isHost: boolean }>>;
    waiting: Array<{ playerId: string }>;
    log: Array<{ type: string }>;
    me: string | null;
    can: Record<string, boolean>;
  };
}

test.describe.serial('pickup lobby', () => {
  const steamIds = ['76561198700000001', '76561198700000002', '76561198700000003'];
  const contexts: APIRequestContext[] = [];
  let lobbyId = '';

  const view = async (who: number) => {
    const response = await contexts[who].get(`/api/pickup/${lobbyId}`);
    expect(response.ok()).toBe(true);
    return ((await response.json()) as LobbyBody).lobby;
  };
  const send = (who: number, data: object) =>
    contexts[who].post(`/api/pickup/${lobbyId}/commands`, { data });

  test.beforeAll(async () => {
    for (const [index, steamId] of steamIds.entries()) {
      const context = await playwrightRequest.newContext({ baseURL: BASE_URL });
      expect(await signInAsPlayerViaRequest(context, steamId, `Pickup ${index + 1}`)).toBe(true);
      contexts.push(context);
    }
  });

  test.afterAll(async () => {
    if (lobbyId) {
      const lobby = await view(0).catch(() => null);
      if (lobby && lobby.state !== 'closed') {
        const host = steamIds.indexOf(lobby.hostId);
        await send(Math.max(host, 0), { type: 'close', version: lobby.version });
      }
    }
    await Promise.all(contexts.map((context) => context.dispose()));
  });

  test('signed-out visitors are refused', TAGS, async () => {
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
    expect((await anonymous.get('/api/pickup')).status()).toBe(401);
    expect((await anonymous.post('/api/pickup', { data: {} })).status()).toBe(401);
    await anonymous.dispose();
  });

  test('a player opens the lobby and is its host; a second lobby is refused', TAGS, async () => {
    const opened = await contexts[0].post('/api/pickup', { data: {} });
    expect(opened.ok()).toBe(true);
    lobbyId = ((await opened.json()) as { id: string }).id;

    const lobby = await view(0);
    expect(lobby.hostId).toBe(steamIds[0]);
    expect(lobby.teams.a.map((p) => p.playerId)).toEqual([steamIds[0]]);
    expect(lobby.teams.a[0].name).toBe('Pickup 1');
    expect(lobby.me).toBe('a');
    expect(lobby.can.close).toBe(true);

    const second = await contexts[1].post('/api/pickup', { data: {} });
    expect(second.status()).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('lobby_exists');

    const list = (await (await contexts[1].get('/api/pickup')).json()) as {
      lobbies: Array<{ id: string; seated: number }>;
      mine: string | null;
    };
    expect(list.lobbies.map((l) => l.id)).toContain(lobbyId);
    expect(list.mine).toBeNull();
  });

  test('others join a side or the waiting room and switch', TAGS, async () => {
    expect((await send(1, { type: 'join', side: 'b' })).ok()).toBe(true);
    expect((await send(2, { type: 'join', side: null })).ok()).toBe(true);
    let lobby = await view(1);
    expect(lobby.teams.b.map((p) => p.playerId)).toEqual([steamIds[1]]);
    expect(lobby.waiting.map((p) => p.playerId)).toEqual([steamIds[2]]);
    expect(lobby.me).toBe('b');
    expect(lobby.can.close).toBe(false);

    expect((await send(2, { type: 'join', side: 'a' })).ok()).toBe(true);
    lobby = await view(2);
    expect(lobby.teams.a.map((p) => p.playerId)).toEqual([steamIds[0], steamIds[2]]);
  });

  test("only the host uses the host's controls", TAGS, async () => {
    const lobby = await view(1);
    const refused = await send(1, { type: 'scramble', version: lobby.version });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('not_allowed');

    const stale = await send(0, { type: 'scramble', version: lobby.version - 1 });
    expect(stale.status()).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe('stale');

    expect((await send(0, { type: 'scramble', version: lobby.version })).ok()).toBe(true);
    const after = await view(0);
    expect(after.teams.a.length + after.teams.b.length).toBe(3);
    expect((await send(0, { type: 'balance', version: after.version })).ok()).toBe(true);
  });

  test('lock, move, team size, make host and kick', TAGS, async () => {
    expect((await send(0, { type: 'lock_teams', locked: true })).ok()).toBe(true);
    const locked = await send(1, { type: 'join', side: null });
    expect(((await locked.json()) as { code: string }).code).toBe('teams_locked');

    expect((await send(0, { type: 'move', playerId: steamIds[1], side: null })).ok()).toBe(true);
    expect((await view(0)).waiting.map((p) => p.playerId)).toContain(steamIds[1]);

    const tooSmall = await send(0, { type: 'set_settings', teamSize: 9 });
    expect(((await tooSmall.json()) as { code: string }).code).toBe('invalid_settings');
    expect((await send(0, { type: 'set_settings', teamSize: 2 })).ok()).toBe(true);
    expect((await view(0)).settings.teamSize).toBe(2);

    expect((await send(0, { type: 'make_host', playerId: steamIds[1] })).ok()).toBe(true);
    expect((await view(1)).can.close).toBe(true);
    expect((await send(1, { type: 'kick', playerId: steamIds[2] })).ok()).toBe(true);
    const lobby = await view(1);
    const everyone = [...lobby.teams.a, ...lobby.teams.b, ...lobby.waiting].map((p) => p.playerId);
    expect(everyone.sort()).toEqual([steamIds[0], steamIds[1]].sort());
    expect((await view(2)).me).toBeNull();
  });

  test('bad commands are refused', TAGS, async () => {
    expect((await send(1, { type: 'dance' })).status()).toBe(400);
    expect((await send(1, { type: 'join', side: 'c' })).status()).toBe(400);
    expect((await send(1, { type: 'kick' })).status()).toBe(400);
    expect((await contexts[0].get('/api/pickup/no-such-lobby')).status()).toBe(404);
  });

  test('the log tells the story, and closing ends the lobby', TAGS, async () => {
    const lobby = await view(1);
    const types = lobby.log.map((line) => line.type);
    for (const type of ['opened', 'joined', 'scrambled', 'balanced', 'teams_locked', 'kicked']) {
      expect(types).toContain(type);
    }
    expect((await send(1, { type: 'close', version: lobby.version })).ok()).toBe(true);
    expect((await view(1)).state).toBe('closed');
    const after = await send(0, { type: 'join', side: 'a' });
    expect(((await after.json()) as { code: string }).code).toBe('closed');

    const reopened = await contexts[2].post('/api/pickup', { data: {} });
    expect(reopened.ok()).toBe(true);
    lobbyId = ((await reopened.json()) as { id: string }).id;
    const fresh = await view(2);
    expect((await send(2, { type: 'close', version: fresh.version })).ok()).toBe(true);
  });

  test('the page: open, join from a second browser, scramble, close', TAGS, async ({ browser }) => {
    const hostContext = await browser.newContext({ baseURL: BASE_URL });
    const guestContext = await browser.newContext({ baseURL: BASE_URL });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    expect(await signInAsPlayer(host, steamIds[0], 'Pickup 1')).toBe(true);
    expect(await signInAsPlayer(guest, steamIds[1], 'Pickup 2')).toBe(true);

    await host.goto('/pickup');
    await host.getByTestId('pickup-open').click();
    await expect(host.getByTestId('pickup-lobby-page')).toBeVisible();
    await expect(host.getByTestId('pickup-a')).toContainText('Pickup 1');
    lobbyId = host.url().split('/pickup/')[1];

    await guest.goto('/pickup');
    await guest.getByTestId('pickup-view').click();
    await guest.getByTestId('pickup-join-b').click();
    await expect(guest.getByTestId('pickup-b')).toContainText('Pickup 2');
    // The host's page follows without a reload.
    await expect(host.getByTestId('pickup-b')).toContainText('Pickup 2');
    await expect(guest.getByTestId('pickup-scramble')).toHaveCount(0);

    await host.getByTestId('pickup-scramble').click();
    await expect(host.getByTestId('pickup-log')).toContainText('scrambled the teams');
    if (process.env.PICKUP_SCREENSHOTS) {
      await host.screenshot({
        path: `${process.env.PICKUP_SCREENSHOTS}/lobby.png`,
        fullPage: true,
      });
    }

    await host.getByTestId('pickup-close').click();
    await expect(guest.getByText('This lobby is closed')).toBeVisible();
    await hostContext.close();
    await guestContext.close();
  });
});
