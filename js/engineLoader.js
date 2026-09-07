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
  const allowedKinds = ['js-algo', 'wasm-uci'];
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
    const entryBlob = new Blob([entrySrc], { type: 'application/javascript' });
    const entryUrl = URL.createObjectURL(entryBlob);
    this.objectUrls.push(entryUrl);

    const hash = encodeURIComponent(JSON.stringify(assetUrls));
    this.worker = new Worker(entryUrl + '#' + hash);
    this.worker.onmessage = (ev) => this._handleLine(String(ev.data));
    this.worker.onerror = (ev) => {
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
    const uciDone = this.waitFor((l) => l === 'uciok', 5000);
    this.send('uci');
    await uciDone;
    const readyDone = this.waitFor((l) => l === 'readyok', 5000);
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
