/**
 * The pickup lobby's panel message in Discord, as text: what it says, its
 * buttons, and what a pressed button means. Pure, so it is tested on its own.
 */
import type { CommandInput } from '../../../services/pickup/pickupService';
import type { LobbyView, PlayerView } from '../../../services/pickup/pickupView';

const PREFIX = 'pickup';
/** Discord's limits for what is built here. */
export const LIMITS = { fieldValue: 1024, description: 4096, label: 80, customId: 100, rows: 5 };

// Types, not interfaces: they go into a JSON request body.
type Button =
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string; disabled?: boolean }
  | { type: 2; style: 5; label: string; url: string };
type Row = { type: 1; components: Button[] };
type Embed = {
  title: string;
  description: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
};
export type PanelMessage = {
  content: string;
  embeds: Embed[];
  components: Row[];
  allowed_mentions: { parse: [] };
};

export type PanelAction =
  | 'join_a'
  | 'join_b'
  | 'join_waiting'
  | 'leave'
  | 'ready'
  | 'scramble'
  | 'balance'
  | 'lock'
  | 'unlock'
  | 'start'
  | 'cancel';

const ACTIONS: readonly PanelAction[] = [
  'join_a',
  'join_b',
  'join_waiting',
  'leave',
  'ready',
  'scramble',
  'balance',
  'lock',
  'unlock',
  'start',
  'cancel',
];

/** `pickup:<lobby>:<action>:<version>`: the version the button was drawn for. */
export function customId(lobbyId: string, action: PanelAction, version: number): string {
  return `${PREFIX}:${lobbyId}:${action}:${version}`;
}

export function parseCustomId(
  raw: string
): { lobbyId: string; action: PanelAction; version: number } | null {
  const [prefix, lobbyId, actionRaw, versionRaw, ...rest] = raw.split(':');
  const action = ACTIONS.find((a) => a === actionRaw);
  const version = Number(versionRaw);
  if (prefix !== PREFIX || !lobbyId || !action || rest.length > 0) return null;
  if (!Number.isInteger(version) || version < 1) return null;
  return { lobbyId, action, version };
}

/**
 * The lobby command a pressed button stands for. Only the commands that must
 * name a version carry the button's: a Join pressed on a panel a moment old
 * still joins.
 */
export function commandOf(
  action: PanelAction,
  version: number
): { command: CommandInput; version?: number } {
  switch (action) {
    case 'join_a':
      return { command: { type: 'join', side: 'a' } };
    case 'join_b':
      return { command: { type: 'join', side: 'b' } };
    case 'join_waiting':
      return { command: { type: 'join', side: null } };
    case 'leave':
      return { command: { type: 'leave' } };
    case 'ready':
      return { command: { type: 'ready' } };
    case 'lock':
      return { command: { type: 'lock_teams', locked: true } };
    case 'unlock':
      return { command: { type: 'lock_teams', locked: false } };
    case 'scramble':
    case 'balance':
    case 'start':
    case 'cancel':
      return { command: { type: action }, version };
  }
}

