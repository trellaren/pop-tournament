/** Reading a lobby command from a request body: anything not understood is refused. */
import type { Untrusted } from '../../utils/untrusted';
import { PickupError, type CommandInput } from './pickupService';
import { CAPTAIN_METHODS, FORMATS, MAP_METHODS, ROLL_OUT_RULES, type Side } from './rules';

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

const BAD_ROLL_OUT = 'rollOut must be "most_played" or "losers"';

function settingsCommand(fields: Record<string, Untrusted>): CommandInput {
  const { teamSize, poolId } = fields;
  if (teamSize !== undefined && typeof teamSize !== 'number') {
    throw bad('teamSize must be a number');
  }
  const format = FORMATS.find((f) => f === fields.format);
  if (fields.format !== undefined && !format) throw bad('format must be "classic" or "wingman"');
  const rollOut = ROLL_OUT_RULES.find((rule) => rule === fields.rollOut);
  if (fields.rollOut !== undefined && !rollOut) throw bad(BAD_ROLL_OUT);
  const mapMethod = MAP_METHODS.find((method) => method === fields.mapMethod);
  if (fields.mapMethod !== undefined && !mapMethod) {
    throw bad('mapMethod must be "pick", "veto" or "vote"');
  }
  if (poolId !== undefined && poolId !== null && typeof poolId !== 'number') {
    throw bad('poolId must be a pool id or null');
  }
  if (teamSize === undefined && !format && !rollOut && !mapMethod && poolId === undefined) {
    throw bad('Send a setting to change');
  }
  return {
    type: 'set_settings',
    ...(format ? { format } : {}),
    ...(teamSize === undefined ? {} : { teamSize }),
    ...(rollOut ? { rollOut } : {}),
    ...(mapMethod ? { mapMethod } : {}),
    ...(poolId === undefined ? {} : { poolId }),
  };
}

function draftCommand(fields: Record<string, Untrusted>): CommandInput {
  const method = CAPTAIN_METHODS.find((m) => m === fields.method);
  if (!method) throw bad('method must be "random", "rating" or "host"');
  if (method !== 'host') return { type: 'start_draft', method };
  return {
    type: 'start_draft',
    method,
    captainA: playerIdOf(fields.captainA),
    captainB: playerIdOf(fields.captainB),
  };
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
    case 'start':
    case 'ready':
    case 'cancel':
    case 'close':
      return { command: { type: fields.type }, version };
    case 'move':
      return {
        command: { type: 'move', playerId: playerIdOf(fields.playerId), side: sideOf(fields.side) },
        version,
      };
    case 'kick':
    case 'pick':
    case 'roll_out':
    case 'make_host':
      return { command: { type: fields.type, playerId: playerIdOf(fields.playerId) }, version };
    case 'lock_teams':
      if (typeof fields.locked !== 'boolean') throw bad('locked must be true or false');
      return { command: { type: 'lock_teams', locked: fields.locked }, version };
    case 'start_draft':
      return { command: draftCommand(fields), version };
    case 'vote_map':
      if (typeof fields.map !== 'string') throw bad('map must be a map id');
      return { command: { type: 'vote_map', map: fields.map }, version };
    case 'pick_map':
      if (fields.map !== null && typeof fields.map !== 'string') {
        throw bad('map must be a map id or null');
      }
      return { command: { type: 'pick_map', map: fields.map }, version };
    case 'set_settings':
      return { command: settingsCommand(fields), version };
    default:
      throw bad('Unknown command');
  }
}
