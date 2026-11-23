import { test, expect } from '@playwright/test';
import {
  LIMITS,
  commandOf,
  customId,
  panelMessage,
  parseCustomId,
  plainName,
} from '../../api/src/addons/discord/pickup/panelText';
import type { LobbyView, PlayerView } from '../../api/src/services/pickup/pickupView';

/**
 * The pickup lobby's Discord panel as text (docs/design/pickup-lobby.md):
 * what it shows in each state, its buttons, and what a press means. Discord
 * itself is not reachable from a test, so the calls are not exercised here.
 *
 * @tag api
 * @tag pickup
 */

const TAGS = { tag: ['@api', '@pickup'] };
const SITE = 'https://example.test';
const LOBBY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function row(id: string, name: string, extra: Partial<PlayerView> = {}): PlayerView {
  return {
    playerId: id,
    name,
    avatarUrl: null,
    rating: 1500,
    isHost: false,
    ready: false,
    gamesInRow: 0,
    ...extra,
  };
}

function lobby(change: Partial<LobbyView> = {}): LobbyView {
  const can = {
    join: true,
    leave: true,
    move: false,
    kick: false,
    make_host: false,
    scramble: false,
    balance: false,
    lock_teams: false,
    set_settings: false,
    roll_out: false,
    pick_map: false,
    start: false,
    ready: false,
    cancel: false,
    close: false,
  };
  return {
    id: LOBBY_ID,
    state: 'gathering',
    version: 7,
    hostId: '1',
    teamsLocked: false,
    settings: { teamSize: 2, rollOut: 'most_played' },
    pickedMap: null,
    maps: [{ id: 'de_dust2', name: 'Dust II' }],
    deadline: null,
    match: null,
    teams: {
      a: [row('1', 'Ada', { isHost: true }), row('2', 'Bo')],
      b: [row('3', 'Cy')],
    },
    waiting: [row('4', 'Di')],
    log: [],
    me: null,
    can,
    ...change,
  };
}

const labels = (message: ReturnType<typeof panelMessage>) =>
  message.components.flatMap((r) => r.components.map((c) => c.label));
const ids = (message: ReturnType<typeof panelMessage>) =>
  message.components.flatMap((r) => r.components.flatMap((c) => ('custom_id' in c ? [c] : [])));

