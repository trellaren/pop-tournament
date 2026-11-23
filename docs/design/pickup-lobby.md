# Pickup lobby

Status: design. Nothing here is built yet. Open questions for the owner are at
the end; each has a recommendation that the build follows unless told
otherwise.

Goal: a group that is already together (in a Discord voice channel, mostly)
opens one lobby, picks teams the way they like (choose a side, scramble,
balance by rating or a captain draft), picks a map, presses Start and ends up
on a free server on the right teams. When more than ten people want to play,
the lobby rotates players between the match and a waiting room after each
match. Players sign in once, with the platform's own sign-in.

This is the lobby from the `poop_flash` project, rebuilt inside the platform.
There it was a separate site, so players signed in through Steam and linked
Discord a second time. Here it is a page of the platform and uses the
platform's players, servers, veto, ratings and Discord add-on.

## How it differs from matchmaking

Matchmaking (`docs/design/matchmaking.md`) is a queue: strangers press Find
match and the platform builds the lobby. Pickup is the opposite: the players
are known first, and people choose the teams.

|                 | Matchmaking               | Pickup                                       |
| --------------- | ------------------------- | -------------------------------------------- |
| Who plays       | Whoever is queued         | Whoever joined the lobby                     |
| Teams           | Balanced by the platform  | Sides chosen, scrambled, balanced or drafted |
| How many        | One lobby per ten players | One open lobby; extra players wait           |
| After the match | Lobby is finished         | Same lobby continues, players rotate         |
| Rating          | `mm_ratings` changes      | No rating change (question 6)                |

The two do not share tables. Pickup does not touch the `mm_*` tables or
`matchmakingService`.

## What exists that we reuse

- **Sign-in and identity.** A player is a row in `players`, whose `id` is the
  SteamID64. Routes resolve the viewer with `resolveViewerIdentity`
  (`api/src/utils/viewerIdentity.ts`). There is no second sign-in and no
  second Steam link. A player's verified Discord account comes from
  `discordIdOf(playerId)` (`api/src/services/notifyChannels.ts`).
- **Standalone matches.** Start calls `matchService.createMatch(config,
baseUrl, null)` with both rosters by SteamID, as matchmaking's `startMatch`
  does, then sets `matches.source = 'pickup'`. The slug is `pu-<lobby>-<n>`.
- **Server allocation.** `scheduler.tryImmediateAllocation()` puts the match
  on a free server, or it waits in line with every other standalone match.
  Ready Up whitelists the roster and seats each player on their team.
- **Map pools and veto.** `getIntegration('cs2').matchmakingMapPool(mode,
poolId)` gives the maps. The CS2 veto already works for a standalone match.
- **Ratings and balancing.** `getGameRatings(playerIds, 'cs2')` for the
  number shown on each row, and `teamBalancingService.balanceTeams` for
  Balance teams.
- **Realtime.** `socketService` and the client's `useTopic`.
- **Discord add-on.** `discordFetch`, `botToken()`, `pickedGuildId()` and the
  channel code in `api/src/addons/discord/`.
- **Match page, stats, demos.** A pickup match is an ordinary match, so its
  page, scoreboard, demo and stats need nothing new.

## The lobby

There is at most one open pickup lobby per game mode at a time (question 2).
Any signed-in player may open it; whoever opens it is the **host**. A site
admin can do everything the host can.

A lobby has:

- **Team A** and **Team B**, each with `team_size` seats (5 by default; 2 or 1
  for wingman).
- **The waiting room**: everyone in the lobby without a seat, in the order
  they arrived.
- **Settings**: format (5v5 or wingman), team size, map pool, how the map is
  chosen (veto, vote, host picks, random), and the roll-out rule.
- **A log** of what happened, shown under the teams.

### States

```
gathering -> drafting -> gathering          (captain draft, optional)
gathering -> ready_check -> map_step -> in_match -> gathering
any       -> closed
```

- **gathering.** Players join a side or the waiting room and may switch while
  teams are not locked. The host presses Scramble, Balance teams, Pick teams
  (starts the draft), Lock teams, Pick map, and Start.
