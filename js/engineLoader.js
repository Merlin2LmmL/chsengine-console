// engineLoader.js
//
// Understands the "chsengine" bundle format (manifest.json + entry.js + assets),
// as produced by the chsengine builder (kind: "js-algo").
//
// Runtime contract implemented here, matching entry.js's own header comment:
//   - entry.js runs as a dedicated Worker.
//   - Asset URLs are handed to the worker by encoding them as JSON in the
//     Worker script URL's hash fragment: entry.js reads
//     JSON.parse(decodeURIComponent(self.location.hash.slice(1))) once at
//     startup and importScripts()s whatever it needs from that map.
//   - Communication after that is one line in / one line out over
//     postMessage, plain UCI-lite text, no envelope:
//       -> "uci"                                  <- "id name ...", "id author ...", "uciok"
//       -> "isready"                              <- "readyok"
//       -> "ucinewgame"
//       -> "position startpos moves e2e4 e7e5 ..."
//       -> "go depth 6"  |  "go movetime 3000"  |  "go depth 30 movetime 3000"
//                                                  <- "info depth N score cp X nodes N nps N time N pv M" (0+ times)
//                                                  <- "bestmove e2e4"
//       -> "stop"

export class BundleParseError extends Error {}

/**
 * Parse a raw chsengine bundle (given as {filename: content} where content is
 * a string for text files) into a validated, normalized descriptor.
 */
export function parseBundle(files) {
  const manifestRaw = files['manifest.json'];
  if (!manifestRaw) throw new BundleParseError('manifest.json missing from bundle');

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    throw new BundleParseError('manifest.json is not valid JSON: ' + e.message);
  }

  if (manifest.format !== 'chsengine') {
    throw new BundleParseError(`unrecognized format "${manifest.format}" (expected "chsengine")`);
  }
  const allowedKinds = ['js-algo', 'wasm-uci', 'rust-server'];
  if (!allowedKinds.includes(manifest.kind)) {
    throw new BundleParseError(`unsupported kind "${manifest.kind}" (expected one of ${allowedKinds.join(', ')})`);
  }
  if (!manifest.entry || !files[manifest.entry]) {
    throw new BundleParseError(`entry file "${manifest.entry}" not found in bundle`);
  }

  const assetNames = new Set(manifest.assets || []);
  if (manifest.wasmAsset) assetNames.add(manifest.wasmAsset);
  for (const name of assetNames) {
    if (!files[name]) throw new BundleParseError(`asset "${name}" listed in manifest but not present in bundle`);
  }

  return { manifest, files, assetNames: [...assetNames] };
}

function mimeFor(filename) {
  if (filename.endsWith('.wasm')) return 'application/wasm';
  return 'application/javascript';
}

// Sentinel prefix used to recognize our own diagnostic messages on the line stream,
// as opposed to lines coming from the engine itself.
const ENGINE_BRIDGE_ERROR_PREFIX = '!!__enginebridge_error__ ';

// Prepended to every bundle's entry script before it's executed as a Worker.
//
// Bundle authors' entry.js commonly load their wasm via `fetch(...).then(...)` chains
// with no `.catch()` (this one included). If that fetch or the WebAssembly instantiation
// fails for any reason, the rejection is silently swallowed: `Worker.onerror` does NOT
// fire for unhandled promise rejections (only for synchronous thrown errors), so without
// this, the console has no way to know the engine ever failed to load — it just sits
// forever, and every command to it times out with no explanation. This reports any such
// rejection back over the same message channel so it can be surfaced as a real error.
const ERROR_HARNESS = `
self.addEventListener('unhandledrejection', function (ev) {
  var reason = ev.reason;
  var msg = (reason && reason.message) ? reason.message : String(reason);
  try { postMessage(${JSON.stringify(ENGINE_BRIDGE_ERROR_PREFIX)} + msg); } catch (_) {}
});
`;

/**
 * A single running instance of a chsengine bundle, backed by one Worker.
 * Spawn one per concurrent Lichess game so searches never interleave on
 * shared engine-internal state (transposition table, killer moves, etc).
 */
export class EngineInstance {
  constructor(bundle) {
    this.bundle = bundle;
    this.worker = null;
    this.objectUrls = [];
    this._pending = []; // queue of {matcher, resolve}
    this.onInfo = null; // optional callback(line) for every raw line, for logging/telemetry
    this.name = bundle.manifest.name || 'engine';
    this.author = bundle.manifest.author || 'unknown';
  }

