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
import { PickupError, pickupService, type CommandInput } from '../services/pickup/pickupService';
import type { Actor, Side } from '../services/pickup/rules';
import type { Untrusted } from '../utils/untrusted';

const router = Router();

type PickupRequest = Request & { pickupActor?: Actor };

/** A signed-in player (not an API token), acting as themselves. */
async function requirePlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
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

function sameSiteJson(req: Request, res: Response, next: NextFunction): void {
  if (!isSameSiteRequest(req)) {
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

const bad = (message: string) => new PickupError(400, 'bad_request', message);

function sideOf(value: Untrusted): Side | null {
  if (value === 'a' || value === 'b') return value;
  if (value === null || value === undefined) return null;
  throw bad('side must be "a", "b" or null');
}

function playerIdOf(value: Untrusted): string {
  if (typeof value === 'string' && /^\d{1,32}$/.test(value)) return value;
  throw bad('playerId is required');
}

/** Read a command from a request body. Anything not understood is refused. */
export function parseCommand(body: Untrusted): { command: CommandInput; version?: number } {
  if (typeof body !== 'object' || body === null) throw bad('Send a command');
  const fields: Record<string, Untrusted> = { ...body };
  const rawVersion = fields.version;
  if (rawVersion !== undefined && !Number.isInteger(rawVersion)) {
    throw bad('version must be a whole number');
  }
  const version = typeof rawVersion === 'number' ? rawVersion : undefined;
  switch (fields.type) {
    case 'join':
      return { command: { type: 'join', side: sideOf(fields.side) }, version };
    case 'leave':
    case 'scramble':
    case 'balance':
    case 'close':
      return { command: { type: fields.type }, version };
    case 'move':
      return {
        command: { type: 'move', playerId: playerIdOf(fields.playerId), side: sideOf(fields.side) },
        version,
      };
    case 'kick':
    case 'make_host':
      return { command: { type: fields.type, playerId: playerIdOf(fields.playerId) }, version };
    case 'lock_teams':
      if (typeof fields.locked !== 'boolean') throw bad('locked must be true or false');
      return { command: { type: 'lock_teams', locked: fields.locked }, version };
    case 'set_settings':
      if (typeof fields.teamSize !== 'number') throw bad('teamSize must be a number');
      return { command: { type: 'set_settings', teamSize: fields.teamSize }, version };
    default:
      throw bad('Unknown command');
  }
}

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
 *       (`teamSize`) and `close`. `scramble`, `balance` and `close` must send
 *       the lobby's `version`; a stale one is refused with 409 `stale`.
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
