# Deploying the fork with pickup lobbies

How to run this fork (branch `pop`) on a machine that runs Auto Tournament
today, such as frag.works, and how to set up pickup afterwards. What pickup
is and how it is used: [PICKUP.md](PICKUP.md).

Not tried yet: these steps have not been run on a real machine. The CS2
module build in step 3 was run from this branch and packs; the image build,
the update of an installed module and everything in Discord have not been
tried. Read the log at each step.

## What changes on the machine

- The platform's container runs an image built from this checkout
  (`pop-tournament:current`) in place of the published one.
- **The CS2 module is replaced by this fork's build.** CS2 support is a
  separate, signed module that an instance installs from the catalog. Pickup's
  substitution, Spectate and the practice and retakes list are inside it, so
  the published module is not enough: with it, a substitution is written in
  the lobby and never reaches the game server. The build script makes the
  module with a higher version and its own signing key, and the platform
  updates to it by itself at the next start.
- The database gains the `pickup_*` tables at start. Nothing existing is
  changed.
- The game servers and their Ready Up plugin are not touched.

## 1. Before you start

- Docker with Docker Compose, about 6 GB of free disk and 4 GB of memory for
  the build.
- Know where the platform's compose file and `.env` are on the machine, and
  which compose command starts it today. The commands below are for this
  repository's `docker/docker-compose.yml`; if the machine uses its own
  compose file, see "A compose file of your own" at the end.
- Pick a time with no match running: the platform restarts once.

## 2. Back up

From the folder the platform is started from today:

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres pg_dump -U postgres auto_tournament > "backup-$(date +%F).sql"
```

Check the file is not empty. Keep a copy of `.env` beside it: its
`SESSION_SECRET` (or `SECRETS_KEY`) is what the saved Discord token and
sign-in secrets are encrypted with.

Copy the installed modules too. They are in the platform's data folder
(`AT_DATA_DIR`, by default `docker/data`):

```bash
cp -a docker/data/modules "modules-backup-$(date +%F)"
```

Note the image that runs now, for going back:

```bash
docker inspect auto-tournament --format '{{.Config.Image}} {{.Image}}'
```

## 3. Get the fork and build

Use the checkout the platform is started from, so `.env` and the data folder
stay where they are. If that checkout follows upstream, add the fork and
switch to `pop`:

```bash
git remote add pop https://github.com/trellaren/pop-tournament.git
```

```bash
git fetch pop pop
```

```bash
git checkout -B pop pop/pop
```

Then build. This takes a while the first time:

```bash
scripts/pop-build-image.sh
```

It builds the CS2 module in a throwaway container, builds the image, tags it
`pop-tournament:current`, and writes `docker/pop-image.env` with the public
key the module is signed with. That file holds no secret and is not
committed.

If `.env` already sets `MODULE_TRUSTED_KEYS`, remove that line (or add the
key from `docker/pop-image.env` to it), otherwise the two disagree.

## 4. Start it

```bash
docker compose --env-file .env -f docker/docker-compose.yml -f docker/docker-compose.pop.yml up -d
```

Use this command from now on, with both `-f` files; without the second one
Compose goes back to the published image.

## 5. Check

```bash
docker logs auto-tournament 2>&1 | grep -E "CATALOG|MODULE|PICKUP|error" | tail -40
```

- A line `Auto-updated cs2 from … to …` with the version the build script
  printed. If instead the log says the signature is not trusted, the key in
  `docker/pop-image.env` did not reach the container: check step 4's command
  and `.env`.
- Sign in as an admin. Modules shows Counter-Strike 2 at that version.
  If CS2 was never installed on this instance, install it there now; the
  catalog offers the image's build because its version is the higher one.
- The top bar has **Pickup**. Open a lobby and close it again.
- The Servers page still shows the game servers online.

## 6. Set up pickup

1. **Discord sign-in.** Settings → Sign-in → Discord, with the client id and
   secret of the Discord application the bot belongs to. Players connect
   their Discord account on the site once; the bot knows who pressed a
   button by that connection.
2. **The bot.** Modules → Discord: turn it on, give it the bot token and
   pick the Discord server. The bot's role needs View Channels, Send Messages
   and Embed Links in the panel's channel, and Manage Channels and Move
   Members in the lobby voice channel's category.
3. **The channels.** In Discord, as an administrator of the server:
   `/pickup setup channel:#… voice:…`.
4. **The Activity** (optional). In the Discord Developer Portal, enable
   Activities for the application and map its root `/` to the site's address,
   then `/pickup setup activity:true`. The panel then shows Launch Dashboard.
5. **Moderators.** On the site, Pickup → Moderation: who the pickup
   moderators are, and for admins the balance multipliers and display names.

Then try one evening's path with a few people: open a lobby from Discord,
join from both Discord and the page, Start, the ready check, the match on a
server, the voice channels, a substitution, Spectate, roll-out. None of that
has met Discord or a real server before.

## Updating later

```bash
git pull pop pop
```

Then back up (step 2), build (step 3's script) and start (step 4). Each build
gives the module a newer version and a new key, and the platform updates to
it at the start.

## Going back

To the published image, with the pickup tables left in place (they are not
read by it):

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

The CS2 module does not go back with it. The published image does not trust
the fork's key, and the platform refuses to install a module version older
than one it has run, so reinstalling the published module from Modules is
refused. Going all the way back means restoring what step 2 saved, with the
platform's container stopped: the `modules` folder, and the database into an
empty `auto_tournament` (drop and recreate it first):

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres psql -U postgres -d auto_tournament < backup-YYYY-MM-DD.sql
```

Everything written since the backup is lost by that, so prefer fixing
forward: the fork's image is the published platform plus pickup.

## A compose file of your own

If the machine starts the platform from its own compose file, make the same
two changes to the platform's service there in place of
`docker/docker-compose.pop.yml`:

```yaml
image: pop-tournament:current
env_file:
  - .env
  - /path/to/the/checkout/docker/pop-image.env
```

Keep the service's name, container name, volumes, ports and networks as they
are, so the data folder, the database and whatever proxies to the container
keep working.
