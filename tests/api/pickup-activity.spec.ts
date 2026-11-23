import { test, expect } from '@playwright/test';
import {
  ACTIVITY_TOKEN_SECONDS,
  bearerOf,
  signActivityToken,
  verifyActivityToken,
} from '../../api/src/services/pickup/activityToken';

/**
 * The pickup Activity's sign-in (docs/design/pickup-lobby.md): its token as a
 * pure function, and the routes while Discord sign-in is not set up. Discord
 * itself is not reachable from a test, so the code exchange is not exercised.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const SECRET = 'a-test-secret-of-some-length';
const PLAYER = '76561198000000001';
const NOW = 1_800_000_000;

test.describe('Pickup Activity token', TAGS, () => {
  test('names its player until it runs out', () => {
    const token = signActivityToken(SECRET, PLAYER, NOW);
    expect(verifyActivityToken(SECRET, token, NOW)).toBe(PLAYER);
    expect(verifyActivityToken(SECRET, token, NOW + ACTIVITY_TOKEN_SECONDS - 1)).toBe(PLAYER);
    expect(verifyActivityToken(SECRET, token, NOW + ACTIVITY_TOKEN_SECONDS)).toBeNull();
  });

  test('refuses a changed token, another secret and another purpose', () => {
    const token = signActivityToken(SECRET, PLAYER, NOW);
    const [purpose, , expires, signature] = token.split('.');
    expect(verifyActivityToken('another-secret', token, NOW)).toBeNull();
    expect(
      verifyActivityToken(SECRET, [purpose, '76561198000000002', expires, signature].join('.'), NOW)
    ).toBeNull();
    expect(
      verifyActivityToken(
        SECRET,
        [purpose, PLAYER, String(Number(expires) + 60), signature].join('.'),
        NOW
      )
    ).toBeNull();
    expect(
      verifyActivityToken(SECRET, ['session', PLAYER, expires, signature].join('.'), NOW)
    ).toBeNull();
    expect(verifyActivityToken(SECRET, `${token}.extra`, NOW)).toBeNull();
    expect(verifyActivityToken(SECRET, '', NOW)).toBeNull();
  });

  test('reads only a bearer token from the header', () => {
    const token = signActivityToken(SECRET, PLAYER, NOW);
    expect(bearerOf(`Bearer ${token}`)).toBe(token);
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf(`Basic ${token}`)).toBeNull();
    expect(bearerOf('Bearer short')).toBeNull();
    expect(bearerOf(`Bearer ${token} more`)).toBeNull();
  });
});

test.describe('Pickup Activity routes', TAGS, () => {
  test('say the Activity is not set up while Discord sign-in is not', async ({ request }) => {
    const config = await request.get('/api/pickup/activity/config');
    expect(config.status()).toBe(200);
    expect(await config.json()).toMatchObject({ success: true, clientId: null });

    const token = await request.post('/api/pickup/activity/token', {
      data: { code: 'a-code-from-discord' },
    });
    expect(token.status()).toBe(503);
    expect(await token.json()).toMatchObject({ success: false, code: 'not_configured' });

    const bad = await request.post('/api/pickup/activity/token', { data: { code: 'x' } });
    expect(bad.status()).toBe(400);
  });

  test('refuse a bearer token that is not ours', async ({ request }) => {
    const forged = signActivityToken(
      'not-the-servers-secret',
      PLAYER,
      Math.floor(Date.now() / 1000)
    );
    const answer = await request.get('/api/pickup', {
      headers: { Authorization: `Bearer ${forged}` },
    });
    expect(answer.status()).toBe(401);
    expect(await answer.json()).toMatchObject({ success: false, code: 'token_expired' });
  });
});
