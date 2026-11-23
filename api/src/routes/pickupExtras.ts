/**
 * The pickup routes around the lobby itself: the Discord Activity's sign-in,
 * invite links, Spectate, and the practice and retakes servers. Listed in
 * routes/routeTable.ts before the lobby's own routes.
 */
import { Router } from 'express';
import { pickupService } from '../services/pickup/pickupService';
import type { Untrusted } from '../utils/untrusted';
import { configuredPublicOrigin } from '../utils/publicOrigin';
import { modeServers } from '../services/pickup/spectators';
import { activityClientId, signInToActivity } from '../services/pickup/activitySignIn';
import { actorOf, handle, nowSeconds, requirePlayer, sameSiteJson } from './pickupShared';

const router = Router();

/**
 * @openapi
 * /api/pickup/activity/config:
 *   get:
 *     tags: [Pickup]
 *     summary: What the Discord Activity needs to start
 *     description: |
 *       The Discord application's id the Activity authorizes against, or
 *       null while "Sign in with Discord" is not set up, and the site's
 *       public address, for links opened outside Discord. No secret.
 *     responses:
 *       200:
 *         description: The Activity's configuration
 */
router.get(
  '/activity/config',
  handle('read the Activity configuration', async (_req, res) => {
    return res.json({
      success: true,
      clientId: activityClientId(),
      // Inside Discord the page's own address is Discord's proxy, not the site.
      siteUrl: configuredPublicOrigin(),
    });
  })
);

/**
 * @openapi
 * /api/pickup/activity/token:
 *   post:
 *     tags: [Pickup]
 *     summary: Sign in to the Discord Activity
 *     description: |
 *       Exchanges the code from Discord's Embedded App SDK for a one-hour
 *       token of the platform account that has that Discord account
 *       connected. The token is sent as `Authorization: Bearer` to the
 *       pickup routes. 409 `not_linked` when no account has it; 503
 *       `not_configured` while Discord sign-in is not set up.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: The token
 *       409:
 *         description: No platform account has this Discord account
 */
router.post(
  '/activity/token',
  handle('sign in to the Activity', async (req, res) => {
    const body: Untrusted = req.body;
    const code =
      typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined;
    if (!req.is('application/json') || typeof code !== 'string' || !/^[\w-]{8,256}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Send the code as JSON' });
    }
    const signedIn = await signInToActivity(code, nowSeconds());
    if (!signedIn.ok) {
      const status = { not_configured: 503, discord_refused: 502, not_linked: 409 }[signedIn.code];
      return res.status(status).json({ success: false, code: signedIn.code });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      token: signedIn.token,
      expiresAt: signedIn.expiresAt,
      accessToken: signedIn.accessToken,
      playerId: signedIn.playerId,
    });
  })
);

/**
 * @openapi
 * /api/pickup/servers:
 *   get:
 *     tags: [Pickup]
 *     summary: Practice and retakes servers
 *     description: |
 *       The servers that are online with the Practice or the Retakes plugin
 *       set and take no matches: anyone signed in joins them on their own.
 *       An admin chooses a server's plugin set on the Servers page.
 *     responses:
 *       200:
 *         description: The servers per mode
 */
router.get(
  '/servers',
  requirePlayer,
  handle('list the practice and retakes servers', async (_req, res) => {
    return res.json({ success: true, ...(await modeServers()) });
  })
);

/**
 * @openapi
 * /api/pickup/{id}/invite-link:
 *   post:
 *     tags: [Pickup]
 *     summary: Make an invite link to a pickup lobby
 *     description: |
 *       For the lobby's host or an admin. The token lets whoever holds it
 *       join this lobby for twelve hours, while it is open and its maker
 *       still runs it; send it as `invite` with `join`. The page's address
 *       for it is `/pickup/{id}?invite={token}`.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The token
 *       403:
 *         description: Not the host or an admin
 */
router.post(
  '/:id/invite-link',
  requirePlayer,
  sameSiteJson,
  handle('make an invite link', async (req, res) => {
    const id = String(req.params.id);
    const token = await pickupService.inviteToken(id, actorOf(req));
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, token, path: `/pickup/${id}?invite=${token}` });
  })
);

/**
 * @openapi
 * /api/pickup/{id}/spectate:
 *   post:
 *     tags: [Pickup]
 *     summary: Spectate the lobby's running match
 *     description: |
 *       For someone in the lobby who is not playing, its host or an admin;
 *       never someone substituted out of this match. Puts them on the match's
 *       spectator list and answers how to join its server (`connect` is null
 *       while the match has none). 409 `may_not_spectate`, or
 *       `spectate_refused` when the match server did not take it.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: How to join the server
 *       409:
 *         description: Refused, with a code
 */
router.post(
  '/:id/spectate',
  requirePlayer,
  sameSiteJson,
  handle('spectate the match', async (req, res) => {
    const connect = await pickupService.spectate(String(req.params.id), actorOf(req));
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, connect });
  })
);

export default router;
