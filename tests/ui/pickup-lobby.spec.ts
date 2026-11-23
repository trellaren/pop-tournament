import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { signInAsPlayer, signInAsPlayerViaRequest, signInViaRequest } from '../helpers/auth';
import { BASE_URL, TAGS, type LobbyBody, type PickupFixture } from './pickup/fixture';
import { invitesTests } from './pickup/invites';
import { wingmanTests } from './pickup/wingman';

/**
 * Pickup lobby (docs/design/pickup-lobby.md; the pure rules are in
 * tests/api/pickup-rules.spec.ts): a lobby end to end with real player sessions: open, sides, the waiting room,
 * the host's controls, the log and close; then the page, with two browsers.
 * One file, one serial run: only one lobby can be open at a time.
 *
 * @tag ui
 * @tag pickup
 */

/** Save a screenshot when PICKUP_SCREENSHOTS names a folder. */
async function shot(page: Page, name: string): Promise<void> {
  const folder = process.env.PICKUP_SCREENSHOTS;
  if (folder) await page.screenshot({ path: `${folder}/pickup-${name}.png`, fullPage: true });
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
    await closeOpenLobby();
  });

  /** Close whatever lobby is open (one a failed run left behind, or this run's own). */
  const closeOpenLobby = async () => {
    const list = (await (await contexts[0].get('/api/pickup')).json()) as {
      lobbies: Array<{ id: string; hostId: string }>;
    };
    for (const open of list.lobbies) {
      const host = contexts[Math.max(steamIds.indexOf(open.hostId), 0)];
      const act = async (type: string) => {
        const body = (await (await host.get(`/api/pickup/${open.id}`)).json()) as LobbyBody;
        await host.post(`/api/pickup/${open.id}/commands`, {
          data: { type, version: body.lobby.version },
        });
      };
      // A draft, ready check, vote or match is cancelled first; then the lobby closes.
      await act('cancel');
      await act('close');
    }
  };

  test.afterAll(async () => {
    await closeOpenLobby();
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
  });

  test('captain draft: captains pick in turn and the teams lock', TAGS, async () => {
    // Player 3 hosts on Team A; players 1 and 2 are to pick.
    expect((await send(0, { type: 'join', side: null })).ok()).toBe(true);
    expect((await send(1, { type: 'join', side: null })).ok()).toBe(true);
    let lobby = await view(2);
    const draft = {
      type: 'start_draft',
      method: 'host',
      captainA: steamIds[2],
      captainB: steamIds[0],
      version: lobby.version,
    };
    expect((await send(0, draft)).status()).toBe(403);
    expect((await send(2, draft)).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.state).toBe('drafting');
    expect(lobby.draft?.turn).toBe('a');
    expect(lobby.draft?.pool.map((p) => p.playerId)).toEqual([steamIds[1]]);
    expect(lobby.can.pick).toBe(false);
    const early = await send(0, { type: 'pick', playerId: steamIds[1] });
    expect(((await early.json()) as { code: string }).code).toBe('not_your_turn');
    expect((await send(2, { type: 'pick', playerId: steamIds[1] })).ok()).toBe(true);

    lobby = await view(2);
    expect(lobby.state).toBe('gathering');
    expect(lobby.teamsLocked).toBe(true);
    expect(lobby.teams.a.map((p) => p.playerId).sort()).toEqual([steamIds[1], steamIds[2]].sort());
    expect(lobby.teams.b.map((p) => p.playerId)).toEqual([steamIds[0]]);
    const types = lobby.log.map((line) => line.type);
    for (const type of ['draft_started', 'picked', 'draft_finished']) {
      expect(types).toContain(type);
    }

    // Back to the host alone, teams open, for the next test.
    expect((await send(2, { type: 'lock_teams', locked: false })).ok()).toBe(true);
    expect((await send(0, { type: 'leave' })).ok()).toBe(true);
    expect((await send(1, { type: 'leave' })).ok()).toBe(true);
  });

  test('the map: a vote in the lobby, then a veto on the match', TAGS, async () => {
    expect((await send(2, { type: 'set_settings', teamSize: 1, mapMethod: 'vote' })).ok()).toBe(
      true
    );
    expect((await send(0, { type: 'join', side: 'b' })).ok()).toBe(true);
    let lobby = await view(2);
    const map = lobby.maps[0].id;
    expect((await send(2, { type: 'start', version: lobby.version })).ok()).toBe(true);
    expect((await send(0, { type: 'ready' })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.state).toBe('map_vote');
    expect(lobby.can.vote_map).toBe(true);
    expect((await send(0, { type: 'vote_map', map: 'de_no_such_map' })).status()).toBe(409);
    expect((await send(0, { type: 'vote_map', map })).ok()).toBe(true);
    expect((await view(2)).vote).toMatchObject({ counts: { [map]: 1 }, voted: 1, voters: 2 });
    expect((await send(2, { type: 'vote_map', map })).ok()).toBe(true);
    lobby = await view(2);
    expect(lobby.state).toBe('in_match');
    expect(lobby.match?.map).toBe(map);
    expect(lobby.match?.vetoing).toBe(false);
    expect((await send(2, { type: 'cancel', version: lobby.version })).ok()).toBe(true);

    // Veto: the match is made with the whole pool and the teams choose on its page.
    expect((await send(2, { type: 'set_settings', mapMethod: 'veto' })).ok()).toBe(true);
    lobby = await view(2);
    expect((await send(2, { type: 'start', version: lobby.version })).ok()).toBe(true);
    expect((await send(0, { type: 'ready' })).ok()).toBe(true);
    lobby = await view(2);
    expect(lobby.state).toBe('in_match');
    expect(lobby.match?.vetoing).toBe(true);
    expect(lobby.match?.map).toBeNull();
    expect((await send(2, { type: 'cancel', version: lobby.version })).ok()).toBe(true);

    // Back to the host alone at 5v5 with the host's pick, for the next test.
    expect((await send(0, { type: 'leave' })).ok()).toBe(true);
    expect((await send(2, { type: 'set_settings', teamSize: 5, mapMethod: 'pick' })).ok()).toBe(
      true
    );
  });

  test('Start: the ready check, a match on the platform, its result', TAGS, async () => {
    const admin = await playwrightRequest.newContext({ baseURL: BASE_URL });
    expect(await signInViaRequest(admin)).toBe(true);

    // A 1v1: player 3 hosts on Team A, player 1 on Team B.
    expect((await send(2, { type: 'set_settings', teamSize: 1 })).ok()).toBe(true);
    const early = await send(2, { type: 'start', version: (await view(2)).version });
    expect(((await early.json()) as { code: string }).code).toBe('teams_not_full');
    expect((await send(0, { type: 'join', side: 'b' })).ok()).toBe(true);
    let lobby = await view(2);
    expect(lobby.maps.length).toBeGreaterThan(0);
    // An earlier test may have left a map picked: the team size no longer forgets it.
    const map = (lobby.maps.find((m) => m.id !== lobby.pickedMap) ?? lobby.maps[0]).id;
    expect((await send(2, { type: 'pick_map', map: 'de_no_such_map' })).status()).toBe(409);
    expect((await send(2, { type: 'pick_map', map })).ok()).toBe(true);

    lobby = await view(2);
    expect((await send(2, { type: 'start', version: lobby.version })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.state).toBe('ready_check');
    expect(lobby.deadline).not.toBeNull();
    expect(lobby.teams.a[0].ready).toBe(true);
    expect(lobby.can.ready).toBe(true);

    expect((await send(0, { type: 'ready' })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.state).toBe('in_match');
    const slug = lobby.match?.slug ?? '';
    expect(slug).toMatch(/^pu-[0-9a-f]{8}-\d+$/);
    expect(lobby.match?.map).toBe(map);
    const match = await admin.get(`/api/matches/${slug}`);
    expect(match.ok(), await match.text()).toBe(true);
    const leaving = await send(0, { type: 'leave' });
    expect(((await leaving.json()) as { code: string }).code).toBe('in_match');

    // Player 2 waits while the match runs; under "losing team" the loser makes way.
    expect((await send(1, { type: 'join', side: null })).ok()).toBe(true);
    expect((await send(2, { type: 'set_settings', rollOut: 'bogus' })).status()).toBe(400);

    // Team B wins: the lobby gathers again, and the longest waiter rolls in.
    const end = { slug, result: { winner: 'team2', team1Score: 0, team2Score: 1, games: [] } };
    expect((await admin.post('/api/test/series-result', { data: end })).ok()).toBe(true);
    await expect.poll(async () => (await view(2)).state).toBe('gathering');
    lobby = await view(2);
    expect(lobby.match).toBeNull();
    const ended = lobby.log.find((line) => line.type === 'match_ended');
    expect(ended?.data.winner).toBe('b');
    const seatedNow = [...lobby.teams.a, ...lobby.teams.b].map((p) => p.playerId);
    expect(seatedNow).toHaveLength(2);
    expect(seatedNow).toContain(steamIds[1]);
    expect(lobby.waiting).toHaveLength(1);
    const types = lobby.log.map((line) => line.type);
    expect(types).toContain('rolled_out');
    expect(types).toContain('rolled_in');
    const stayed = [...lobby.teams.a, ...lobby.teams.b].find((p) => p.playerId !== steamIds[1]);
    expect(stayed?.gamesInRow).toBe(1);

    // Roll-out by hand puts the newcomer back in the waiting room and the waiter back in.
    expect(
      (await send(2, { type: 'roll_out', playerId: steamIds[1], version: lobby.version })).ok()
    ).toBe(true);
    expect((await send(1, { type: 'leave' })).ok()).toBe(true);
    expect((await send(2, { type: 'set_settings', rollOut: 'losers' })).ok()).toBe(true);
    lobby = await view(2);
    expect(lobby.settings.rollOut).toBe('losers');
    expect(lobby.waiting).toHaveLength(0);
    expect([...lobby.teams.a, ...lobby.teams.b].map((p) => p.playerId).sort()).toEqual(
      [steamIds[0], steamIds[2]].sort()
    );

    // A second match, cancelled by the host: the platform's match is cancelled too.
    expect((await send(2, { type: 'start', version: lobby.version })).ok()).toBe(true);
    lobby = await view(2);
    const unready = [...lobby.teams.a, ...lobby.teams.b].find((p) => !p.ready);
    expect((await send(steamIds.indexOf(unready?.playerId ?? ''), { type: 'ready' })).ok()).toBe(
      true
    );
    lobby = await view(2);
    const second = lobby.match?.slug ?? '';
    expect(second).not.toBe(slug);
    expect((await send(2, { type: 'cancel', version: lobby.version })).ok()).toBe(true);
    lobby = await view(2);
    expect(lobby.state).toBe('gathering');
    await expect
      .poll(async () => {
        const row = (await (await admin.get(`/api/matches/${second}`)).json()) as {
          match?: { status?: string };
        };
        return row.match?.status;
      })
      .toBe('cancelled');

    expect((await send(2, { type: 'close', version: lobby.version })).ok()).toBe(true);
    await admin.dispose();
  });

  const fixture: PickupFixture = {
    steamIds,
    contexts,
    view,
    send,
    open: async (who) => {
      const opened = await contexts[who].post('/api/pickup', { data: {} });
      expect(opened.ok(), await opened.text()).toBe(true);
      lobbyId = ((await opened.json()) as { id: string }).id;
    },
  };
  wingmanTests(fixture);
  invitesTests(fixture);

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
    await shot(host, 'lobby');

    // A 1v1, so the two of them fill both teams: Start, Ready, the match, Cancel.
    const sized = await host.request.post(`/api/pickup/${lobbyId}/commands`, {
      data: { type: 'set_settings', teamSize: 1 },
    });
    expect(sized.ok()).toBe(true);
    await host.getByTestId('pickup-start').click();
    await expect(guest.getByTestId('pickup-ready-check')).toBeVisible();
    await shot(guest, 'ready-check');
    await guest.getByTestId('pickup-ready').click();
    await expect(host.getByTestId('pickup-match')).toContainText('Match 1');
    await expect(guest.getByTestId('pickup-open-match')).toBeVisible();
    await shot(host, 'match');
    await host.getByTestId('pickup-cancel').click();
    await expect(host.getByTestId('pickup-log')).toContainText('Match 1 was cancelled');
    await expect(guest.getByTestId('pickup-match')).toHaveCount(0);

    await host.getByTestId('pickup-close').click();
    await expect(guest.getByText('This lobby is closed')).toBeVisible();
    await hostContext.close();
    await guestContext.close();
  });
});