/** A name as plain text: nothing in it formats the message or mentions anyone. */
export function plainName(name: string): string {
  const cleaned = name
    .replace(/[\\*_~`|>#[\]()@:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 32) || 'Player';
}

function playerLine(player: PlayerView, lobby: LobbyView): string {
  const marks: string[] = [];
  if (player.isHost) marks.push('host');
  if (lobby.state === 'ready_check') marks.push(player.ready ? 'ready' : 'not ready');
  const rating = player.rating === null ? '' : ` · ${player.rating}`;
  const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
  return `${plainName(player.name)}${rating}${suffix}`;
}

function listOf(players: PlayerView[], lobby: LobbyView, emptySeats: number): string {
  const lines = [
    ...players.map((p) => playerLine(p, lobby)),
    ...Array.from({ length: emptySeats }, () => '—'),
  ];
  const text = lines.join('\n') || '—';
  return text.length > LIMITS.fieldValue ? `${text.slice(0, LIMITS.fieldValue - 1)}…` : text;
}

function stateLine(lobby: LobbyView, siteUrl: string): string {
  const mapName = (id: string | null) => lobby.maps.find((m) => m.id === id)?.name ?? id;
  if (lobby.state === 'closed') return 'This lobby is closed.';
  if (lobby.state === 'ready_check') {
    const until = lobby.deadline === null ? '' : ` It ends <t:${lobby.deadline}:R>.`;
    return `**Ready check.** Seated players, press Ready.${until}`;
  }
  if (lobby.state === 'in_match' && lobby.match) {
    const map = mapName(lobby.match.map);
    const where = `${siteUrl}/match/${encodeURIComponent(lobby.match.slug)}`;
    return `**Match ${lobby.match.matchNo}**${map ? ` on ${map}` : ''}. Connect from the match page: ${where}`;
  }
  const size = lobby.settings.teamSize;
  const map = mapName(lobby.pickedMap) ?? 'random map';
  const locked = lobby.teamsLocked ? ' · teams locked' : '';
  return `Gathering · ${size}v${size} · ${map}${locked}`;
}

function button(
  lobby: LobbyView,
  action: PanelAction,
  label: string,
  style: 1 | 2 | 3 | 4,
  disabled = false
): Button {
  return {
    type: 2,
    style,
    label,
    custom_id: customId(lobby.id, action, lobby.version),
    ...(disabled ? { disabled: true } : {}),
  };
}

function rowsOf(lobby: LobbyView, siteUrl: string): Row[] {
  if (lobby.state === 'closed') return [];
  const size = lobby.settings.teamSize;
  const full = (side: 'a' | 'b') => lobby.teams[side].length >= size;
  const seatedCount = lobby.teams.a.length + lobby.teams.b.length;
  const links: Button[] = [
    { type: 2, style: 5, label: 'Open lobby', url: `${siteUrl}/pickup/${lobby.id}` },
  ];
  if (lobby.state === 'gathering') {
    return [
      {
        type: 1,
        components: [
          button(lobby, 'join_a', 'Join Team A', 1, full('a')),
          button(lobby, 'join_b', 'Join Team B', 1, full('b')),
          button(lobby, 'join_waiting', 'Join waiting room', 2),
          button(lobby, 'leave', 'Leave', 2),
        ],
      },
      {
        type: 1,
        components: [
          button(lobby, 'scramble', 'Scramble', 2, seatedCount < 2),
          button(lobby, 'balance', 'Balance teams', 2, seatedCount < 2),
          lobby.teamsLocked
            ? button(lobby, 'unlock', 'Unlock teams', 2)
            : button(lobby, 'lock', 'Lock teams', 2),
          button(lobby, 'start', 'Start', 3, !(full('a') && full('b'))),
        ],
      },
      { type: 1, components: links },
    ];
  }
  if (lobby.state === 'ready_check') {
    return [
      {
        type: 1,
        components: [
          button(lobby, 'ready', 'Ready', 3),
          button(lobby, 'join_waiting', 'Join waiting room', 2),
          button(lobby, 'leave', 'Leave', 2),
          button(lobby, 'cancel', 'Cancel start', 4),
        ],
      },
      { type: 1, components: links },
    ];
  }
  if (lobby.match) {
    links.unshift({
      type: 2,
      style: 5,
      label: 'Open match',
      url: `${siteUrl}/match/${encodeURIComponent(lobby.match.slug)}`,
    });
  }
  return [
    {
      type: 1,
      components: [
        button(lobby, 'join_waiting', 'Join waiting room', 2),
        button(lobby, 'leave', 'Leave', 2),
        button(lobby, 'cancel', 'Cancel match', 4),
      ],
    },
    { type: 1, components: links },
  ];
}

/** The whole panel message for a lobby. The host's buttons are for the host: a press is checked. */
export function panelMessage(lobby: LobbyView, siteUrl: string): PanelMessage {
  const size = lobby.settings.teamSize;
  const host = [...lobby.teams.a, ...lobby.teams.b, ...lobby.waiting].find((p) => p.isHost);
  const closed = lobby.state === 'closed';
  return {
    content: '',
    embeds: [
      {
        title: host ? `Pickup · ${plainName(host.name)}'s lobby` : 'Pickup lobby',
        description: stateLine(lobby, siteUrl),
        fields: closed
          ? []
          : [
              {
                name: `Team A ${lobby.teams.a.length}/${size}`,
                value: listOf(lobby.teams.a, lobby, size - lobby.teams.a.length),
                inline: true,
              },
              {
                name: `Team B ${lobby.teams.b.length}/${size}`,
                value: listOf(lobby.teams.b, lobby, size - lobby.teams.b.length),
                inline: true,
              },
              {
                name: `Waiting room ${lobby.waiting.length}`,
                value: listOf(lobby.waiting, lobby, 0),
                inline: false,
              },
            ],
      },
    ],
    components: rowsOf(lobby, siteUrl),
    allowed_mentions: { parse: [] },
  };
}

/** What a button's presser is told when the lobby did what they asked. Null: the panel says it all. */
export function doneText(action: PanelAction): string | null {
  if (action === 'leave') return 'You left the lobby.';
  return null;
}