test.describe('pickup Discord panel (pure)', () => {
  test('custom ids carry the lobby, the action and the version, and round-trip', TAGS, () => {
    const id = customId(LOBBY_ID, 'start', 7);
    expect(id.length).toBeLessThanOrEqual(LIMITS.customId);
    expect(parseCustomId(id)).toEqual({ lobbyId: LOBBY_ID, action: 'start', version: 7 });
    for (const bad of ['', 'pickup', 'other:x:start:1', `pickup:${LOBBY_ID}:dance:1`]) {
      expect(parseCustomId(bad)).toBeNull();
    }
    expect(parseCustomId(`pickup:${LOBBY_ID}:start:0`)).toBeNull();
    expect(parseCustomId(`pickup:${LOBBY_ID}:start:1:extra`)).toBeNull();
  });

  test('a press is the lobby command; only one-shot commands carry the version', TAGS, () => {
    expect(commandOf('join_a', 7)).toEqual({ command: { type: 'join', side: 'a' } });
    expect(commandOf('join_waiting', 7)).toEqual({ command: { type: 'join', side: null } });
    expect(commandOf('unlock', 7)).toEqual({ command: { type: 'lock_teams', locked: false } });
    expect(commandOf('start', 7)).toEqual({ command: { type: 'start' }, version: 7 });
    expect(commandOf('cancel', 7)).toEqual({ command: { type: 'cancel' }, version: 7 });
  });

  test('names are plain text: no formatting, no mentions', TAGS, () => {
    expect(plainName('**@everyone** <@123> [x](y)')).toBe('everyone <123 xy');
    expect(plainName('   ')).toBe('Player');
    expect(plainName('a'.repeat(80))).toHaveLength(32);
  });

  test('gathering: both teams, the waiting room and the buttons', TAGS, () => {
    const message = panelMessage(lobby(), SITE);
    expect(message.allowed_mentions).toEqual({ parse: [] });
    const [embed] = message.embeds;
    expect(embed.title).toBe("Pickup · Ada's lobby");
    expect(embed.description).toContain('2v2');
    expect(embed.fields.map((f) => f.name)).toEqual(['Team A 2/2', 'Team B 1/2', 'Waiting room 1']);
    expect(embed.fields[0].value).toContain('Ada · 1500 (host)');
    expect(embed.fields[1].value).toBe('Cy · 1500\n—');
    expect(labels(message)).toEqual([
      'Join Team A',
      'Join Team B',
      'Join waiting room',
      'Leave',
      'Scramble',
      'Balance teams',
      'Lock teams',
      'Start',
      'Open lobby',
    ]);
    const buttons = ids(message);
    // Team A is full and Team B is not, so Start waits.
    expect(buttons.find((b) => b.label === 'Join Team A')?.disabled).toBe(true);
    expect(buttons.find((b) => b.label === 'Join Team B')?.disabled).toBeUndefined();
    expect(buttons.find((b) => b.label === 'Start')?.disabled).toBe(true);
    expect(buttons.every((b) => parseCustomId(b.custom_id)?.version === 7)).toBe(true);
    expect(message.components.length).toBeLessThanOrEqual(LIMITS.rows);
    expect(message.components.every((r) => r.components.length <= 5)).toBe(true);
  });

  test('ready check: who is ready, the deadline, Ready and Cancel start', TAGS, () => {
    const message = panelMessage(
      lobby({
        state: 'ready_check',
        deadline: 1700000000,
        teams: {
          a: [row('1', 'Ada', { isHost: true, ready: true }), row('2', 'Bo')],
          b: [row('3', 'Cy'), row('4', 'Di')],
        },
        waiting: [],
      }),
      SITE
    );
    expect(message.embeds[0].description).toContain('<t:1700000000:R>');
    expect(message.embeds[0].fields[0].value).toContain('Ada · 1500 (host, ready)');
    expect(message.embeds[0].fields[0].value).toContain('Bo · 1500 (not ready)');
    expect(labels(message)).toEqual([
      'Ready',
      'Join waiting room',
      'Leave',
      'Cancel start',
      'Open lobby',
    ]);
  });

  test('in a match: the map, the link to connect, Cancel match', TAGS, () => {
    const message = panelMessage(
      lobby({
        state: 'in_match',
        match: { slug: 'pu-0f8fad5b-1', matchNo: 1, status: 'live', map: 'de_dust2' },
      }),
      SITE
    );
    expect(message.embeds[0].description).toContain('Match 1');
    expect(message.embeds[0].description).toContain('Dust II');
    expect(message.embeds[0].description).toContain(`${SITE}/match/pu-0f8fad5b-1`);
    expect(labels(message)).toEqual([
      'Join waiting room',
      'Leave',
      'Cancel match',
      'Open match',
      'Open lobby',
    ]);
  });

  test('closed: no buttons, no teams', TAGS, () => {
    const message = panelMessage(lobby({ state: 'closed' }), SITE);
    expect(message.components).toEqual([]);
    expect(message.embeds[0].fields).toEqual([]);
    expect(message.embeds[0].description).toBe('This lobby is closed.');
  });

  test('a long waiting room stays inside a field', TAGS, () => {
    const many = Array.from({ length: 40 }, (_, i) => row(String(i), `Player ${'x'.repeat(30)}`));
    const message = panelMessage(lobby({ waiting: many }), SITE);
    expect(message.embeds[0].fields[2].value.length).toBeLessThanOrEqual(LIMITS.fieldValue);
  });
});