  start() {
    const assetUrls = {};
    for (const name of this.bundle.assetNames) {
      const blob = new Blob([this.bundle.files[name]], { type: mimeFor(name) });
      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      assetUrls[name] = url;
    }

    const entrySrc = this.bundle.files[this.bundle.manifest.entry];
    const entryBlob = new Blob([ERROR_HARNESS, entrySrc], { type: 'application/javascript' });
    const entryUrl = URL.createObjectURL(entryBlob);
    this.objectUrls.push(entryUrl);

    let hash;
    const isWasmHashFragment = (this.bundle.manifest.kind === 'wasm-uci' && this.bundle.manifest.wasmStrategy === 'hash-fragment');
    if (isWasmHashFragment) {
      const wasmName = this.bundle.manifest.wasmAsset || this.bundle.assetNames.find(n => n.endsWith('.wasm'));
      hash = encodeURIComponent(assetUrls[wasmName]);
    } else {
      hash = encodeURIComponent(JSON.stringify(assetUrls));
    }
    this.worker = new Worker(entryUrl + '#' + hash);
    this.worker.onmessage = (ev) => {
      const line = String(ev.data);
      if (line.startsWith(ENGINE_BRIDGE_ERROR_PREFIX)) {
        const detail = line.slice(ENGINE_BRIDGE_ERROR_PREFIX.length);
        console.error('[engine worker] unhandled rejection inside bundle:', detail);
        const err = new Error(`engine bundle failed to start: ${detail}`);
        const pending = this._pending.splice(0);
        for (const p of pending) p.reject(err);
        if (this.onInfo) this.onInfo('!! ' + err.message);
        return;
      }
      console.log('[engine worker] ->', line);
      this._handleLine(line);
    };
    this.worker.onerror = (ev) => { console.error('[engine worker ERROR]', ev.message, ev.filename, ev.lineno);
      const err = new Error(`engine worker error: ${ev.message} (${ev.filename}:${ev.lineno})`);
      // Reject everything currently queued so callers don't hang forever.
      const pending = this._pending.splice(0);
      for (const p of pending) p.reject(err);
      if (this.onInfo) this.onInfo('!! ' + err.message);
    };
    return this;
  }

  _handleLine(line) {
    if (this.onInfo) this.onInfo(line);
    // Resolve the oldest pending waiter whose matcher accepts this line.
    for (let i = 0; i < this._pending.length; i++) {
      if (this._pending[i].matcher(line)) {
        const p = this._pending.splice(i, 1)[0];
        p.resolve(line);
        return;
      }
    }
  }

  /** Send a raw command line to the worker. */
  send(line) {
    console.log('[engine send] <-', line);
    this.worker.postMessage(line);
  }

  /** Wait for the next line matched by `matcher(line) -> bool`, with a timeout. */
  waitFor(matcher, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const entry = { matcher, resolve, reject };
      this._pending.push(entry);
      if (timeoutMs > 0) {
        setTimeout(() => {
          const idx = this._pending.indexOf(entry);
          if (idx !== -1) {
            this._pending.splice(idx, 1);
            reject(new Error('engine timed out waiting for: ' + matcher));
          }
        }, timeoutMs);
      }
    });
  }

  async handshake() {
    // A generous, one-time-only budget: this covers worker spin-up plus compiling the
    // wasm module, which can take noticeably longer than a normal in-game command when
    // several engine instances are starting up concurrently (e.g. a burst of games on
    // reconnect) on constrained hardware. Normal search commands elsewhere still use
    // their own, much tighter, per-call timeouts.
    const HANDSHAKE_TIMEOUT_MS = 20000;
    console.log('[engine handshake] sending uci');
    const uciDone = this.waitFor((l) => l === 'uciok', HANDSHAKE_TIMEOUT_MS);
    this.send('uci');
    await uciDone;
    const readyDone = this.waitFor((l) => l === 'readyok', HANDSHAKE_TIMEOUT_MS);
    this.send('isready');
    await readyDone;
  }

  newGame() {
    this.send('ucinewgame');
  }

  setPosition(uciMoves) {
    const line = uciMoves.length ? `position startpos moves ${uciMoves.join(' ')}` : 'position startpos';
    this.send(line);
  }

  /**
   * Run a search and resolve with { bestmove, score, depth, nodes, nps, timeMs }.
   * opts: { depth, movetimeMs }
   */
  async go(opts) {
    const parts = ['go'];
    if (opts.depth != null) parts.push('depth', String(opts.depth));
    if (opts.movetimeMs != null) parts.push('movetime', String(Math.round(opts.movetimeMs)));
    if (opts.wtimeMs != null) parts.push('wtime', String(Math.round(opts.wtimeMs)));
    if (opts.btimeMs != null) parts.push('btime', String(Math.round(opts.btimeMs)));
    if (opts.wincMs != null) parts.push('winc', String(Math.round(opts.wincMs)));
    if (opts.bincMs != null) parts.push('binc', String(Math.round(opts.bincMs)));

    let last = { score: null, depth: null, nodes: null, nps: null, timeMs: null };
    const infoListener = (line) => {
      if (!line.startsWith('info ')) return;
      const m = line.match(/depth (\d+).*?score cp (-?\d+).*?nodes (\d+).*?nps (\d+).*?time (\d+)/);
      if (m) {
        last = {
          depth: +m[1],
          score: +m[2],
          nodes: +m[3],
          nps: +m[4],
          timeMs: +m[5],
        };
      }
    };
    const prevOnInfo = this.onInfo;
    this.onInfo = (line) => {
      if (prevOnInfo) prevOnInfo(line);
      infoListener(line);
    };

    const timeoutMs = (opts.movetimeMs || 15000) + 10000;
    const done = this.waitFor((l) => l.startsWith('bestmove'), timeoutMs);
    this.send(parts.join(' '));
    const line = await done;
    this.onInfo = prevOnInfo;

    const bestmove = line.split(/\s+/)[1];
    return { bestmove: bestmove === '(none)' ? null : bestmove, ...last };
  }

  stop() {
    if (this.worker) this.send('stop');
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }
}
