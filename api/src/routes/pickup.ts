/**
 * Pickup lobbies (docs/design/pickup-lobby.md): a group picks its own teams.
 * For signed-in players. Writes are same-site JSON; the actor always comes
 * from the session, never from the body.
 */
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { resolveViewerIdentity } from '../utils/viewerIdentity';
import { isSameSiteRequest } from '../utils/accountConnections';
import { log } from '../utils/logger';
import { PickupError, pickupService } from '../services/pickup/pickupService';
import type { Actor } from '../services/pickup/rules';
import { parseCommand } from '../services/pickup/parseCommand';
import type { Untrusted } from '../utils/untrusted';
import { bearerOf } from '../services/pickup/activityToken';
import {
  activityClientId,
  actorOfActivityToken,
  signInToActivity,
} from '../services/pickup/activitySignIn';

const router = Router();

type PickupRequest = Request & { pickupActor?: Actor; pickupBearer?: boolean };

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A signed-in player (not an API token), acting as themselves: the site's
 * session, or inside Discord the Activity's token, which is judged alone.
 */
async function requirePlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const bearer = bearerOf(req.get('authorization'));
  if (bearer) {
    const actor = await actorOfActivityToken(bearer, nowSeconds());
    if (!actor) {
      res.status(401).json({ success: false, code: 'token_expired', error: 'Sign in again' });
      return;
    }
    (req as PickupRequest).pickupActor = actor;
    (req as PickupRequest).pickupBearer = true;
    next();
    return;
  }
  const identity = await resolveViewerIdentity(req);
  if (!identity.realSteamId) {
    res.status(401).json({ success: false, error: 'Sign in to use pickup lobbies' });
    return;
  }
  if (identity.isImpersonating) {
    res.status(403).json({ success: false, error: 'Stop impersonating to use pickup lobbies' });
    return;
  }
  (req as PickupRequest).pickupActor = {
    playerId: identity.realSteamId,
    isAdmin: identity.isRealAdmin,
  };
  next();
}

/**
 * Writes are JSON, and with a cookie same-site. A bearer token is not sent by
 * a browser on its own, so a request carrying one needs no same-site check
 * (inside Discord the page's origin is Discord's proxy).
 */
function sameSiteJson(req: Request, res: Response, next: NextFunction): void {
  if (!(req as PickupRequest).pickupBearer && !isSameSiteRequest(req)) {
    res.status(403).json({ success: false, error: 'Request refused' });
    return;
  }
  if (!req.is('application/json')) {
    res.status(415).json({ success: false, error: 'Send this request as JSON' });
    return;
  }
  next();
}

function actorOf(req: Request): Actor {
  const actor = (req as PickupRequest).pickupActor;
  if (!actor) throw new PickupError(403, 'not_allowed', 'Sign in to use pickup lobbies');
  return actor;
}

/** Wrap a handler: PickupError → its status and code, anything else → 500. */
function handle(what: string, fn: (req: Request, res: Response) => Promise<Response | void>) {
  return async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (error) {
      if (error instanceof PickupError) {
        return res
          .status(error.status)
          .json({ success: false, code: error.code, error: error.message });
      }
      log.error(`[PICKUP] ${what} failed`, error as Error);
      return res.status(500).json({ success: false, error: `Could not ${what}` });
    }
  };
}

/**
 * @openapi
 * /api/pickup/activity/config:
 *   get:
 *     tags: [Pickup]
 *     summary: What the Discord Activity needs to start
 *     description: |
 *       The Discord application's id the Activity authorizes against, or
 *       null while "Sign in with Discord" is not set up. No secret.
 *     responses:
 *       200:
 *         description: The Activity's configuration
 */
router.get(
  '/activity/config',
  handle('read the Activity configuration', async (_req, res) => {
    return res.json({ success: true, clientId: activityClientId() });
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
 *       waiting room), `leave`, and for the host or an admin `move`
 *       (`playerId`, `side`), `kick` (`playerId`), `make_host` (`playerId`),
 *       `scramble`, `balance`, `lock_teams` (`locked`), `set_settings`
 *       (`teamSize`, `rollOut`: `most_played` or `losers`, `mapMethod`:
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
