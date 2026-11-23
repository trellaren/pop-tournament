/**
 * What every pickup route shares: who is asking (the site's session, or
 * inside Discord the Activity's token), the checks on a write, and how a
 * refusal is answered.
 */
import type { Request, Response, NextFunction } from 'express';
import { resolveViewerIdentity } from '../utils/viewerIdentity';
import { isSameSiteRequest } from '../utils/accountConnections';
import { log } from '../utils/logger';
import { PickupError } from '../services/pickup/pickupService';
import type { Actor } from '../services/pickup/rules';
import { bearerOf } from '../services/pickup/activityToken';
import { actorOfActivityToken } from '../services/pickup/activitySignIn';

type PickupRequest = Request & { pickupActor?: Actor; pickupBearer?: boolean };

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A signed-in player (not an API token), acting as themselves: the site's
 * session, or inside Discord the Activity's token, which is judged alone.
 */
export async function requirePlayer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
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
export function sameSiteJson(req: Request, res: Response, next: NextFunction): void {
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

export function actorOf(req: Request): Actor {
  const actor = (req as PickupRequest).pickupActor;
  if (!actor) throw new PickupError(403, 'not_allowed', 'Sign in to use pickup lobbies');
  return actor;
}

/** Wrap a handler: PickupError → its status and code, anything else → 500. */
export function handle(
  what: string,
  fn: (req: Request, res: Response) => Promise<Response | void>
) {
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
