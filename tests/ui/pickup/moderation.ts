import { test, expect, request as playwrightRequest } from '@playwright/test';
import { signIn, signInAsPlayer, signInViaRequest } from '../../helpers/auth';
import { BASE_URL, TAGS, type PickupFixture } from './fixture';

/** Moderators, bans from pickup, the multiplier and display names, end to end. */
export function moderationTests({ steamIds, contexts, view, send, open }: PickupFixture): void {
  const code = async (response: { json: () => Promise<unknown> }) =>
    ((await response.json()) as { code?: string }).code;

  test(
    'Moderation: a moderator, a ban with its end, the admin-only settings',
    TAGS,
    async ({ browser }) => {
      const admin = await playwrightRequest.newContext({ baseURL: BASE_URL });
      expect(await signInViaRequest(admin)).toBe(true);
      const [, p2, p3] = steamIds;

      // Players are not moderators: they see nothing and change nothing.
      expect((await contexts[1].get('/api/pickup/admin')).status()).toBe(403);
      const early = await contexts[1].put(`/api/pickup/admin/bans/${p3}`, {
        data: { length: null },
      });
      expect(early.status()).toBe(403);

      // An admin makes player 2 a moderator; a moderator cannot make another.
      const made = await admin.put(`/api/pickup/admin/moderators/${p2}`, { data: { on: true } });
      expect(made.ok(), await made.text()).toBe(true);
      const more = await contexts[1].put(`/api/pickup/admin/moderators/${p3}`, {
        data: { on: true },
      });
      expect(more.status()).toBe(403);

      // The moderator runs player 1's lobby without being its host.
      await open(0);
      expect((await send(2, { type: 'join', side: 'b' })).ok()).toBe(true);
      let lobby = await view(1);
      expect(lobby.mayBan).toBe(true);
      expect(lobby.can.kick).toBe(true);
      expect((await view(2)).mayBan).toBe(false);

      // A ban: a length out of range is refused; a good one removes the player from the lobby.
      const bad = await contexts[1].put(`/api/pickup/admin/bans/${p3}`, { data: { length: 60 } });
      expect(bad.status()).toBe(400);
      const banned = await contexts[1].put(`/api/pickup/admin/bans/${p3}`, {
        data: { length: 3600, reason: 'a reason for moderators' },
      });
      expect(banned.ok(), await banned.text()).toBe(true);
      lobby = await view(0);
      expect(lobby.teams.b).toEqual([]);
      expect(JSON.stringify(lobby)).not.toContain('a reason for moderators');

      // The banned player is told until when, never why; nobody can invite them.
      const refused = await send(2, { type: 'join', side: null });
      const body = (await refused.json()) as { code: string; until: number; error: string };
      expect(body.code).toBe('banned');
      expect(body.until).toBeGreaterThan(Date.now() / 1000 + 3000);
      expect(JSON.stringify(body)).not.toContain('a reason');
      expect(await code(await send(0, { type: 'invite', playerId: p3 }))).toBe('banned_player');

      // The moderator reads the ban with its reason, but not the admin's lists.
      const seen = (await (await contexts[1].get('/api/pickup/admin')).json()) as {
        bans: Array<{ playerId: string; reason: string | null }>;
        moderators: unknown;
        players: unknown;
      };
      expect(seen.bans).toEqual([
        expect.objectContaining({ playerId: p3, reason: 'a reason for moderators' }),
      ]);
      expect(seen.moderators).toBeNull();
      expect(seen.players).toBeNull();

      // Lifted: the player joins again.
      expect((await contexts[1].delete(`/api/pickup/admin/bans/${p3}`, { data: {} })).ok()).toBe(
        true
      );
      expect((await send(2, { type: 'join', side: 'b' })).ok()).toBe(true);

      // The multiplier and display names: admins only; the name shows, the multiplier nowhere.
      const denied = await contexts[1].put(`/api/pickup/admin/players/${p3}`, {
        data: { multiplier: 0.5 },
      });
      expect(denied.status()).toBe(403);
      const outOfRange = await admin.put(`/api/pickup/admin/players/${p3}`, {
        data: { multiplier: 1.5 },
      });
      expect(outOfRange.status()).toBe(400);
      const set = await admin.put(`/api/pickup/admin/players/${p3}`, {
        data: { multiplier: 0.5, displayNames: ['Scribbles'] },
      });
      expect(set.ok(), await set.text()).toBe(true);
      lobby = await view(0);
      expect(lobby.teams.b[0].name).toBe('Scribbles');
      expect(JSON.stringify(lobby)).not.toContain('multiplier');
      const full = (await (await admin.get('/api/pickup/admin')).json()) as {
        moderators: Array<{ playerId: string }>;
        players: Array<{ playerId: string; multiplier: number | null; displayNames: string[] }>;
      };
      expect(full.moderators.map((m) => m.playerId)).toEqual([p2]);
      expect(full.players).toEqual([
        expect.objectContaining({ playerId: p3, multiplier: 0.5, displayNames: ['Scribbles'] }),
      ]);

      // The page: a moderator has Ban on a row, and the dialog bans.
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      expect(await signInAsPlayer(page, p2, 'Pickup 2')).toBe(true);
      await page.goto(`/pickup/${lobby.id}`);
      await page.getByTestId(`pickup-ban-${p3}`).click();
      await page.getByTestId('pickup-ban-reason').fill('from the page');
      await page.getByTestId('pickup-ban-confirm').click();
      await expect(page.getByTestId('pickup-b')).not.toContainText('Scribbles');
      await context.close();

      // Put everything back for the tests after this one.
      expect((await admin.delete(`/api/pickup/admin/bans/${p3}`, { data: {} })).ok()).toBe(true);
      const cleared = await admin.put(`/api/pickup/admin/players/${p3}`, {
        data: { multiplier: null, displayNames: [] },
      });
      expect(cleared.ok()).toBe(true);
      const unmade = await admin.put(`/api/pickup/admin/moderators/${p2}`, { data: { on: false } });
      expect(unmade.ok()).toBe(true);
      expect((await view(1)).mayBan).toBe(false);
      lobby = await view(0);
      expect((await send(0, { type: 'close', version: lobby.version })).ok()).toBe(true);
      await admin.dispose();
    }
  );

  test(
    'the moderation page: a moderator, a ban lifted, a multiplier and a name',
    TAGS,
    async ({ browser }) => {
      const [, p2, p3] = steamIds;
      const context = await browser.newContext({ baseURL: BASE_URL });
      const page = await context.newPage();
      expect(await signIn(page)).toBe(true);

      await page.goto('/pickup');
      await page.getByTestId('pickup-moderate').click();
      await expect(page.getByTestId('pickup-moderation-page')).toBeVisible();
      const pick = async (testId: string, name: string) => {
        await page.getByTestId(testId).fill(name);
        await page.getByRole('option', { name }).first().click();
      };

      // A moderator, made and seen by the admin.
      await pick('pickup-mod-moderator-player', 'Pickup 2');
      await page.getByTestId('pickup-mod-moderator-add').click();
      await expect(page.getByTestId(`pickup-mod-moderator-${p2}`)).toBeVisible();

      // The moderator sees the bans, and neither the moderators nor the multipliers.
      const modContext = await browser.newContext({ baseURL: BASE_URL });
      const mod = await modContext.newPage();
      expect(await signInAsPlayer(mod, p2, 'Pickup 2')).toBe(true);
      await mod.goto('/pickup/moderation');
      await expect(mod.getByTestId('pickup-mod-bans')).toBeVisible();
      await expect(mod.getByTestId('pickup-mod-moderators')).toHaveCount(0);
      await expect(mod.getByTestId('pickup-mod-players')).toHaveCount(0);

      // The moderator bans; the ban shows with its reason, and is lifted.
      await mod.getByTestId('pickup-mod-ban-player').fill('Pickup 3');
      await mod.getByRole('option', { name: 'Pickup 3' }).first().click();
      await mod.getByTestId('pickup-mod-ban').click();
      await mod.getByTestId('pickup-ban-reason').fill('page reason');
      await mod.getByTestId('pickup-ban-confirm').click();
      await expect(mod.getByTestId(`pickup-mod-banned-${p3}`)).toContainText('page reason');
      await mod.getByTestId(`pickup-mod-lift-${p3}`).click();
      await expect(mod.getByTestId(`pickup-mod-banned-${p3}`)).toHaveCount(0);
      await modContext.close();

      // Someone who is neither is told so.
      const otherContext = await browser.newContext({ baseURL: BASE_URL });
      const other = await otherContext.newPage();
      expect(await signInAsPlayer(other, p3, 'Pickup 3')).toBe(true);
      await other.goto('/pickup');
      await expect(other.getByTestId('pickup-page')).toBeVisible();
      await expect(other.getByTestId('pickup-moderate')).toHaveCount(0);
      await other.goto('/pickup/moderation');
      await expect(other.getByText('For moderators')).toBeVisible();
      await otherContext.close();

      // A multiplier and display names, saved and cleared.
      await page.reload();
      await pick('pickup-mod-setting-player', 'Pickup 3');
      const row = page.getByTestId(`pickup-mod-player-${p3}`);
      await row.getByTestId('pickup-mod-multiplier').fill('0.6');
      await row.getByTestId('pickup-mod-names').fill('Scribbles, Scrabble');
      await row.getByTestId('pickup-mod-player-save').click();
      await expect
        .poll(async () => {
          const body = (await (await page.request.get('/api/pickup/admin')).json()) as {
            players: Array<{ playerId: string; multiplier: number | null; displayNames: string[] }>;
          };
          return body.players.find((player) => player.playerId === p3) ?? null;
        })
        .toEqual(
          expect.objectContaining({ multiplier: 0.6, displayNames: ['Scribbles', 'Scrabble'] })
        );
      await page
        .getByTestId(`pickup-mod-player-${p3}`)
        .getByTestId('pickup-mod-player-clear')
        .click();
      await expect(page.getByTestId(`pickup-mod-player-${p3}`)).toHaveCount(0);

      // And the moderator is one no longer.
      await page.getByTestId(`pickup-mod-moderator-${p2}`).locator('svg').click();
      await expect(page.getByTestId(`pickup-mod-moderator-${p2}`)).toHaveCount(0);
      await context.close();
    }
  );
}
