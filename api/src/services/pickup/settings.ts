/** The lobby's settings as the host changes them. Pure. */
import {
  DEFAULT_TEAM_SIZE,
  FORMATS,
  MAP_METHODS,
  MAX_TEAM_SIZE,
  MIN_TEAM_SIZE,
  ROLL_OUT_RULES,
  SIDES,
  WINGMAN_TEAM_SIZE,
  done,
  refuse,
  seated,
  type Actor,
  type Lobby,
  type LobbyEvent,
  type LobbyFormat,
  type LobbySettings,
  type Outcome,
} from './lobby';

export interface SettingsChange {
  format?: string;
  teamSize?: number;
  rollOut?: string;
  mapMethod?: string;
  poolId?: number | null;
}

/** What a format starts from: wingman 2v2 (a 1v1 stays one), classic 5v5, each with its own maps. */
function formatBrings(
  format: LobbyFormat,
  before: LobbySettings
): { teamSize: number; poolId: null } {
  if (format === 'wingman') {
    return { teamSize: Math.min(before.teamSize, WINGMAN_TEAM_SIZE), poolId: null };
  }
  return { teamSize: DEFAULT_TEAM_SIZE, poolId: null };
}

export function setSettings(lobby: Lobby, actor: Actor, change: SettingsChange): Outcome {
  const before = lobby.settings;
  const rollOut = ROLL_OUT_RULES.find((rule) => rule === change.rollOut);
  const mapMethod = MAP_METHODS.find((method) => method === change.mapMethod);
  if (change.rollOut !== undefined && !rollOut) return refuse('invalid_settings');
  if (change.mapMethod !== undefined && !mapMethod) return refuse('invalid_settings');
  const format = FORMATS.find((f) => f === change.format);
  if (change.format !== undefined && !format) return refuse('invalid_settings');
  // A new format brings its own team size and maps unless the same change names them.
  const from = format && format !== before.format ? formatBrings(format, before) : before;
  const next: LobbySettings = {
    format: format ?? before.format,
    teamSize: change.teamSize ?? from.teamSize,
    rollOut: rollOut ?? before.rollOut,
    mapMethod: mapMethod ?? before.mapMethod,
    poolId: change.poolId === undefined ? from.poolId : change.poolId,
  };
  const { teamSize } = next;
  const largest = next.format === 'wingman' ? WINGMAN_TEAM_SIZE : MAX_TEAM_SIZE;
  if (!Number.isInteger(teamSize) || teamSize < MIN_TEAM_SIZE || teamSize > largest) {
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
  if (next.format !== before.format) {
    events.push({ type: 'format', actorId, data: { format: next.format } });
  }
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
  // Another format or pool has other maps, so a picked map no longer stands.
  const mapsChanged = next.format !== before.format || next.poolId !== before.poolId;
  return done(
    { ...lobby, settings: next, pickedMap: mapsChanged ? null : lobby.pickedMap },
    events
  );
}
