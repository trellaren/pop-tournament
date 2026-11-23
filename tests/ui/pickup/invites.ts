import { test, expect } from '@playwright/test';
import { signInAsPlayer } from '../../helpers/auth';
import { BASE_URL, TAGS, type PickupFixture } from './fixture';

/** Who can join, end to end: the setting, the list, an invite link, and the page. */
export function invitesTests({ steamIds, contexts, view, send, open }: PickupFixture): void {
  const code = async (response: Awaited<ReturnType<typeof send>>) =>
    ((await response.json()) as { code?: string }).code;

  test('Invited only: the list, a link, Revoke and Kick', TAGS, async () => {
    await open(0);
    let lobby = await view(0);
    expect(lobby.settings.visibility).toBe('open');
    expect((await send(0, { type: 'set_settings', visibility: 'everyone' })).status()).toBe(400);
    expect((await send(0, { type: 'set_settings', visibility: 'invite' })).ok()).toBe(true);

    // Seeing is not restricted: player 2 reads the lobby and is told they cannot join.
    lobby = await view(1);
    expect(lobby.settings.visibility).toBe('invite');
    expect(lobby.can.join).toBe(false);
    expect(lobby.invited).toEqual([]);
    expect(await code(await send(1, { type: 'join', side: null }))).toBe('invite_only');

    // Only the host invites; an unknown player cannot be invited.
    expect((await send(1, { type: 'invite', playerId: steamIds[2] })).status()).toBe(403);
    expect(await code(await send(0, { type: 'invite', playerId: '76561198799999999' }))).toBe(
      'unknown_player'
    );
    expect((await send(0, { type: 'invite', playerId: steamIds[1] })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.invited.map((p) => p.playerId)).toEqual([steamIds[0], steamIds[1]]);
    expect((await view(1)).can.join).toBe(true);
    expect((await send(1, { type: 'join', side: 'b' })).ok()).toBe(true);

    // A link: only the host makes one; it lets player 3 in and puts them on the list.
    const refusedLink = await contexts[1].post(`/api/pickup/${lobby.id}/invite-link`, { data: {} });
    expect(refusedLink.status()).toBe(403);
    const made = await contexts[0].post(`/api/pickup/${lobby.id}/invite-link`, { data: {} });
    expect(made.ok()).toBe(true);
    expect(made.headers()['cache-control']).toBe('no-store');
    const { token, path } = (await made.json()) as { token: string; path: string };
    expect(path).toBe(`/pickup/${lobby.id}?invite=${token}`);
    const forged = `${token.slice(0, -4)}AAAA`;
    expect(await code(await send(2, { type: 'join', side: null, invite: forged }))).toBe(
      'invite_link_invalid'
    );
    expect((await send(2, { type: 'join', side: null, invite: token })).ok()).toBe(true);
    lobby = await view(0);
    expect(lobby.invited.map((p) => p.playerId)).toContain(steamIds[2]);
    expect(JSON.stringify(lobby.log)).not.toContain(token);

    // Revoke keeps the seat but not the way back; Kick takes both.
    expect((await send(0, { type: 'revoke_invite', playerId: steamIds[2] })).ok()).toBe(true);
    expect((await send(2, { type: 'leave' })).ok()).toBe(true);
    expect(await code(await send(2, { type: 'join', side: null }))).toBe('invite_only');
    expect((await send(0, { type: 'kick', playerId: steamIds[1] })).ok()).toBe(true);
    expect(await code(await send(1, { type: 'join', side: null }))).toBe('invite_only');

    // A host's link ends when the host changes.
    expect((await send(2, { type: 'join', side: null, invite: token })).ok()).toBe(true);
    expect((await send(0, { type: 'make_host', playerId: steamIds[2] })).ok()).toBe(true);
    expect(await code(await send(1, { type: 'join', side: null, invite: token }))).toBe(
      'invite_link_invalid'
    );
    expect((await send(2, { type: 'make_host', playerId: steamIds[0] })).ok()).toBe(true);
    expect((await send(2, { type: 'leave' })).ok()).toBe(true);
  });

  test('the page: Invited only, the invites panel, joining by link', TAGS, async ({ browser }) => {
    const lobby = await view(0);
    const hostContext = await browser.newContext({ baseURL: BASE_URL });
    const guestContext = await browser.newContext({ baseURL: BASE_URL });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    expect(await signInAsPlayer(host, steamIds[0], 'Pickup 1')).toBe(true);
    expect(await signInAsPlayer(guest, steamIds[1], 'Pickup 2')).toBe(true);

    await host.goto(`/pickup/${lobby.id}`);
    await expect(host.getByTestId('pickup-invite-only')).toContainText('Invited players only');
    await expect(host.getByTestId('pickup-visibility')).toHaveValue('invite');
    await expect(host.getByTestId('pickup-invited')).toContainText('Pickup 1');

    await guest.goto(`/pickup/${lobby.id}`);
    await expect(guest.getByTestId('pickup-invite-only')).toContainText('Ask its host');
    await expect(guest.getByTestId('pickup-join-waiting')).toHaveCount(0);
    await expect(guest.getByTestId('pickup-invites')).toHaveCount(0);

    await host.getByTestId('pickup-invite-link').click();
    const shown = await host.getByTestId('pickup-invite-link-text').innerText();
    const address = shown.slice(shown.indexOf('http'));
    expect(address).toContain(`/pickup/${lobby.id}?invite=`);

    await guest.goto(address);
    await expect(guest).toHaveURL(new RegExp(`/pickup/${lobby.id}$`));
    await guest.getByTestId('pickup-join-b').click();
    await expect(guest.getByTestId('pickup-b')).toContainText('Pickup 2');
    await expect(host.getByTestId('pickup-invited')).toContainText('Pickup 2');

    await host.getByTestId(`pickup-invited-${steamIds[1]}`).locator('svg').click();
    await expect(host.getByTestId('pickup-log')).toContainText("took back Pickup 2's invite");

    await host.getByTestId('pickup-close').click();
    await expect(guest.getByText('This lobby is closed')).toBeVisible();
    await hostContext.close();
    await guestContext.close();
  });
}
