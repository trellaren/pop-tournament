/**
 * The pickup lobby as the pages see it: names, ratings, the match's status and
 * the log, for one viewer.
 */
import { getGameRatings } from '../gameRatings';
import {
  allowed,
  draftPool,
  turnOf,
  seated,
  waiting,
  type Actor,
  type CommandType,
  type EventData,
  type Lobby,
  type LobbyPlayer,
  type LobbySettings,
  type Side,
} from './rules';
import { mapPoolFor, mapPools, type PickupMap, type PickupPool } from './pickupMatch';
import { PICKUP_GAME, loadEvents, loadMatchState, loadNames, type PlayerName } from './pickupStore';

export interface PlayerView {
  playerId: string;
  name: string;
  avatarUrl: string | null;
  /** The rating shown on the row and used by Balance teams. */
  rating: number | null;
  isHost: boolean;
  /** Pressed Ready in the running ready check. */
  ready: boolean;
  /** Matches played in a row without a turn in the waiting room. */
  gamesInRow: number;
}

export interface DraftView {
  captains: Record<Side, string>;
  /** The side whose pick it is. */
  turn: Side | null;
  /** The players to pick from, best rated first. */
  pool: PlayerView[];
}

export interface MatchView {
  slug: string;
  matchNo: number;
  /** The platform's status of the match: pending, loaded, live… */
  status: string;
  map: string | null;
  /** The teams are vetoing the map on the match page. */
  vetoing: boolean;
}

export interface LogLine {
  id: number;
  type: string;
  at: number;
  actorId: string;
  actorName: string;
  /** The player the line is about, when it is about one. */
  playerName: string | null;
  data: EventData;
}

export interface LobbySummary {
  id: string;
  state: Lobby['state'];
  hostId: string;
  hostName: string;
  teamSize: number;
  teamsLocked: boolean;
  seated: number;
  waiting: number;
}

export interface LobbyView {
  id: string;
  state: Lobby['state'];
  version: number;
  hostId: string;
  teamsLocked: boolean;
  settings: LobbySettings;
  pickedMap: string | null;
  /** The maps the host picks from. */
  maps: PickupMap[];
  /** When the ready check ends (epoch seconds); null outside one. */
  deadline: number | null;
  /** The running match; null outside one. */
  match: MatchView | null;
  /** The running captain draft; null outside one. */
  draft: DraftView | null;
  /** The map pools the host can choose from. */
  pools: PickupPool[];
  /** The running map vote: votes per map, and the viewer's own. Null outside one. */
  vote: {
    counts: Record<string, number>;
    mine: string | null;
    voted: number;
    voters: number;
  } | null;
  teams: Record<Side, PlayerView[]>;
  waiting: PlayerView[];
  log: LogLine[];
  /** Where the viewer is: a side, 'waiting', or null when not in the lobby. */
  me: Side | 'waiting' | null;
  can: Record<CommandType, boolean>;
}

const UNKNOWN_PLAYER = 'Unknown player';

function whereIs(lobby: Lobby, playerId: string): Side | 'waiting' | null {
  const mine = lobby.players.find((p) => p.playerId === playerId);
  if (!mine) return null;
  return mine.side ?? 'waiting';
}

function voteView(lobby: Lobby, viewer: Actor): NonNullable<LobbyView['vote']> {
  const counts: Record<string, number> = {};
  for (const map of Object.values(lobby.votes)) counts[map] = (counts[map] ?? 0) + 1;
  return {
    counts,
    mine: lobby.votes[viewer.playerId] ?? null,
    voted: Object.keys(lobby.votes).length,
    voters: lobby.players.filter((p) => p.side !== null).length,
  };
}

/** Each player's rating in the lobby's game: shown on the rows and used by Balance teams. */
export async function ratingsOf(playerIds: string[]): Promise<Record<string, number>> {
  const ratings = await getGameRatings(playerIds, PICKUP_GAME);
  const out: Record<string, number> = {};
  for (const [id, rating] of ratings) out[id] = rating.elo;
  return out;
}

