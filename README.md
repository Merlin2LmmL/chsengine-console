# chsengine console

A static, GitHub Pages-hosted control panel for running a `chsengine`-format
bot on Lichess. It talks to the Lichess Bot API directly from the browser —
no backend, no build step.

## Deploy

1. Create a repo (or reuse one), put all these files at the root (or in
   `docs/` if you'd rather keep them out of the way).
2. Push to GitHub.
3. Repo Settings → Pages → Deploy from a branch → pick `main` and `/ (root)`
   (or `/docs`). Save.
4. Your console is live at `https://<user>.github.io/<repo>/`.

No JSZip/npm install needed — `index.html` pulls JSZip and chess.js from
cdnjs at load time.

## Before you use it: about the token

**Do not put your Lichess API token in any file you commit.** The token is
entered into the page at runtime and kept only in `localStorage` in your own
browser — it never touches the repo or any server. Still, `localStorage` is
plaintext and readable by any script running on the page, so:

- Only use this on a device/browser you trust.
- If a token ever leaks (pasted somewhere public, committed by accident,
  shared in chat, etc.), go to Lichess → Preferences → API access tokens and
  revoke/regenerate it immediately. A leaked bot token lets someone play
  games, resign, or chat as your bot — nothing scarier than that (it can't
  touch your Lichess account password or other data), but it's still not
  something you want floating around.

## Using it

1. **Engine bundle** — drop your `chsengine` `.zip` (or the raw
   `manifest.json` + `entry.js` + assets) onto the drop zone. It's parsed and
   kept in `localStorage` so you don't have to re-upload every session.
2. **Token** — paste your bot account's API token (needs the `bot:play`
   scope) and hit **Connect**. The console checks `/api/account`; if the
   account isn't `BOT`-titled yet, it warns you (upgrade once via
   `POST /api/bot/account/upgrade`, or `python-lichess`/curl/etc — this
   console doesn't do the upgrade for you since it's a one-way, one-time
   action you should trigger deliberately).
3. **Time management** — pick static or dynamic depth (see below) and tune
   it under "Time management".
4. **Matchmaking** — toggle auto-accept and the speed/rated filters, or leave
   it off and accept/decline challenges by hand as they show up under
   "Incoming challenges".
5. Games appear under "Active games" as they start; click one to see its
   board, clock, and search telemetry live.

### Static vs. dynamic depth

- **Static**: every move searches to a fixed depth (`go depth N`), capped by
  a generous safety movetime so the search isn't cut off mid-iteration. Good
  for consistent behavior / benchmarking, bad for time scrambles.
- **Dynamic**: depth is uncapped up to a sanity ceiling; instead each move
  gets a computed time budget from the current clock:

  ```
  budget = remaining/estMovesLeft + increment*incrementWeight
  budget = min(budget, remaining * maxFractionOfRemaining)
  budget = clamp(budget, minMoveMs, maxMoveMs)
  ```

  `maxFractionOfRemaining` is the actual flag-fall guard: no single move can
  ever eat more than that fraction of what's left, regardless of what the
  rest of the formula says. `overheadMs` is subtracted from the clock first
  to leave margin for network latency to Lichess before you'd get flagged.

Either way, the engine bundle itself hard-caps every search at 15s
(`HARD_SAFETY_MS` in `entry.js`) no matter what this page sends it.

## How it talks to your bot format

Your `chsengine` bundle (`manifest.json` + `entry.js` + assets) is run
exactly as designed: `entry.js` is spun up as a `Worker`, and asset files
are handed to it as blob URLs encoded into the worker script's URL hash —
`entry.js` decodes that at startup and `importScripts()`s what it needs. One
`Worker` is spawned per concurrent game, so simultaneous games never share
engine-internal state (transposition table, killer moves, etc).

Communication is the plain-text UCI-lite line protocol `entry.js` already
implements: `uci` / `isready` / `ucinewgame` / `position startpos moves ...`
/ `go depth N [movetime N]` / `stop`, with `bestmove ...` and `info depth ...
score cp ... nodes ... nps ... time ...` coming back. The live telemetry
strip under the board is literally these `info` lines' `score` and `depth`
fields, nothing synthetic.

This console currently only runs bundles with `"kind": "js-algo"` (a plain
JS/worker engine, which is what your bundle is). If you later add a wasm
variant, `engineLoader.js`'s asset-handling is already generic — it maps
every file in `manifest.assets` (and `wasmAsset`, if set) to a blob URL and
hands the whole map to the worker the same way, so wiring up
`"wasmStrategy": "locateFile-module"` support inside `entry.js` shouldn't
require changes here.

## Files

```
index.html          layout + CDN deps (JSZip, chess.js)
style.css            theme
js/store.js          localStorage helpers
js/engineLoader.js    chsengine bundle parsing + Worker/UCI-lite protocol
js/lichessClient.js   Lichess Bot API client (account, event stream, game stream, moves)
js/timeManager.js     static/dynamic depth -> go-params
js/board.js           dependency-free SVG board renderer
js/main.js             wires it all together + all the UI
```

## Known limitation: CORS

The Lichess Board/Bot API is built for third-party clients and serves CORS
headers accordingly, so this should work as-is from a GitHub Pages origin.
If you ever do hit a CORS error in the browser console, that's Lichess
rejecting the specific request (not something fixable client-side) — the
usual escape hatch is a tiny serverless proxy (Cloudflare Worker, Vercel
Edge Function, etc.) that forwards requests and adds the token
server-side. Not needed unless you actually see the error.
