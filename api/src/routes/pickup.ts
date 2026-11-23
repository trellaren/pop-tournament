/**
 * Pickup lobbies (docs/design/pickup-lobby.md): a group picks its own teams.
 * For signed-in players. Writes are same-site JSON; the actor always comes
 * from the session, never from the body.
 */
import { Router } from 'express';
import { pickupService } from '../services/pickup/pickupService';
import { actorOf, handle, requirePlayer, sameSiteJson } from './pickupShared';
import { parseCommand } from '../services/pickup/parseCommand';
import type { Untrusted } from '../utils/untrusted';

const router = Router();

/**
 * @openapi
 * /api/pickup:
 *   get:
 *     tags: [Pickup]
 *     summary: Open pickup lobbies
 *     description: The lobbies that are open, and the one the signed-in player is in.
 *     responses:
 *       200:
 *         description: The open lobbies
 *       401:
 *         description: Not signed in
 */
router.get(
  '/',
  requirePlayer,
  handle('list the lobbies', async (req, res) => {
    return res.json({ success: true, ...(await pickupService.list(actorOf(req))) });
  })
);

/**
 * @openapi
 * /api/pickup:
 *   post:
 *     tags: [Pickup]
 *     summary: Open a pickup lobby
 *     description: |
 *       Opens a lobby with the signed-in player as its host, seated on Team A.
 *       Refused with 409 `lobby_exists` while one is open, or `in_other_lobby`.
 *     responses:
 *       200:
 *         description: The new lobby's id
 *       409:
 *         description: A lobby is already open
 */
router.post(
  '/',
  requirePlayer,
  sameSiteJson,
  handle('open a lobby', async (req, res) => {
    return res.json({ success: true, id: await pickupService.open(actorOf(req)) });
  })
);

/**
 * @openapi
 * /api/pickup/{id}:
 *   get:
 *     tags: [Pickup]
 *     summary: One pickup lobby
 *     description: |
 *       Both teams, the waiting room, the settings, the log, and what the
 *       signed-in player may do (`can`).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The lobby
 *       404:
 *         description: No such lobby
 */
router.get(
  '/:id',
  requirePlayer,
  handle('read the lobby', async (req, res) => {
    return res.json({
      success: true,
      lobby: await pickupService.view(String(req.params.id), actorOf(req)),
    });
  })
);

/**
 * @openapi
 * /api/pickup/{id}/commands:
 *   post:
 *     tags: [Pickup]
 *     summary: Act in a pickup lobby
 *     description: |
 *       One command per request: `join` (`side`: `a`, `b` or null for the
 *       waiting room; `invite`: an invite link's token, for a lobby only
 *       the invited can join), `leave`, and for the host or an admin `move`
 *       (`playerId`, `side`), `kick` (`playerId`), `make_host` (`playerId`),
 *       `scramble`, `balance`, `lock_teams` (`locked`), `invite` and
 *       `revoke_invite` (`playerId`), `set_settings` (`format`: `classic`
 *       or `wingman`, `visibility`: `open` or `invite`, `teamSize`, `rollOut`: `most_played` or `losers`, `mapMethod`:
 *       `pick`, `veto` (the two teams veto on the match page) or `vote` (the
 *       seated players vote with `vote_map` (`map`) after the ready check),
 *       `poolId`: one of the platform's map pools, or null), `roll_out`
 *       (`playerId`: to the waiting room, the longest waiter takes the seat),
 *       `start_draft` (`method`: `random`, `rating` or `host` with `captainA`
 *       and `captainB`; two captains then pick in turn with `pick`
 *       (`playerId`), 30 seconds a pick), `pick_map` (`map`: a map id, or null to draw one),
 *       `start` (the ready check; both teams must be full), `cancel` (the
 *       ready check or the running match) and `close`. A seated player
 *       answers the ready check with `ready`; when everyone has, the match is
 *       created and waits for a free server. `roll_out`, `start_draft`, `scramble`, `balance`, `start`,
 *       `cancel` and `close` must send the lobby's `version`; a stale one is
 *       refused with 409 `stale`.
 *       While a match runs the host or an admin sends `substitute` (`outId`:
 *       a seated player, `inId`: someone in the waiting room; with the
 *       `version`), and after one the match server did not take,
 *       `substitution_action` (`action`: `retry` or `undo`; with the `version`).
 *       Refusals are 409 with a `code` (403 `not_allowed`).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type]
 *             properties:
 *               type:
 *                 type: string
 *               version:
 *                 type: integer
 *               side:
 *                 type: string
 *                 nullable: true
 *               playerId:
 *                 type: string
 *               locked:
 *                 type: boolean
 *               teamSize:
 *                 type: integer
 *               rollOut:
 *                 type: string
 *               mapMethod:
 *                 type: string
 *               poolId:
 *                 type: integer
 *                 nullable: true
 *               method:
 *                 type: string
 *               captainA:
 *                 type: string
 *               captainB:
 *                 type: string
 *               map:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Done
 *       409:
 *         description: Refused, with a code
 */
router.post(
  '/:id/commands',
  requirePlayer,
  sameSiteJson,
  handle('change the lobby', async (req, res) => {
    const body: Untrusted = req.body;
    const { command, version } = parseCommand(body);
    await pickupService.command(String(req.params.id), actorOf(req), command, version);
    return res.json({ success: true });
  })
);

export default router;
