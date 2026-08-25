# Troubleshooting

## The app won't open — "damaged" or "cannot be opened"

The build is unsigned. macOS quarantines anything downloaded without a Developer ID signature.

Right-click the app → **Open** → **Open**. Once is enough. Or:

```bash
xattr -dr com.apple.quarantine "/Applications/Torrent Downloader.app"
```

## The app opens and immediately quits

Almost always a second instance. The app takes a single-instance lock on its data directory, and a second launch hands its arguments to the running copy and exits — by design.

Check whether it's already running (menu bar, or `⌘Tab`). If the menu bar item is enabled, closing the window leaves the session running in the background; that's intentional so downloads continue.

If nothing is running and it still quits instantly, a stale lock is the likely cause:

```bash
rm -f ~/Library/Application\ Support/Torrent\ Downloader/Singleton*
```

## Blank window in `npm run dev`

Vite's React plugin injects the React Refresh preamble as an inline `<script>`. If the Content Security Policy in `app/main/main.ts` doesn't allow `'unsafe-inline'` for scripts in development, that block is refused, no component module can load, and the window renders empty.

The dev-only relaxation is already in `applyContentSecurityPolicy()`. If you tighten it, this is what breaks. The packaged app keeps the strict policy.

## "Unable to retrieve torrent metadata"

A magnet has no file list — it must be fetched from peers, so at least one has to be reachable.

- **A magnet with no trackers** relies entirely on DHT, which is slow and often blocked. Check the info hash in the preview and prefer a magnet with `tr=` parameters.
- **Dead torrent.** No seeders means no metadata, and there is nothing the client can do.
- **Network blocking peer traffic.** Many corporate, university and hotel networks block BitTorrent outright. Test the plumbing:

```bash
# UDP tracker reachable?
nc -zvu tracker.opentrackr.org 1337
# DHT bootstrap reachable?
nc -zvu dht.transmissionbt.com 6881
```

If those fail, the network is blocking you, not the app. `router.bittorrent.com` has been unreliable for years — don't use it as a test.

## Downloads sit at 0% with peers connected

- **Every file is skipped.** Check the Files tab — the app refuses an all-skipped add, but priorities can be changed later.
- **Download limit set very low.** Check the bandwidth button in the title bar; a stale 100 KB/s cap looks like a stall.
- **Still hashing.** A large torrent shows `Checking` while it verifies existing data. That's real work, not a hang.

## Downloads stall just short of 100%

Fixed in this client, but worth knowing the cause: files share the piece on their boundary, so deselecting a skipped file used to strip that piece from its selected neighbour. If you see this on a build from before that fix, **Recheck Files** then resume.

## "Download directory unavailable"

The folder was moved, renamed, unmounted, or lost write permission — common with external drives and network volumes. Re-select it in Settings → Downloads, or per torrent.

The app also refuses protected system locations (`/System`, `~/.ssh`, `~/Library/LaunchAgents`, and similar) as download targets.

## A file was "renamed for safety"

The torrent asked to write to a path that would have escaped the download folder, collided with another file, or contained characters that are unsafe or invisible. The file is saved under a corrected name inside your chosen folder. Hover the file to see the original path.

This is normal defensive behaviour and does not mean the torrent is malicious — plenty of legitimate torrents have sloppy paths.

## Slow downloads

- Throughput is below a native client on large swarms; the engine is JavaScript. Expect good but not libtorrent-class speeds.
- Check the bandwidth limit in the title bar.
- Peer counts matter more than anything: `Seeds 0` means nothing to download from.
- In Settings → Bandwidth, confirm **DHT**, **peer exchange** and **µTP** are on. Requiring protocol encryption reduces the pool of reachable peers — `Prefer encryption` connects to more.
- **Maximum active downloads** queues the rest; torrents beyond it show `Waiting`.

## Seeding stops sooner than expected

Check the seed goal — globally in Settings → Seeding, or per torrent in the details panel. The default stops at ratio 1.0. A finished torrent past its goal shows `Completed`; **Start Seeding** shares it again regardless of the goal.

## The `magnet:` link handler doesn't work

Only the **packaged** app can register as a handler, and it must be launched at least once. It does not work in `npm run dev`. If another client is registered, macOS keeps it until you change the default.

## Where are my logs?

**Settings → Advanced → Open Logs Folder**, or:

```
~/Library/Application Support/Torrent Downloader/logs/torrent-downloader.log
```

Enable **Verbose logging** in Settings → Advanced before reproducing an issue. Logs never contain credentials, and peer addresses stay out of the file unless verbose logging is on.

## Where is my data?

```
~/Library/Application Support/Torrent Downloader/
├── settings.json     preferences
├── torrents.json     session: paths, selections, progress bitfields
├── torrents/         saved .torrent metadata, one per info hash
└── logs/
```

Deleting `torrents.json` clears the list without touching downloaded files. A development build (`npm run dev`) uses `torrent-downloader/` — lowercase, a separate directory — so the two keep independent sessions.

## Build problems

**`npm install` fails compiling native modules** — install Xcode Command Line Tools with `xcode-select --install`. All three addons are optional; without them you lose µTP and fall back to TCP.

**`electron-builder` fails signing** — the config sets `identity: null` on purpose. If you have a Developer ID and want a signed build, set it in `electron-builder.yml`.

**Packaged app loses µTP** — the native addon must sit outside the asar archive. Check `asarUnpack` in `electron-builder.yml`, then verify:

```bash
find "/Applications/Torrent Downloader.app/Contents/Resources/app.asar.unpacked" -name '*.node'
```

Settings → Advanced reports whether µTP is available in the running build.

## Reporting a bug

Include the app version and µTP status from Settings → Advanced, the relevant log section with verbose logging on, and what you expected versus what happened. Please don't include magnet links or torrent names you'd rather not have in a public issue.
