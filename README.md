# chsengine console

Turn a chess engine you've built into a bot that plays real games on
Lichess — no coding required to run it, just a web page.

Haven't built an engine yet? Use the **[chess.lab builder](https://merlin2lmml.github.io/chess.lab/builder/)**
to put one together, then come back here to bring it to life on Lichess.

Try the console: https://github.com/Merlin2LmmL/chsengine-console

## What it does

You give it two things — your engine, and a Lichess bot account to play
under — and it takes care of the rest:

- accepts challenges from other players, or goes looking for games itself
- plays moves by asking your engine for its best move each turn
- keeps a live board and a running win/loss/draw record
- can send a hello message and reply to chat commands during games

Everything runs in your browser. There's nothing to install and nothing
running on a server somewhere.

## Getting started

1. **Make a Lichess account for your bot** (a separate account from your
   own — bots can't also be played by a human). On Lichess, upgrade it to a
   bot account and grab an API token for it under Preferences → API access
   tokens.
2. **Open the console** in your browser.
3. **Load your engine** by dragging its file onto the drop zone. Made it
   with the [builder](https://merlin2lmml.github.io/chess.lab/builder/)?
   Just export it from there and drop it in.
4. **Paste in your bot's token** and hit Connect.

That's it — your bot is live. Anyone can find and challenge it on Lichess,
or you can have it look for games automatically (see below).

## Getting around the console

**Engine bundle** — shows which engine is currently loaded, and lets you
load a different one.

**Time management** — how long your bot thinks before playing a move.
Choose a fixed search depth for consistent behavior, or let it manage time
dynamically based on the clock, so it speeds up when time is short.

**Matchmaking** — how your bot finds games. Turn on auto-accept to have it
take challenges automatically (you choose which time controls and rated vs.
casual games it's willing to play), or leave it off and accept/decline by
hand. You can also have it actively go looking for games: post an open
challenge, challenge specific players, or challenge random bots that are
online — with a rating range so it's only picking fights close to its own
strength.

**Chat** — have your bot greet opponents at the start of a game, and
optionally respond to simple chat commands typed by whoever it's playing.

**Active games / Record** — watch games in progress live, and see how your
bot is doing overall.

## A note on tokens

Whatever token you use is stored only in your own browser — never sent
anywhere except to Lichess itself, and never saved anywhere public. Still,
don't share it or paste it somewhere others can see it.
