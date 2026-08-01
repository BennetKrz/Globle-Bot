# Globle Discord Activity

Play [**Globle**](https://globle-game.com/) inside Discord, on a fullscreen world map, using the
**real, official daily answer** from globle-game.com.

The map is a board: countries are extruded into low plates on a framed world map, seen from the
shallow angle a war game is played at, and a flat 2D view is one button away.
Each guess is shaded by how close it is, on the same square-root distance scale the real game uses.
Country names are available in English and German.

Everyone playing the daily appears on a live roster, the group carries a shared streak, and a
practice button deals a random country when the daily is done.

## How it gets the real answer

The app talks to globle-game.com exactly the way the official web client does:

1. `GET https://globle-game.com/answer?day=YYYY-MM-DD&list=197` returns the day's answer as an
   AES-encrypted country index.
2. It decrypts it (CryptoJS-compatible AES, passphrase mode) to an index into the official
   197-country dataset (`data/country_data.json`).
3. Proximity for each guess is the minimum great-circle distance between the guess's and the
   answer's polygon borders, a port of the game's own `distance.ts`.
4. Guesses are shaded on the game's square-root distance scale, over a warm ramp pitched to hold its
   chroma against the board's water, green for the answer. The shareable grid uses the game's emoji
   bands (🟥 🟧 🟨 ⬜ → 🟩).

No scraping of "answer of the day" blogs, and no external map or tile service: the board is drawn
from the same local polygons that score the guesses.

## Architecture

One Node process does two jobs.

**The activity server** hosts the built client and the game API.
Discord serves the activity from `https://<application id>.discordsays.com` and reverse-proxies it
here, so the client is a static bundle and every request it makes is relative.

**The gateway client** opens the activity from `/globle` and posts the finish announcement into a
channel.
An activity runs in the browser and cannot create a message, so a bot token is the only way to
announce anything.

Game rules live in `src/game.js`, which knows nothing about Discord or HTTP. The daily and practice
are the same rules over a different answer, so they cannot drift apart.

The game is played entirely inside the activity. Chat has one command, and it only opens the map.

### Everyone plays together

Each open activity holds a server-sent-events connection. Any change to the day pushes a fresh
roster to every one of them: who is playing, whether they are online, how far along they are, and
the boards of those who have finished.

The roster is filtered per viewer, and that filter is the whole design.
A player still guessing sees only counts, because knowing that someone else's board is red hot
would say where the answer is.
Finishing unlocks the other finishers' boards for that viewer.
A player still in progress never has their guesses sent to anyone.

The server decides this; the client renders whatever it is given. `player.guesses` arrives as `null`
when it is not the viewer's to see, so there is no flag the browser could flip.

### The group streak

How many days running the group has solved the daily. One person winning carries everyone, and an
unsolved day only breaks it once it is over: today counts as pending, not as a miss.

It rides on the roster, so it is on screen while playing, and the day's summary reports where it
stands.

### Practice

A random country, belonging to one player, on the same board. It never announces, never reaches the
roster, and never counts toward stats or the streak: a practice game is recorded beside the player's
language preference rather than under a date, so nothing that reads a day can pick one up.

### Hard mode

Kilometres are a readout the colour ramp can only approximate, and two numbers triangulate the
answer in a way two shades do not.
A hard game withholds them: every guess keeps its colour and its place in the ranking, and only the
closest one carries a distance.
The board is otherwise the normal board, sorted the same way, so the number sits on the top row.

The mode belongs to one game rather than to the player.
It can be switched until the first guess lands, and is fixed after that, so a player cannot turn the
hiding off and read back the distances the game had been keeping from them.
The choice is remembered as the mode the next game starts in.

The server never sends the distances a hard game hides, so there is no field the browser could read
around the missing numbers.
It also does the sorting, since a client cannot rank rows whose distances it was never given.
Finishing gives every distance back, which is what keeps a hard game comparable with everyone
else's in the roster.
Roster rows mark the players who are playing hard.

### Globle is a server game

There is no private game. The roster, the group streak and the channel announcement all belong to a
channel, so a game in a direct message would have nobody to share it with.

Two gates enforce that.
`/globle` and the Entry Point command are both registered for guild install and the guild context
alone, which is what keeps them out of the DM command list.
Registration is a filter Discord applies in its own client, though, and the activity's URL is public,
so the handshake in `src/server.js` is the gate that holds: it asks Discord where the instance is
running and refuses anything whose `location.kind` is not `gc`.

That refusal is fail-closed.
A lookup that errors says nothing about where the instance sits, so it is answered the same way as a
DM, and the player reopens the activity.
The lookup is retried first, because a browser can reach the handshake before Discord has registered
the instance.

### The activity never sends a direct message

Outbound DMs need no gateway intent, so trimming intents would not prevent them.
Three layers do:

- `src/announce.js` owns the only `send` call in the app, and refuses any channel where
  `isDMBased()` is true.
- `src/client.js` overrides `UserManager#createDM` to throw. Every discord.js route to a DM
  (`user.send`, `member.send`, `client.users.send`, `user.createDM`) funnels through it.
- The same file makes the raw `POST /users/@me/channels` request throw, for anything that reaches
  past the manager into the REST layer.

The channel an announcement goes to is resolved from Discord's own activity-instance lookup rather
than from anything the browser said, and the only instances that get past the handshake are the ones
running in a guild channel.

### Announcements mention players

The finish line names the finisher, as a real mention that pings.
That needs `<@id>` in the content *and* an `allowed_mentions` object listing that id;
`allowed_mentions.parse` is mutually exclusive with `allowed_mentions.users`, and sending both is
rejected.
The client's default is `{ parse: [] }`, so nothing pings unless a send opts in.
An id that is not a snowflake, which a `DEV_LOGIN` session or a hand-written state fixture can
produce, is written out by name instead: Discord rejects a whole message over one malformed entry in
`allowed_mentions`.

An announcement describes one player's run and nothing else. The rest of the day, who else played
and where the streak stands, belongs to the summary. It carries the emoji grid, the guess count and
the mode, never the country or the map, so it is safe to post where others have not played yet.

The message is text only, with no attachment, so it reads the same on a phone, in a client with
images turned off and through a screen reader.

A hard game is badged in the message, because a guess count only compares against the rules that
produced it.

### The day's summary

Once the date rolls over, each channel that played gets one closing message: the answer, the day's
finishers in order with their grids and modes, who gave up, who never finished, and where the group
streak stands.
It is the only message that names the country, and it can, because the game it belongs to is over.

Players are named in plain text rather than mentioned.
This lands at midnight, and a ping at midnight is an alarm clock.

`src/summary.js` asks once a minute whether the previous day is finished and unposted, rather than
setting a timer for midnight.
A timer is lost to every restart, redeploy and suspend; the question survives all three.
A posted day is marked as posted in the store, so a restart finds the work already done instead of
repeating it, and only the previous day is ever considered: a bot that was down for a week comes
back to one summary rather than seven.

The channel is the one thing the summary cannot look up when it runs, because the activity sessions
that knew it are gone by then.
It is written onto each player's record for the day as they play, which is also what splits a
summary per channel when the same day was played in more than one.
The language of each is whichever its players chose most.

## German

Country names come from the dataset's own `NAME_DE`, corrected by `data/german_names.json` where
that value is wrong (its `NAME_DE` for Georgia is "Abchasien") or too long to read on a map label.
That file also carries the German spellings players type that are not the dataset's own:
"Holland", "Weißrussland", "Elfenbeinküste", "England", "USA".

Names resolve in every supported language whatever the active one is, and umlauts match whether
they are typed as `ü` or `ue`.
Games store the canonical English name, so switching language relabels past guesses instead of
invalidating them.

The language defaults to the player's Discord language and is changed with the toggle in the
activity.
An explicit choice is remembered; a detected one is not, so a player who later switches Discord to
German follows along.
The roster resolves each viewer's language on every push, so switching relabels other players' rows
without reconnecting the stream.

## Setup

### 1. Create the application

At <https://discord.com/developers/applications>:

1. **New Application**, give it a name.
2. **Bot** -> **Reset Token** -> copy it. This is `DISCORD_TOKEN`.
3. **General Information** -> copy the **Application ID**. This is `CLIENT_ID`.
4. **OAuth2** -> **Client Secret** -> **Reset Secret** -> copy it. This is `CLIENT_SECRET`.
5. **OAuth2** -> **Redirects** -> add `https://127.0.0.1`. The SDK handles the redirect itself, but
   the field cannot be empty or `authorize` fails.
6. **Activities** -> **Settings** -> tick **Enable Activities**. This sets the app's `EMBEDDED`
   flag, which is what the activity shelf filters on, and creates a default Entry Point command.
7. On that same page, under **Supported Platforms**, tick every platform to be tested. An activity
   does not appear on a platform that is not ticked.
8. **Installation** -> enable **Guild Install** and leave **User Install** off. A user-installed app
   follows its owner into direct messages, which is where Globle refuses to run anyway.

### 2. Configure and run

```bash
cp .env.example .env      # fill in DISCORD_TOKEN, CLIENT_ID, CLIENT_SECRET, GUILD_ID
docker compose --profile tunnel up -d --build
```

The `tunnel` profile starts a cloudflared quick tunnel, which is how the activity gets the public
HTTPS address Discord requires.
Read the hostname it was given:

```bash
curl -s localhost:20241/quicktunnel
```

### 3. Point Discord at the tunnel

**Activities** -> **URL Mappings** -> set the target of the `/` prefix to that hostname.

Omit the scheme: `something.trycloudflare.com`, not `https://something.trycloudflare.com`.
A quick tunnel gets a new hostname every time it restarts, so this has to be re-pasted after each
restart. A named tunnel on a domain you own gets a fixed hostname and avoids that.

### 4. Register the command

```bash
docker compose run --rm app npm run deploy
```

With `GUILD_ID` set this registers `/globle` to that server instantly.
Run it once without `GUILD_ID` to register the global Entry Point command that puts the activity in
the app launcher; global commands take up to an hour to appear.

The global registration includes the Entry Point command deliberately. Discord rejects a bulk
overwrite that would delete it, so leaving it out fails the whole call.

### 5. Launch it

Invite the app, with `bot` scope so it can post announcements:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3072&integration_type=0
```

`3072` is View Channel plus Send Messages, which is all the announcement needs.

Then, in Discord: **User Settings** -> **Advanced** -> turn on **Developer Mode**, join a voice
channel in the test server, and open the activity shelf from the rocket button.
Apps you own appear there without being installed, which is the quickest way to test.
Launching also needs the **Use Activities** permission in that channel.

## Working on the map without Discord

The Embedded App SDK refuses to start outside Discord's iframe, so the activity cannot simply be
opened in a browser.
`DEV_LOGIN` starts a session without Discord for exactly that case:

```bash
docker run --rm -p 3000:3000 -e DEV_LOGIN=1 -e STATE_FILE=/tmp/state.json \
  -v "$PWD:/app" -w /app node:22-bookworm-slim node src/index.js
```

Then open <http://localhost:3000>.
The route hands a session to anyone who asks, so it is refused unless `DEV_LOGIN=1` and `NODE_ENV`
is not `production`, and a session made this way gets no channel and cannot announce anything.

Each tab becomes a separate player, so opening two shows the roster updating live from one machine.

## Replaying the daily

Everything that happens once a day is otherwise testable once a day: the win, the give-up, the
channel announcement, the streak.
`DEV_RESET=1` puts a **↺ Reset** button in the topbar that throws today's game away so it can be
played again.

Clicking it clears the player's own board.
Shift-clicking clears the whole date, every player on it and the cached answer index with them.
The answer itself does not change: it belongs to the date, so a replay is a replay of today's
country.

With compose, put `DEV_RESET=1` in `.env` and recreate the container:

```bash
docker compose up -d
```

`DEV_LOGIN` is refused when `NODE_ENV` is `production` and this is not, because the image sets
`NODE_ENV=production` and an announcement can only be tested from inside Discord.
The flag is therefore the only thing standing between the channel and the button: while it is set,
anyone who can open the activity can wipe the day, so unset it and recreate the container when the
testing is done.

The endpoint behind the button is `POST /api/dev-reset`, taking `{"scope": "self" | "day"}`.

Rebuild the client after changing anything under `client/`:

```bash
docker run --rm -v "$PWD:/app" -w /app/client -e VITE_DISCORD_CLIENT_ID=<app id> \
  node:22-bookworm-slim sh -c 'npm ci && npm run build'
```

## Commands

`/globle` opens the map, and that is the only command. Discord's own Entry Point command
(`globle-activity`) does the same from the app launcher; `/globle` exists because it registers to one
server instantly, while the global entry takes up to an hour to propagate.

## Persisting data

Container filesystems are ephemeral, so `state.json` belongs on a volume or player history resets
on every deploy.
The compose file mounts a named volume at `/data` and the image sets `STATE_FILE=/data/state.json`.

The path resolves as `STATE_FILE`, then `RAILWAY_VOLUME_MOUNT_PATH`, then `data/state.json` for
local runs. The directory is created automatically.

## Project layout

```
src/index.js         Entry point: gateway client, launcher command, activity server
src/server.js        HTTP: serves the built client, the game API, the OAuth exchange
src/events.js        The roster stream, and the per-viewer spoiler filter
src/game.js          Game rules for the daily and practice, plus the group streak
src/globle.js        Answer fetch and decrypt, distance, colour bands, name matching
src/colour.js        The proximity colour ramp, single-sourced
src/announce.js      Channel announcements. The only place that sends a message
src/summary.js       The day's closing summary, and the rollover it waits for
src/client.js        Gateway client, and the DM lockdown
src/launch.js        `/globle`, which opens the activity
src/session.js       Activity session tokens
src/discord-api.js   REST calls the OAuth handshake needs
src/geometry.js      The country geometry the map is built from
src/store.js         Games, practice games and per-player preferences
client/src/main.js   Activity startup
client/src/api.js    The API client and the stream reader
client/src/board/    The 2.5D board, the flat map, and the GeoJSON-to-mesh pipeline
client/src/ui.js     Guess entry, guess list, roster, toggles
data/                Official country dataset, name aliases, German names
deploy-commands.js   Registers `/globle` and the Entry Point
```

## Credits

Globle is created by [The Abe Train](https://the-abe-train.com/) /
[Trainwreck Labs](https://trainwreck.fun/).
This is an unofficial client that uses the game's public daily answer endpoint and open country
data. All game data and the answer service belong to the original authors.
