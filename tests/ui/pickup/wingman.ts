import { test, expect, request as playwrightRequest } from '@playwright/test';
import { signInViaRequest } from '../../helpers/auth';
import { BASE_URL, TAGS, type PickupFixture } from './fixture';

/** The Wingman format end to end: the setting, and the platform's match it makes. */
export function wingmanTests({ view, send, open }: PickupFixture): void {
  test('Wingman: 2v2 from the wingman maps, and a wingman match', TAGS, async () => {
    const admin = await playwrightRequest.newContext({ baseURL: BASE_URL });
    expect(await signInViaRequest(admin)).toBe(true);
    await open(0);
    const classicMaps = (await view(0)).maps.map((m) => m.id);

    expect((await send(0, { type: 'set_settings', format: 'duel' })).status()).toBe(400);
    expect((await send(0, { type: 'set_settings', format: 'wingman' })).ok()).toBe(true);
    let lobby = await view(0);
    expect(lobby.settings).toMatchObject({ format: 'wingman', teamSize: 2 });
    expect(lobby.maps.length).toBeGreaterThan(0);
    expect(lobby.maps.map((m) => m.id)).not.toEqual(classicMaps);
    const refused = await send(0, { type: 'set_settings', teamSize: 3 });
    expect(((await refused.json()) as { code: string }).code).toBe('invalid_settings');

    // One a side, so two players fill it.
    expect((await send(0, { type: 'set_settings', teamSize: 1 })).ok()).toBe(true);
    expect((await send(1, { type: 'join', side: 'b' })).ok()).toBe(true);
    lobby = await view(0);
    expect((await send(0, { type: 'start', version: lobby.version })).ok()).toBe(true);
    expect((await send(1, { type: 'ready' })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.state).toBe('in_match');
    const slug = lobby.match?.slug ?? '';
    const match = (await (await admin.get(`/api/matches/${slug}`)).json()) as {
      match?: { config?: { wingman?: boolean; players_per_team?: number; maxRounds?: number } };
    };
    expect(match.match?.config).toMatchObject({ wingman: true, players_per_team: 1 });
    expect(lobby.maps.map((m) => m.id)).toContain(lobby.match?.map);

    expect((await send(0, { type: 'cancel', version: lobby.version })).ok()).toBe(true);
    lobby = await view(0);
    expect((await send(0, { type: 'close', version: lobby.version })).ok()).toBe(true);
    await admin.dispose();
  });
}
