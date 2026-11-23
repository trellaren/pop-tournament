import { test, expect, request as playwrightRequest } from '@playwright/test';
import { signInAsPlayer, signInViaRequest } from '../../helpers/auth';
import { BASE_URL, TAGS, type PickupFixture } from './fixture';

interface MatchBody {
  match?: { config?: { spectators?: { players?: object } } };
}

/** Spectate, and the practice and retakes servers, end to end. */
export function spectatorsTests({ steamIds, contexts, view, send, open }: PickupFixture): void {
  test("Spectate: a waiter goes on the match's spectator list", TAGS, async ({ browser }) => {
    const admin = await playwrightRequest.newContext({ baseURL: BASE_URL });
    expect(await signInViaRequest(admin)).toBe(true);
    const spectators = async (slug: string) => {
      const body = (await (await admin.get(`/api/matches/${slug}`)).json()) as MatchBody;
      const players = body.match?.config?.spectators?.players ?? {};
      return Array.isArray(players)
        ? (players as Array<{ steamid?: string }>).map((p) => p.steamid ?? '')
        : Object.keys(players);
    };
    const spectate = (who: number, id: string) =>
      contexts[who].post(`/api/pickup/${id}/spectate`, { data: {} });

    await open(0);
    expect((await send(0, { type: 'set_settings', teamSize: 1 })).ok()).toBe(true);
    expect((await send(1, { type: 'join', side: 'b' })).ok()).toBe(true);
    expect((await send(2, { type: 'join', side: null })).ok()).toBe(true);
    let lobby = await view(2);
    expect(lobby.maySpectate).toBe(false);
    expect((await spectate(2, lobby.id)).status()).toBe(409);

    expect((await send(0, { type: 'start', version: lobby.version })).ok()).toBe(true);
    expect((await send(1, { type: 'ready' })).ok()).toBe(true);
    lobby = await view(2);
    const slug = lobby.match?.slug ?? '';
    expect(lobby.maySpectate).toBe(true);
    expect((await view(0)).maySpectate).toBe(false);

    // A player of the match is refused; the waiter is listed. No server yet, so no address.
    const refused = await spectate(0, lobby.id);
    expect(((await refused.json()) as { code: string }).code).toBe('may_not_spectate');
    const listed = await spectate(2, lobby.id);
    expect(listed.ok(), await listed.text()).toBe(true);
    expect(listed.headers()['cache-control']).toBe('no-store');
    expect(((await listed.json()) as { connect: object | null }).connect).toBeNull();
    expect(await spectators(slug)).toEqual([steamIds[2]]);

    // The page: Spectate, and what it says while the match has no server.
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    expect(await signInAsPlayer(page, steamIds[2], 'Pickup 3')).toBe(true);
    await page.goto(`/pickup/${lobby.id}`);
    await page.getByTestId('pickup-spectate').click();
    await expect(page.getByTestId('pickup-spectate-box')).toContainText('no server yet');
    await context.close();

    // Leaving the lobby takes them off the list.
    expect((await send(2, { type: 'leave' })).ok()).toBe(true);
    await expect.poll(async () => spectators(slug)).toEqual([]);

    lobby = await view(0);
    expect((await send(0, { type: 'cancel', version: lobby.version })).ok()).toBe(true);
    lobby = await view(0);
    expect((await send(0, { type: 'close', version: lobby.version })).ok()).toBe(true);
    await admin.dispose();
  });

  test('practice and retakes servers: the list, and the page', TAGS, async ({ browser }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL });
    expect((await anonymous.get('/api/pickup/servers')).status()).toBe(401);
    await anonymous.dispose();
    const answer = await contexts[0].get('/api/pickup/servers');
    expect(answer.ok(), await answer.text()).toBe(true);
    // No fleet server is online in a test run.
    expect(await answer.json()).toMatchObject({ success: true, practice: [], retakes: [] });

    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    expect(await signInAsPlayer(page, steamIds[0], 'Pickup 1')).toBe(true);
    await page.goto('/pickup');
    await expect(page.getByTestId('pickup-servers-practice')).toContainText('None is online');
    await expect(page.getByTestId('pickup-servers-retakes')).toContainText('None is online');
    await context.close();
  });
}