function playerView(
  player: LobbyPlayer,
  lobby: Lobby,
  names: Map<string, PlayerName>,
  ratings: Record<string, number>
): PlayerView {
  const known = names.get(player.playerId);
  return {
    playerId: player.playerId,
    name: known?.name ?? UNKNOWN_PLAYER,
    avatarUrl: known?.avatarUrl ?? null,
    rating: ratings[player.playerId] ?? null,
    isHost: player.playerId === lobby.hostId,
    ready: player.ready,
    gamesInRow: player.gamesInRow,
  };
}

/** The lobby as one viewer sees it. */
export async function buildView(lobby: Lobby, viewer: Actor): Promise<LobbyView> {
  const lobbyId = lobby.id;
  const matchState = lobby.matchSlug ? await loadMatchState(lobby.matchSlug) : null;
  const maps =
    lobby.state === 'closed'
      ? []
      : await mapPoolFor(lobby.settings.teamSize, lobby.settings.poolId);
  const events = await loadEvents(lobbyId);
  const ids = lobby.players.map((p) => p.playerId);
  const mentioned = events.flatMap((e) => {
    const about = e.data.playerId;
    return typeof about === 'string' ? [e.actorId, about] : [e.actorId];
  });
  const [names, ratings] = await Promise.all([loadNames([...ids, ...mentioned]), ratingsOf(ids)]);
  const row = (p: LobbyPlayer) => playerView(p, lobby, names, ratings);
  const bySeat = (x: LobbyPlayer, y: LobbyPlayer) => x.joinedAt - y.joinedAt;
  return {
    id: lobby.id,
    state: lobby.state,
    version: lobby.version,
    hostId: lobby.hostId,
    teamsLocked: lobby.teamsLocked,
    settings: lobby.settings,
    pickedMap: lobby.pickedMap,
    maps,
    deadline: lobby.deadline,
    match: lobby.matchSlug
      ? {
          slug: lobby.matchSlug,
          matchNo: lobby.matchNo,
          status: matchState?.status ?? 'pending',
          map: matchState?.map ?? null,
          vetoing: matchState?.vetoing ?? false,
        }
      : null,
    pools: lobby.state === 'closed' ? [] : await mapPools(),
    vote: lobby.state === 'map_vote' ? voteView(lobby, viewer) : null,
    draft: lobby.draft
      ? { captains: lobby.draft.captains, turn: turnOf(lobby), pool: draftPool(lobby).map(row) }
      : null,
    teams: {
      a: seated(lobby, 'a').sort(bySeat).map(row),
      b: seated(lobby, 'b').sort(bySeat).map(row),
    },
    waiting: waiting(lobby).map(row),
    log: events.map((e) => {
      const about = e.data.playerId;
      return {
        id: e.id,
        type: e.type,
        at: e.at,
        actorId: e.actorId,
        actorName: names.get(e.actorId)?.name ?? UNKNOWN_PLAYER,
        playerName: typeof about === 'string' ? (names.get(about)?.name ?? UNKNOWN_PLAYER) : null,
        data: e.data,
      };
    }),
    me: whereIs(lobby, viewer.playerId),
    can: allowed(lobby, viewer),
  };
}

/** The open lobbies, and the one the viewer is in. */
export async function buildList(
  lobbies: Lobby[],
  viewer: Actor
): Promise<{ lobbies: LobbySummary[]; mine: string | null }> {
  const names = await loadNames(lobbies.map((l) => l.hostId));
  const mine = lobbies.find((l) => l.players.some((p) => p.playerId === viewer.playerId));
  return {
    mine: mine?.id ?? null,
    lobbies: lobbies.map((l) => ({
      id: l.id,
      state: l.state,
      hostId: l.hostId,
      hostName: names.get(l.hostId)?.name ?? UNKNOWN_PLAYER,
      teamSize: l.settings.teamSize,
      teamsLocked: l.teamsLocked,
      seated: l.players.filter((p) => p.side !== null).length,
      waiting: l.players.filter((p) => p.side === null).length,
    })),
  };
}
