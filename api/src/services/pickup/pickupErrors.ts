/** How the pickup service refuses: a status, a code the client translates, and plain words. */
import type { RefusalCode } from './rules';

export type PickupErrorCode =
  | RefusalCode
  | 'not_found'
  | 'lobby_exists'
  | 'in_other_lobby'
  | 'invalid_map'
  | 'unknown_player'
  | 'invite_link_invalid'
  | 'may_not_spectate'
  | 'spectate_refused'
  | 'banned'
  | 'banned_player';

export class PickupError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: PickupErrorCode | 'bad_request',
    message: string,
    /** More for the client to show, beside the code (a ban's end). */
    readonly data: Readonly<Record<string, number | null>> = {}
  ) {
    super(message);
  }
}

export const REFUSALS: Record<PickupErrorCode, string> = {
  closed: 'This lobby is closed',
  stale: 'The lobby changed; try again',
  not_allowed: 'Only the host or an admin can do that',
  not_in_lobby: 'That player is not in the lobby',
  side_full: 'That team is full',
  lobby_full: 'The lobby is full',
  teams_locked: 'The teams are locked',
  no_change: 'Nothing to change',
  invalid_settings: 'Those settings are not valid',
  team_size_below_seated: 'A team has more players than that team size',
  not_enough_players: 'Seat at least two players first',
  wrong_state: 'That cannot be done right now',
  in_match: 'Not while the match is running',
  teams_not_full: 'Both teams must be full first',
  invalid_map: 'That map is not in the pool',
  not_your_turn: 'It is not your pick',
  invalid_captains: 'Choose two different players in the lobby as captains',
  not_found: 'No such lobby',
  lobby_exists: 'A lobby is already open',
  in_other_lobby: 'You are already in another lobby',
  invite_only: 'This lobby is for invited players only',
  already_invited: 'That player is already invited',
  not_invited: 'That player is not invited',
  invite_limit: 'The invite list is full',
  unknown_player: 'No such player on the site',
  invite_link_invalid: 'That invite link no longer works',
  may_not_spectate: 'Only someone in the lobby who is not playing can spectate',
  spectate_refused: 'The match server did not take that; try again in a moment',
  banned: 'You are banned from pickup lobbies',
  banned_player: 'That player is banned from pickup lobbies',
  not_on_roster: 'That player is not playing in the match',
  not_eligible: 'Only someone in the waiting room can come in',
  already_subbed_out: 'That player already left this match',
};

export function refusal(code: PickupErrorCode): PickupError {
  if (code === 'not_found') return new PickupError(404, code, REFUSALS[code]);
  return new PickupError(code === 'not_allowed' ? 403 : 409, code, REFUSALS[code]);
}