- **drafting.** Two captains (random, chosen by the host, or the two highest
  rated) pick in turn from the players in the lobby, 1-2-2-2-1, with a timer
  per pick. A pick that times out takes the highest rated player left.
- **ready_check.** Start asks every seated player to press Ready within the
  time limit. Anyone who does not is moved to the waiting room and the lobby
  goes back to gathering.
- **map_step.** With a map already picked, this is skipped. Otherwise the
  match is created and the platform's veto runs between the two sides
  (question 4), or the lobby holds a vote, or draws a map at random.
- **in_match.** The match exists on the platform. The lobby page shows the
  match card with the server's connect details and a link to the match page.
- **closed.** By the host or an admin, or after two hours with nobody in it.

### Roll-out

When the match ends, the lobby returns to gathering with the same teams. If
anyone is in the waiting room, as many players as are waiting (at most a
team's worth) are rolled out and replaced:

- **Who goes out:** by default, chosen at random among those who have played
  the most matches in a row; the host can switch to "losing team goes out".
- **Who comes in:** whoever has waited longest, onto the side with the free
  seat.

The host can also roll a named player out by hand at any time while
gathering. A cancelled match counts for nobody.

### Rules as pure functions

All of the above lives in `api/src/services/pickup/rules.ts` as pure functions
over a lobby value: `(lobby, command, now, random) -> { lobby, events }` or a
refusal with a code. No database, clock or `Math.random` inside. This is the
part worth the most tests, and it keeps the page, the API and Discord from
each inventing their own rules.

One-shot commands (Start, Pick, Ban, Roll out, Close) carry the lobby's
version; a stale one is refused, so two people pressing at once cannot both
win.

## Data

New tables, all prefixed `pickup_`, added to `getSchemaSQL()` in
`api/src/config/database.schema.ts` in the house style:

| Table                  | Holds                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pickup_lobbies`       | `id`, `game`, `mode`, `state`, `host_id`, `version`, `settings` (JSON), `picked_map`, `teams_locked`, `match_slug` (current match), `match_count`, `deadline_at`, `created_at`, `closed_at` |
| `pickup_lobby_players` | `lobby_id`, `player_id`, `side` (`a`, `b` or null for waiting), `seat`, `ready`, `joined_at`, `waiting_since`, `games_in_row`, `is_captain`                                                 |
| `pickup_events`        | `lobby_id`, `seq`, `type`, `actor_id`, `data` (JSON), `created_at`: the lobby log                                                                                                           |
| `pickup_matches`       | `lobby_id`, `match_slug`, `n`, the rosters as started, `result`                                                                                                                             |

A partial unique index allows one lobby per mode that is not closed, and one
open lobby per player.

Every change goes through one function in
`api/src/services/pickup/pickupService.ts`: take the service's in-process lock
(the `locked()` promise chain matchmaking uses), read the lobby in a
transaction (`db.withClient`, `SELECT … FOR UPDATE`), run the rule, write the
lobby and its events, commit, and only then emit sockets, create the match or
call Discord. Nothing calls out while the row is locked.

Closed lobbies and their logs are deleted after 30 days by the platform's
existing cleanup pass.

## API

`api/src/routes/pickup.ts`, mounted at `/api/pickup`, for signed-in players
(the same guard matchmaking's routes use):

- `GET /api/pickup` — the open lobbies the viewer can see, and their own.
- `GET /api/pickup/:id` — the lobby view: teams, waiting room, settings, the
  log, each row's rating, and what the viewer may do.
- `POST /api/pickup` — open a lobby.
- `POST /api/pickup/:id/commands` — one body shape, `{ type, version?, … }`:
  `join`, `leave`, `ready`, `scramble`, `balance`, `lock_teams`,
  `start_draft`, `pick`, `move`, `kick`, `make_host`, `set_settings`,
  `pick_map`, `vote_map`, `start`, `cancel`, `roll_out`, `close`.

The actor always comes from the session, never from the body. Refusals are
`409` with a code the client translates. Routes are documented and
`yarn docs:api` is run, as the contributing guide asks.

Realtime: one event, `pickup:update:<id>`, carrying only the id and version;
the page refetches. The list uses `pickup:list`.

## Client

- `client/src/pages/Pickup.tsx` at `/pickup`: the list, or straight into the
  open lobby when there is one.
- `client/src/pages/PickupLobby.tsx` at `/pickup/:id`: Team A, a middle
  column with settings and the host's controls, Team B; the waiting room and
  the log below. During a draft, a banner and the pool of players to pick.
- Components in `client/src/components/pickup/`, built from
  `@auto-tournament/ui` and the platform's theme, so it looks like the rest of
  the site and picks up the frag.works branding with no work.
- A "Pickup" entry in `SharedNavBar`, a path in `client/src/paths.ts`, a lazy
  route in `App.tsx` under `RequireSignedIn`.
- Strings in `client/src/locales/en/translation/pickup.json`, synced to the
  other locales with `yarn --cwd client i18n:sync`.

## Match hooks

Two small changes outside pickup's own folders:

1. `applySeriesResult` in `api/src/core/matchLifecycle.ts` has a hard-coded
   branch for `source === 'matchmaking'`. Pickup adds one beside it:
   `source === 'pickup'` calls `pickupService.applyMatchResult(slug, side)`,
   which records the result and runs the roll-out.
2. A cancelled or deleted match is heard through `onMatchChanged`
   (`api/src/core/matchChangeBus.ts`), which returns the lobby to gathering.

The veto's turn timer and vote run only for tournament and matchmaking
matches today (`integrations/cs2/veto/vote.ts`); step 6 extends that check to
`pickup`.

## Discord

Everything the poop_flash bot and its Activity do is kept. The platform's
Discord add-on today posts link buttons, moves only tournament teams between
voice channels, takes slash commands over its Gateway connection and has no
embedded Activity, so pickup adds the rest in `api/src/addons/discord/pickup/`:

- **The panel.** One message per open lobby in a channel an admin picks,
  showing each side, the waiting room, the state, the settings and the match.
  It has working buttons and menus, as poop_flash's panel has: Join Team A,
  Join Team B, Join waiting room, Leave, Ready, and for the host Scramble,
  Balance teams, Pick teams, Map veto, Pick map, Lock teams, Start, Cancel,
  Roll out, Manage players, Settings and Close; during a draft or veto, the
  pick and ban menus; during a match, Connect, Spectate and Launch Dashboard.
  The add-on already receives interactions over the Gateway, so a button
  press arrives the same way a slash command does; no public interactions
  address is needed. Each press runs the same lobby command the page runs.
  Only one writer edits the panel, at most once every few seconds.
- **Who pressed.** A press is from a Discord account. The player is the
  platform account that has that Discord account verified
  (`auth_identities`). Someone without one gets a private reply with a link to
  sign in and connect Discord on the platform, once, for everything.
- **Voice channels.** `/pickup setup voice` names the lobby voice channel. At
  Start the bot makes `#<n> Team A` and `#<n> Team B` in its category, moves
  each seated player into their side's channel, and after the match moves
  everyone back and deletes them. Split teams and Bring everyone back by
  hand. Built on the add-on's `teamChannels.ts` and `matchVoice.ts`.
- **Pings and announcements.** Ready check, your pick, match ready with
  Connect, rolled out and rolled in, as poop_flash sends them.
- **Slash commands.** `/pickup` with the subcommands poop_flash's `/lobby`
  and `/setup` have, where the platform has no command of its own already.
- **The Activity.** The lobby inside Discord, launched from the panel's
  Launch Dashboard or Discord's own launcher. It is the platform's client
  served at `/activity`, showing the pickup pages (and links out for the
  rest). Sign-in uses the Embedded App SDK's `authorize`; the API exchanges
  the code, finds the platform account with that verified Discord account and
  answers with a short-lived bearer token, because Discord's frame does not
  carry the site's cookie. The pickup routes and the socket accept that token
  beside the session. Needs: Activities enabled on the Discord application,
  its root mapped to the site's address, and the site allowing Discord's
  frame for `/activity` only.

All of it is off unless the Discord add-on is on and an admin has set it up.

## Keeping the fork mergeable

Upstream moves fast, so the fork changes as few shared lines as it can:

- New code lives in `api/src/services/pickup/`, `api/src/routes/pickup.ts`,
  `api/src/addons/discord/pickup/`, `client/src/pages/Pickup*.tsx`,
  `client/src/components/pickup/`, `tests/pickup-*.spec.ts` and this file.
- Shared files touched, a few lines each: the route table, the schema file
  (one appended block), `matchLifecycle.ts` (one branch), `veto/vote.ts` (one
  condition), `App.tsx`, `paths.ts`, `SharedNavBar.tsx`, the locale files, the
  Discord add-on's command list, and the generated API docs.
- `main` in the fork stays equal to upstream. Work lands on a long-lived
  branch, `pop`, which the frag.works image is built from; upstream is merged
  into `pop` regularly (question 7).
- The fork stays under the PolyForm Noncommercial licence, as the licence
  requires, and follows `CONTRIBUTING.md` (format, lint, the typecheck
  ratchet, files under 450 lines, a spec per feature) so that offering pickup
  upstream later stays possible.

## Steps

Each is its own pull request into `pop`, stacked in this order.

1. **Lobby core.** Tables, `rules.ts` with its tests, the service, the API,
   the page: open, join a side or the waiting room, switch, host controls,
   Scramble, Balance teams, Lock teams, kick, make host, close. The log.
   Realtime. No match yet.
2. **Start.** Ready check, host picks the map or random, `createMatch` with
   `source = 'pickup'`, allocation, the match card with connect details, the
   result hook, cancel.
3. **Roll-out.** Games in a row, waiting order, the roll-out rules, roll out
   by hand, the idle close.
4. **Discord panel and voice.** The panel with its buttons and menus, who
   pressed, the voice channels and moves, pings, `/pickup`.
5. **Captain draft.** Captains three ways, the pick order, the timer, the
   banner and pool, on the page and the panel.
6. **Map veto, vote and pools.** The platform's veto between the two sides
   with its timer; the lobby's map vote; named pools and Workshop maps.
7. **The Activity.** `/activity`, its sign-in, the bearer token, Launch
   Dashboard.
8. **Wingman.** The lobby setting Format, Classic or Wingman. Wingman is
   1v1 or 2v2 and plays as the platform's 2v2 mode (its wingman maps, MR8,
   `wingman` on the match); Classic plays as its 5v5 mode whatever the team
   size. Choosing a format brings its team size (2, a 1v1 stays; 5 for
   Classic) and its default maps unless the same change names them, and
   forgets a picked map.
