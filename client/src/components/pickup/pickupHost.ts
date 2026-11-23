/**
 * Where the pickup lobby is shown: on the site, or embedded in Discord (the
 * Activity), where links to other pages open outside Discord and the lobby is
 * re-read on a timer as well, in case the socket does not reach the frame.
 */
import React from 'react';

export interface PickupHost {
  /** Open one of the site's pages outside the frame. Null on the site itself: links are links. */
  openOutside: ((path: string) => void) | null;
  /** Re-read the lobby this often (ms); 0: only when the server says it changed. */
  pollMs: number;
}

export const SITE_HOST: PickupHost = { openOutside: null, pollMs: 0 };

export const PickupHostContext = React.createContext<PickupHost>(SITE_HOST);

export const usePickupHost = (): PickupHost => React.useContext(PickupHostContext);
