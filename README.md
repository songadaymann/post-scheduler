# post-scheduler

Posts pre-approved X posts at fixed Eastern Time moments for Song a Day promo. Commissions, WAMP, and donations live in one library so two campaigns cannot land on top of each other.

Nothing is posted unless `POST_SCHEDULER_ENABLED=1`. Any other value, including leaving it unset, validates the library and prints the schedule. `--preview` does that even when posting is enabled.

The committed files in `posts/` are templates. Replace them before you enable posting. This repo is public: do not commit credentials, the state file, or real unreleased copy.

## Setup

Clone or copy the repo to `~/Projects/post-scheduler`, then:

```bash
cd ~/Projects/post-scheduler
npm install
cp .env.example .env
```

Fill in `.env`. The file is gitignored. Names only, no sample secrets, are in `.env.example`:

| Name | Required | Purpose |
| --- | --- | --- |
| `POST_SCHEDULER_ENABLED` | to post | Set to `1` to post. Anything else only previews. |
| `TWITTER_API_KEY` | to post | OAuth 1.0a app key |
| `TWITTER_API_SECRET` | to post | OAuth 1.0a app secret |
| `TWITTER_ACCESS_TOKEN` | to post | User access token |
| `TWITTER_ACCESS_SECRET` | to post | User access token secret |
| `TWITTER_USERNAME` | no | Handle used only to build the status URL. Defaults to `songadaymann`. |

Video posts need `ffmpeg` (`brew install ffmpeg`). Text-only posts do not.

Check the install:

```bash
npm run typecheck
npm run self-test
```

`--self-test` uses a mocked poster and does not touch the network or your `.env`.

## Preview and enable

Preview never posts and does not need API keys:

```bash
cd ~/Projects/post-scheduler
npm run preview
```

That is the same as `npx tsx src/cli.ts --preview`.

When the schedule looks right and the template text is gone, turn posting on for one run:

```bash
# in .env
POST_SCHEDULER_ENABLED=1

npm start
```

Equivalent:

```bash
POST_SCHEDULER_ENABLED=1 npx tsx src/cli.ts
```

`--preview` still refuses to post if that variable is already `1`.

## What a run does

Posts come from `posts/*.md` (every markdown file except `README.md`). `scheduler.config.json` sets the spacing, the staleness cutoff, banned phrases, and optional send windows.

On an enabled run the process takes a lock in `data/scheduler/` (gitignored). If another run holds the lock, this one skips. Then, in schedule order:

- An id that already posted or was marked missed is skipped. Each id posts at most once.
- A post more than 2 hours late is marked missed and is not sent. A missed id stays missed; give a corrected post a new id.
- A post whose time has not arrived yet waits.
- A post that failed earlier waits until its backoff time. Backoff is 5, 10, 20, then 30 minutes, and it never schedules an attempt after the 2 hour cutoff.
- Otherwise it posts the text, with the video or image if the post has a `media` path.

The guarantee depends on `data/scheduler/state.json`. Deleting that file lets an id post again. Do not commit it. If a run dies after the status was saved as `posting`, the next runs will not retry it (that avoids a duplicate). Check X, then set that record to `posted` or back to `pending`.

Text length is Unicode code points, capped at 280. That is the raw character count, which is stricter than X's shorter t.co URL weight.

## Library format

One file per campaign. Times are America/New_York wall times. A `## Retired` heading, and everything after it, is ignored. Put the exact post in a `text` fence so line breaks stay intact.

```markdown
campaign: commissions

### comm-2026-12-01

scheduled: 2026-12-01 10:00 America/New_York
media: media/example-clip.mp4

```text
First line.

Second line after a blank line.
```

## Retired

### old-id

scheduled: 2025-01-01 10:00

```text
This is not scheduled.
```
```

`media` is optional. Paths are relative to the repo root, absolute, or `~/...`. Videos may be `.mp4`, `.mov`, `.m4v`, or `.webm`. Images may be `.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp`. Clips longer than 140 seconds are rejected and are not trimmed.

Validation fails the run, before any post, when it finds:

- more than 280 characters, or empty text
- a duplicate id
- an invalid, nonexistent, or ambiguous Eastern Time (including the daylight-saving overlap)
- more than one post for the same campaign on the same Eastern day
- posts from different campaigns closer than `minSpacingHours` (default 2; exactly 2 hours is allowed)
- a banned phrase for that campaign (case-insensitive substring)
- a missing or unsupported media file
- a time outside that campaign's window when `outsideWindow` is `fail`

`outsideWindow` may be `warn` or `fail`, globally or per campaign. `warn` prints the problem and still allows the post. Shipped windows are start-inclusive and end-exclusive. Commissions ban: donate, donation, gift to the studio, tax-deductible, tax deductible, patron. Other campaigns do not inherit that list.

## Run every 10 minutes on macOS (launchd)

`launchd` does not inherit your shell profile. Point it at an absolute `node`, set `WorkingDirectory` so `.env` and the posts load, and keep API keys in `.env` rather than in the plist. The sample plist sets `POST_SCHEDULER_ENABLED=1`. A value already in the environment wins over `.env`, so the plist is what turns the agent on. `StartInterval` is 600 seconds, so a post can go out up to about 10 minutes after its scheduled minute, which is inside the 2 hour window.

Replace `YOURNAME` and the node path (`which node`; Apple Silicon Homebrew is often `/opt/homebrew/bin/node`). The same file is in `launchd/com.songaday.post-scheduler.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.songaday.post-scheduler</string>
  <key>WorkingDirectory</key>
  <string>/Users/YOURNAME/Projects/post-scheduler</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOURNAME/Projects/post-scheduler/node_modules/tsx/dist/cli.mjs</string>
    <string>/Users/YOURNAME/Projects/post-scheduler/src/cli.ts</string>
  </array>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>POST_SCHEDULER_ENABLED</key>
    <string>1</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOURNAME/Library/Logs/post-scheduler.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOURNAME/Library/Logs/post-scheduler.err.log</string>
</dict>
</plist>
```

Install and start it:

```bash
cp ~/Projects/post-scheduler/launchd/com.songaday.post-scheduler.plist ~/Library/LaunchAgents/
# edit YOURNAME and the node binary in ~/Library/LaunchAgents/com.songaday.post-scheduler.plist

launchctl bootout gui/$UID/com.songaday.post-scheduler 2>/dev/null || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.songaday.post-scheduler.plist
launchctl enable gui/$UID/com.songaday.post-scheduler
launchctl kickstart -k gui/$UID/com.songaday.post-scheduler
```

On older macOS, `launchctl load -w ~/Library/LaunchAgents/com.songaday.post-scheduler.plist` is the equivalent of bootstrap.

Watch the first run:

```bash
tail -f ~/Library/Logs/post-scheduler.out.log ~/Library/Logs/post-scheduler.err.log
```

Stop the agent:

```bash
launchctl bootout gui/$UID/com.songaday.post-scheduler
```

To keep the agent loaded but stop posting, set `POST_SCHEDULER_ENABLED` to `0` in the plist and bootstrap it again. Preview from a terminal whenever you want a dry run:

```bash
cd ~/Projects/post-scheduler
npm run preview
```
