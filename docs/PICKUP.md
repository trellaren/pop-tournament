# Pickup lobbies

A pickup lobby is for a group that picks its own teams: open a lobby, sit on
Team A or Team B, and play on one of the site's servers. When more people
want to play than there are seats, the rest wait in the waiting room and are
rotated in after each match (roll-out). The design, and what is not built,
is in [design/pickup-lobby.md](design/pickup-lobby.md).

Nothing here has been tried against Discord or a real game server yet; the
pull request of each step says what was checked and how.

## For players

- **Open or join.** The Pickup page (`/pickup`) shows the open lobby, or a
  button to open one. In Discord: `/pickup open`, `/pickup join`,
  `/pickup leave`, `/pickup show`, or the buttons on the lobby's panel.
- **Sides.** Join Team A, Team B or the waiting room, and switch while the
  lobby is gathering. A free seat fills from the waiting room.
- **Ready.** When the host presses Start, everyone seated presses Ready.
- **The match.** The lobby shows how to connect. With the Discord bot set
  up, players are moved to their team's voice channel and back afterwards.
- **After the match.** Players roll out to the waiting room by the lobby's
  rule and those who waited longest come in.
- **Watching.** Someone in the lobby who is not playing can press Spectate
  (`/pickup spectate`) to join the match server as a spectator.
- **Practice and retakes.** The Pickup page and `/pickup servers` list the
  servers that are online with a practice or retakes setup.
- **In Discord's own window.** The panel's button opens the lobby as a
  Discord Activity. It needs a site account connected to that Discord account.

## For the host

The player who opens the lobby is its host, and can pass that on with Make
host. The host:

- sets the **Format** (Classic or Wingman), team size, the map or how it is
  chosen (pick, veto or vote), who rolls out, and **Who can join** (Everyone
  or Invited only);
- presses **Scramble**, **Balance teams**, **Pick teams** (a captain draft)
  and **Lock teams**;
- moves players between the teams and the waiting room, and kicks;
- **invites** players, or makes an invite link, good for twelve hours
  (`/pickup invite`, `/pickup invite-link`);
- presses **Start**, and while a match runs **substitutes** a player from
  the waiting room for one on the field (`/pickup substitute`). Someone
  substituted out does not come back into the same match;
- presses **Roll out** after a match, and **Close** when the evening ends.

## For moderators

A pickup moderator runs any lobby as its host does, and bans from pickup.
Site admins can do everything a moderator can.

- **Ban** on a lobby row, on the moderation page (`/pickup/moderation`, the
  Moderation button on the Pickup page), or `/pickup ban` and
  `/pickup unban`.
- A ban lasts from one hour to thirty days, or until lifted. Its reason is
  for moderators only: the banned player is told until when, never why.
- A banned player leaves the open lobby and cannot open, join or be invited
  to one until the ban ends.

## For admins

On the moderation page, site admins also set:

- **Moderators**: who the pickup moderators are.
- **Multiplier** (0.1 to 1): weighs a player's rating when teams are
  balanced and when captains are chosen by rating. Only admins see it, and
  nothing shown to anyone else reveals it.
- **Display names**: one or more names shown in pickup lobbies in place of
  the player's own, one a day.

A platform ban or a deleted account also takes the player out of the open
lobby.

### Discord

`/pickup setup` (administrators of the Discord server) names the text channel for the lobby's panel and
the lobby voice channel, and turns the Activity button on or off. The bot
needs to send messages in that channel and, for voice, to move members and
manage channels in the voice channel's category. The Activity signs in
through the Discord application set up for "Sign in with Discord", which
must be the application the bot belongs to.

The API behind all of this is listed under **Pickup** in
[API-REFERENCE.md](API-REFERENCE.md).
