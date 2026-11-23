/** The lobby's settings as the host changes them. Pure. */
import {
  MAP_METHODS,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  ROLL_OUT_RULES,
  SIDES,
  done,
  refuse,
  seated,
  type Actor,
  type Lobby,
  type LobbyEvent,
  type LobbySettings,
  type Outcome,
} from './lobby';

export interface SettingsChange {
  teamSize?: number;
  rollOut?: string;
  mapMethod?: string;
  poolId?: number | null;
}

export function setSettings(lobby: Lobby, actor: Actor, change: SettingsChange): Outcome {
  const before = lobby.settings;
  const rollOut = ROLL_OUT_RULES.find((rule) => rule === change.rollOut);
  const mapMethod = MAP_METHODS.find((method) => method === change.mapMethod);
  if (change.rollOut !== undefined && !rollOut) return refuse('invalid_settings');
  if (change.mapMethod !== undefined && !mapMethod) return refuse('invalid_settings');
  const next: LobbySettings = {
    teamSize: change.teamSize ?? before.teamSize,
    rollOut: rollOut ?? before.rollOut,
    mapMethod: mapMethod ?? before.mapMethod,
    poolId: change.poolId === undefined ? before.poolId : change.poolId,
  };
  const { teamSize } = next;
  if (!Number.isInteger(teamSize) || teamSize < MIN_TEAM_SIZE || teamSize > MAX_TEAM_SIZE) {
    return refuse('invalid_settings');
  }
  if (next.poolId !== null && (!Number.isInteger(next.poolId) || next.poolId < 1)) {
    return refuse('invalid_settings');
  }
  if (SIDES.some((side) => seated(lobby, side).length > teamSize)) {
    return refuse('team_size_below_seated');
  }
  const actorId = actor.playerId;
  const events: LobbyEvent[] = [];
  if (next.teamSize !== before.teamSize) {
    events.push({ type: 'settings_changed', actorId, data: { teamSize } });
  }
  if (next.rollOut !== before.rollOut) {
    events.push({ type: 'roll_out_rule', actorId, data: { rule: next.rollOut } });
  }
  if (next.mapMethod !== before.mapMethod) {
    events.push({ type: 'map_method', actorId, data: { method: next.mapMethod } });
  }
  if (next.poolId !== before.poolId) {
    events.push({ type: 'map_pool', actorId, data: { poolId: next.poolId } });
  }
  if (events.length === 0) return refuse('no_change');
  // Another team size or pool has other maps, so a picked map no longer stands.
  const mapsChanged = next.teamSize !== before.teamSize || next.poolId !== before.poolId;
  return done(
    { ...lobby, settings: next, pickedMap: mapsChanged ? null : lobby.pickedMap },
    events
  );
}
