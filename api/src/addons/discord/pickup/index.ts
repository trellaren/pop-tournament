/** The pickup lobby in Discord: the panel, its pings and the team voice channels. */
import { onPickupChange } from '../../../services/pickup/pickupBus';
import { announce, schedulePanel, stopPanels } from './panel';
import { followVoice } from './voice';

let stopListening: (() => void) | null = null;

export function startPickupDiscord(): void {
  stopListening ??= onPickupChange(async (change) => {
    schedulePanel(change.lobby.id);
    await followVoice(change);
    await announce(change);
  });
}

export function stopPickupDiscord(): void {
  stopListening?.();
  stopListening = null;
  stopPanels();
}
