/**
 * Pickup moderation (docs/design/pickup-lobby.md): bans from pickup for
 * moderators and admins; moderators, balance multipliers and display names
 * for site admins only. Writes are same-site JSON; who is asking comes from
 * the session.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { Untrusted } from '../utils/untrusted';
import { PickupError } from '../services/pickup/pickupErrors';
import {
  banFromPickup,
  changeModerator,
  changePlayerSetting,
  moderationView,
  unbanFromPickup,
} from '../services/pickup/moderationService';
import { actorOf, handle, requirePlayer, sameSiteJson } from './pickupShared';

const router = Router();

function playerIdOf(req: Request): string {
  const id = String(req.params.playerId);
  if (!/^\d{1,32}$/.test(id)) throw new PickupError(400, 'bad_request', 'Not a player id');
  return id;
}

function fieldsOf(req: Request): Record<string, Untrusted> {
  const body: Untrusted = req.body;
  return typeof body === 'object' && body !== null ? { ...body } : {};
}

/**
 * @openapi
 * /api/pickup/admin:
 *   get:
 *     tags: [Pickup]
 *     summary: Pickup moderation
 *     description: |
 *       The bans from pickup that hold now, with their reasons, for a
 *       moderator or an admin. A site admin also gets the moderators and what
 *       is set per player (balance multiplier, display names); for a
 *       moderator those are null.
 *     responses:
 *       200:
 *         description: Bans, and for admins moderators and player settings
 *       403:
 *         description: Not a moderator
 */
router.get(
  '/',
  requirePlayer,
  handle('read pickup moderation', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await moderationView(actorOf(req))) });
  })
);

/**
 * @openapi
 * /api/pickup/admin/bans/{playerId}:
 *   put:
 *     tags: [Pickup]
 *     summary: Ban a player from pickup lobbies
 *     description: |
 *       For a moderator or an admin. `length` in seconds, from one hour to
 *       thirty days, or null until lifted; `reason` (up to 200 characters) is
 *       for moderators only and is never shown to the player. The player
 *       leaves the open lobby unless they are playing its match. Banning
 *       again replaces the ban.
 *     parameters:
 *       - in: path
 *         name: playerId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               length:
 *                 type: integer
 *                 nullable: true
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Banned
 *   delete:
 *     tags: [Pickup]
 *     summary: Lift a ban from pickup lobbies
 *     parameters:
 *       - in: path
 *         name: playerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lifted
 */
router.put(
  '/bans/:playerId',
  requirePlayer,
  sameSiteJson,
  handle('ban from pickup', async (req, res) => {
    const { length, reason } = fieldsOf(req);
    if (length !== null && length !== undefined && typeof length !== 'number') {
      throw new PickupError(400, 'bad_request', 'length must be seconds or null');
    }
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      throw new PickupError(400, 'bad_request', 'reason must be text');
    }
    await banFromPickup(actorOf(req), playerIdOf(req), length ?? null, reason ?? null);
    return res.json({ success: true });
  })
);

router.delete(
  '/bans/:playerId',
  requirePlayer,
  sameSiteJson,
  handle('lift a pickup ban', async (req, res) => {
    await unbanFromPickup(actorOf(req), playerIdOf(req));
    return res.json({ success: true });
  })
);

/**
 * @openapi
 * /api/pickup/admin/moderators/{playerId}:
 *   put:
 *     tags: [Pickup]
 *     summary: Make a player a pickup moderator, or stop
 *     description: |
 *       Site admins only. A moderator runs any pickup lobby as its host does
 *       and bans from pickup, and is not a site admin.
 *     parameters:
 *       - in: path
 *         name: playerId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [on]
 *             properties:
 *               on:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Done
 */
router.put(
  '/moderators/:playerId',
  requirePlayer,
  sameSiteJson,
  handle('change a pickup moderator', async (req, res) => {
    const { on } = fieldsOf(req);
    if (typeof on !== 'boolean')
      throw new PickupError(400, 'bad_request', 'on must be true or false');
    await changeModerator(actorOf(req), playerIdOf(req), on);
    return res.json({ success: true });
  })
);

/**
 * @openapi
 * /api/pickup/admin/players/{playerId}:
 *   put:
 *     tags: [Pickup]
 *     summary: Set a player's balance multiplier and display names
 *     description: |
 *       Site admins only. `multiplier` (0.1 to 1, or null for none) weighs
 *       the player's rating in Balance teams and the draft by rating; it is
 *       shown to nobody else and nothing shown reveals it. `displayNames`
 *       (up to 12, each up to 32 characters; empty for none): one of them is
 *       shown in pickup lobbies in place of the player's own name.
 *     parameters:
 *       - in: path
 *         name: playerId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               multiplier:
 *                 type: number
 *                 nullable: true
 *               displayNames:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Saved
 */
router.put(
  '/players/:playerId',
  requirePlayer,
  sameSiteJson,
  handle('set a pickup player setting', async (req, res) => {
    const { multiplier, displayNames } = fieldsOf(req);
    if (multiplier !== undefined && multiplier !== null && typeof multiplier !== 'number') {
      throw new PickupError(400, 'bad_request', 'multiplier must be a number or null');
    }
    const names =
      Array.isArray(displayNames) && displayNames.every((n) => typeof n === 'string')
        ? displayNames
        : undefined;
    if (displayNames !== undefined && !names) {
      throw new PickupError(400, 'bad_request', 'displayNames must be a list of names');
    }
    if (multiplier === undefined && !names) {
      throw new PickupError(400, 'bad_request', 'Send a multiplier or displayNames');
    }
    await changePlayerSetting(actorOf(req), playerIdOf(req), {
      ...(multiplier === undefined ? {} : { multiplier }),
      ...(names ? { displayNames: names } : {}),
    });
    return res.json({ success: true });
  })
);

export default router;
