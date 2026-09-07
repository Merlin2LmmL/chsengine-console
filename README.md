# chsengine console

Turn a chess engine into a Lichess bot — right in your browser. No server, no install, just load your engine, paste a token, and play.

Make an engine at the **[chess.lab builder](https://merlin2lmml.github.io/chess.lab/builder/)** with JavaScript, or build one in WebAssembly. Drop the bundle here to start playing.

Try it: https://github.com/Merlin2LmmL/chsengine-console

## What you get

- Load your engine (JavaScript or WebAssembly bundle) and connect a bot account.
- Accept challenges automatically or hunt for games yourself (open challenges, targeted users, random bots).
- Watch live boards, track wins/losses/draws, and send greetings/chat replies.
- Everything stays in your browser; your token lives only in local storage.

## Quick start

1. **Bot account**: Make a separate Lichess account, upgrade to bot, grab an API token (Preferences → API access tokens).
2. **Open the console** in your browser.
3. **Load the engine**: drag your `.zip` onto the drop zone. Built with the builder? Export from there and drop it in.
4. **Connect**: paste the token, hit Connect.

Your bot is live. Others can challenge it, or turn on auto-queue to find games on its own.

## The console in plain language

**Engine** — which engine is loaded; load or swap anytime.

**Time** — fixed depth for consistent play, or clock-aware search that speeds up when time is low.

**Matchmaking** — auto-accept with filters (time control, rated/casual), post open challenges, challenge specific players/rating ranges, or challenge random bots with cooldowns.

**Chat** — greet opponents, reply to simple commands.

**Games / Record** — live board view and overall stats.

## About your token

Your token is kept only in this browser, sent only to Lichess, and not stored publicly. Don't share it.

## Engine library

The console supports `js-algo` (JavaScript) and `wasm-uci` (WebAssembly) bundles. Use the Engine library panel to store bundles persistently in-browser via indexedDB, load them later, or remove them. Bundles follow the `chsengine` format (`manifest.json` + `entry.js` + assets).

Engines can be made on the chess.lab builder with JavaScript or via WebAssembly. Both work here.
