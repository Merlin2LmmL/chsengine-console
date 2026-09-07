// lichessClient.js
//
// Minimal wrapper around the Lichess Bot API (https://lichess.org/api).
// Every call is a plain fetch() with an Authorization: Bearer header, so this
// only works for endpoints Lichess serves with CORS enabled for third-party
// clients, which the Board/Bot API family is designed for.

const BASE = 'https://lichess.org';

export class LichessError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class LichessClient {
  constructor(token) {
    this.token = token;
  }

  _headers(extra = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(BASE + path, {
      ...opts,
      headers: this._headers(opts.headers),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      throw new LichessError(`${opts.method || 'GET'} ${path} -> ${res.status}`, res.status, body);
    }
    return res;
  }

  async getAccount() {
    const res = await this._fetch('/api/account');
    return res.json();
  }

  /**
   * Stream newline-delimited JSON from `path`, calling onLine(obj) for each
   * parsed line, until the stream ends or `signal` aborts it.
   */
  async streamNdjson(path, onLine, signal) {
    const res = await fetch(BASE + path, { headers: this._headers(), signal });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      throw new LichessError(`GET ${path} -> ${res.status}`, res.status, body);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          // `onLine` is async (it drives the engine and awaits Lichess API calls). It must be
          // awaited here, not just invoked: without this, a fast pair of events (e.g. gameFull
          // immediately followed by a gameState) can start processing concurrently, racing on
          // shared per-game state (the chess.js position, the engine's in-flight search) and
          // sending overlapping "position"/"go" commands to the same engine worker. Any error
          // thrown after onLine's first await also used to become a silent unhandled promise
          // rejection here — invisible to the UI, so a game could just stop updating with
          // nothing logged. Awaiting it puts both failure modes under this try/catch.
          try { await onLine(JSON.parse(line)); }
          catch (e) { console.warn('lichess: error handling ndjson line', line, e); }
        }
      }
    }
  }

  streamEvents(onEvent, signal) {
    return this.streamNdjson('/api/stream/event', onEvent, signal);
  }

  streamGame(gameId, onEvent, signal) {
    return this.streamNdjson(`/api/bot/game/stream/${gameId}`, onEvent, signal);
  }

  acceptChallenge(id) {
    return this._fetch(`/api/challenge/${id}/accept`, { method: 'POST' });
  }

  declineChallenge(id, reason = 'generic') {
    return this._fetch(`/api/challenge/${id}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reason }),
    });
  }

  makeMove(gameId, uciMove, offeringDraw = false) {
    const q = offeringDraw ? '?offeringDraw=true' : '';
    return this._fetch(`/api/bot/game/${gameId}/move/${uciMove}${q}`, { method: 'POST' });
  }

  resign(gameId) {
    return this._fetch(`/api/bot/game/${gameId}/resign`, { method: 'POST' });
  }

  abort(gameId) {
    return this._fetch(`/api/bot/game/${gameId}/abort`, { method: 'POST' });
  }

  handleDrawOffer(gameId, accept) {
    return this._fetch(`/api/bot/game/${gameId}/draw/${accept ? 'yes' : 'no'}`, { method: 'POST' });
  }

  /** One-time, irreversible: upgrade this account to a BOT account. */
  upgradeToBot() {
    return this._fetch('/api/bot/account/upgrade', { method: 'POST' });
  }

  /** Currently-online bot accounts (public endpoint). Resolves with an array of account objects. */
  async fetchOnlineBots(nb = 50) {
    const bots = [];
    await this.streamNdjson(`/api/bot/online?nb=${nb}`, (obj) => bots.push(obj));
    return bots;
  }

  chat(gameId, room, text) {
    return this._fetch(`/api/bot/game/${gameId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ room, text }),
    });
  }

  /** Build the clock/days form fields shared by open + direct challenges.
   * Pass either {clockLimit, clockIncrement} (real-time) or {days} (correspondence). */
  _clockParams({ clockLimit, clockIncrement, days }) {
    if (days != null) return { days: String(days) };
    return { 'clock.limit': String(clockLimit), 'clock.increment': String(clockIncrement) };
  }

  /** Post an open challenge (anyone with the link can accept). Returns the parsed JSON body. */
  async createOpenChallenge({ clockLimit, clockIncrement, days, rated = false, variant = 'standard' }) {
    const res = await this._fetch('/api/challenge/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        rated: String(!!rated),
        ...this._clockParams({ clockLimit, clockIncrement, days }),
        variant,
      }),
    });
    return res.json();
  }

  /** Challenge a specific username directly. Returns the parsed JSON body. */
  async challengeUser(username, { clockLimit, clockIncrement, days, rated = false, variant = 'standard' }) {
    const res = await this._fetch(`/api/challenge/${username}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        rated: String(!!rated),
        ...this._clockParams({ clockLimit, clockIncrement, days }),
        variant,
      }),
    });
    return res.json();
  }
}