9. **Who can join.** Invited only, invites and invite links.
10. **Mid-match substitution**, through the platform's roster update.
11. **Spectators, practice and retakes**, through the platform's servers.
12. **Moderation and roles.** What the table below marks "build".
13. **Admin settings and docs.** Settings → Pickup, the user guide page.

Steps 1 to 4 give the evening as it runs today: the lobby from Discord and
the page, teams, a match on a server with everyone on the right side and in
the right voice channel, and roll-out afterwards.

## Parity with poop_flash's main

Every feature built on poop_flash's `main` is kept. "Platform" means the
platform's own version is used in place of ours; each of those is checked
against what poop_flash does when its step starts, and a gap is built.

| Feature on main                                           | Here                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sign in through Steam, Connect Discord, Link Steam        | Platform (one sign-in for everything)                                                           |
| Lobby: sides, waiting room, host, ready check             | Build, steps 1 and 2                                                                            |
| Scramble, Balance teams, Lock teams, Switch side          | Build, step 1                                                                                   |
| Captain draft (random, host's or by rating)               | Build, step 5                                                                                   |
| Roll-out, games in a row, waiting order                   | Build, step 3                                                                                   |
| Map veto, Pick map, Map vote                              | Platform's veto; vote and pick built, step 6                                                    |
| Named map pools, Workshop maps                            | Platform's pools; gaps built, step 6                                                            |
| Wingman                                                   | Platform's wingman matches; lobby format built, step 8                                          |
| Server launch, teams on the server, map change            | Platform with Ready Up                                                                          |
| Launch failure: Retry, Keep waiting, Start anyway         | Platform's allocation and recovery; the lobby shows the state and offers Cancel and Retry       |
| Manual mode, Report result, Fix result                    | Build: a lobby with no free server can still play and report by hand, its own step after step 3 |
| Valve private match with queue code                       | Build, in its own step after step 3                                                             |
| Discord panel with buttons and menus                      | Build, step 4                                                                                   |
| Voice channels per match, Split teams, Bring back         | Build on the add-on, step 4                                                                     |
| Pings and announcements                                   | Build on the add-on, step 4                                                                     |
| Slash commands                                            | Build under `/pickup`; platform's own where they exist                                          |
| The Activity, Launch Dashboard                            | Build, step 7                                                                                   |
| Lobby page: three columns, row stats, row actions, log    | Build, step 1                                                                                   |
| Timer sound, glow on your turn                            | Build, with steps 5 and 6                                                                       |
| Player stats, rating, leaderboard, match page, scoreboard | Platform                                                                                        |
| The host's value and the admin-only multiplier            | Build as a per-player balance adjustment, step 12                                               |
| Demos, GOTV watch                                         | Platform                                                                                        |
| Spectators in the server                                  | Platform's spectator slots; lobby's Spectate built, step 11                                     |
| Practice and retakes switch                               | Platform's server modes and plugin sets, step 11                                                |
| Mid-match substitution                                    | Platform's roster update; lobby flow built, step 10                                             |
| Who can join, invites, invite links                       | Build, step 9                                                                                   |
| Roles: owner, admin, mod, host                            | Platform's admins and the lobby host; a moderator level built if the platform has none, step 12 |
| Bans with length and reason                               | Platform's bans; a lobby-only ban built if needed, step 12                                      |
| Reports, moderation log                                   | Platform's reports and audit log, step 12                                                       |
| Delete my data, Forget a member                           | Platform, or built, step 12                                                                     |
| AI caster and cast page                                   | Build on the platform's match events, after step 13 (question 3)                                |
| Name rules (the Scraggles rule)                           | Build as an admin-set display name override, step 12                                            |
| Members page                                              | Platform's players list                                                                         |
| Game server setup scripts                                 | Platform's CS2 Server Manager                                                                   |

## Questions for the owner

1. **Name.** "Pickup", at `/pickup`. Recommendation: yes. (Alternatives:
   "10-man", "Lobby", which collides with matchmaking's lobby.)
2. **How many lobbies.** One open lobby per mode, or several at once?
   Recommendation: one per mode. It matches how the evenings run and keeps
   the panel and voice channels simple; several is a later change to one
   index.
3. **Order.** Is the step order above right? It puts roll-out and the
   Discord panel and voice first, the Activity seventh, and the caster last.
   Recommendation: as written; say if the Activity should come earlier.
4. **Veto.** Use the platform's veto (the match exists first, any player on a
   side may act) or a lobby-side veto by the two captains before the match
   exists? Recommendation: the platform's, so there is one veto to maintain.
5. **Who may open a lobby.** Any signed-in player, or only admins and players
   an admin marks? Recommendation: any signed-in player, with an admin
   setting to restrict it.
6. **Ratings.** Should a pickup match change the matchmaking rating?
   Recommendation: no. Hand-picked and drafted teams would distort it. Pickup
   reads the rating for Balance teams and for display only.
7. **Branches.** `main` equal to upstream and a `pop` branch for our work, as
   above? Recommendation: yes.
8. **Stats.** poop_flash showed HLTV rating 1.0 and ADR over the last 25
   matches. Here the rows show the platform's rating and stats instead.
   Recommendation: yes, the platform's.
9. **poop_flash's `frag-flash` branch and `pop.frag.works`.** With the lobby
   inside the platform, that separate site is no longer needed for
   frag.works. Recommendation: stop work on it, leave the branch as it is,
   and note in its docs that this fork replaces it. `main` there (Vercel,
   `www.fraggit.dev`) is not affected.
10. **Deploying.** frag.works runs upstream's published image today. The fork
    needs its own image built from `pop` and the machine's compose file
    pointed at it. Recommendation: a step after step 4, with a short
    checklist for the machine, so the evening can be tried for real.
