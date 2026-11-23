import { test, expect, request as playwrightRequest } from '@playwright/test';
import { signInAsPlayer, signInViaRequest } from '../../helpers/auth';
import { BASE_URL, TAGS, type PickupFixture } from './fixture';

interface MatchBody {
  match?: { config?: { team1?: { players?: object }; team2?: { players?: object } } };
}

/** Mid-match substitution end to end: the lobby, the platform's match, and the page. */
export function substitutionTests({ steamIds, view, send, open }: PickupFixture): void {
  test(
    'Substitution: a waiter comes in for a player of the running match',
    TAGS,
    async ({ browser }) => {
      const admin = await playwrightRequest.newContext({ baseURL: BASE_URL });
      expect(await signInViaRequest(admin)).toBe(true);
      const roster = async (slug: string) => {
        const body = (await (await admin.get(`/api/matches/${slug}`)).json()) as MatchBody;
        // The API gives a team's players as a list of { steamid } or as a map keyed by id.
        const ids = (team: { players?: object } | undefined) => {
          const players = team?.players ?? {};
          return Array.isArray(players)
            ? (players as Array<{ steamid?: string; steamId?: string }>).map(
                (p) => p.steamid ?? p.steamId ?? ''
              )
            : Object.keys(players);
        };
        return { a: ids(body.match?.config?.team1), b: ids(body.match?.config?.team2) };
      };

      // A 1v1: player 1 on Team A, player 2 on Team B, player 3 waiting.
      await open(0);
      expect((await send(0, { type: 'set_settings', teamSize: 1 })).ok()).toBe(true);
      expect((await send(1, { type: 'join', side: 'b' })).ok()).toBe(true);
      expect((await send(2, { type: 'join', side: null })).ok()).toBe(true);
      let lobby = await view(0);
      expect(lobby.can.substitute).toBe(false);
      expect((await send(0, { type: 'start', version: lobby.version })).ok()).toBe(true);
      expect((await send(1, { type: 'ready' })).ok()).toBe(true);
      lobby = await view(0);
      const slug = lobby.match?.slug ?? '';
      expect(lobby.substitutes).toEqual([steamIds[2]]);
      expect(lobby.can.substitute).toBe(true);
      expect((await view(1)).can.substitute).toBe(false);
      expect(await roster(slug)).toEqual({ a: [steamIds[0]], b: [steamIds[1]] });

      const swap = { type: 'substitute', outId: steamIds[1], inId: steamIds[2] };
      expect((await send(1, { ...swap, version: lobby.version })).status()).toBe(403);
      expect((await send(0, swap)).status()).toBe(409);
      expect((await send(0, { ...swap, version: lobby.version })).ok()).toBe(true);

      lobby = await view(0);
      expect(lobby.teams.b.map((p) => p.playerId)).toEqual([steamIds[2]]);
      expect(lobby.waiting.map((p) => p.playerId)).toEqual([steamIds[1]]);
      expect(lobby.leavers.map((p) => p.playerId)).toEqual([steamIds[1]]);
      expect(lobby.substitutes).toEqual([]);
      // The platform's match follows: it has no server yet, so its config carries the new roster.
      await expect.poll(async () => roster(slug)).toEqual({ a: [steamIds[0]], b: [steamIds[2]] });
      expect((await view(0)).subFailed).toBeNull();
      const back = { type: 'substitute', outId: steamIds[2], inId: steamIds[1] };
      const refused = await send(0, { ...back, version: lobby.version });
      expect(((await refused.json()) as { code: string }).code).toBe('already_subbed_out');

      // The page shows who left; the host has nobody left to bring in.
      const hostContext = await browser.newContext({ baseURL: BASE_URL });
      const host = await hostContext.newPage();
      expect(await signInAsPlayer(host, steamIds[0], 'Pickup 1')).toBe(true);
      await host.goto(`/pickup/${lobby.id}`);
      await expect(host.getByTestId('pickup-substitute')).toContainText(
        'Left this match: Pickup 2'
      );
      await expect(host.getByTestId('pickup-log')).toContainText(
        'brought Pickup 3 in for Pickup 2'
      );
      await expect(host.getByTestId('pickup-sub-go')).toHaveCount(0);
      await hostContext.close();

      expect((await send(0, { type: 'cancel', version: lobby.version })).ok()).toBe(true);
      lobby = await view(0);
      expect(lobby.leavers).toEqual([]);
      expect((await send(0, { type: 'close', version: lobby.version })).ok()).toBe(true);
      await admin.dispose();
    }
  );
}
