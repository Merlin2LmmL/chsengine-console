import { saveJSON, loadJSON } from './store.js';
import { parseBundle, EngineInstance } from './engineLoader.js';
import { listEngines, addEngine, getEngineBlob, removeEngine } from './engineLibrary.js';
import { LichessClient, LichessError } from './lichessClient.js';
import { computeGoParams, DEFAULT_TIME_SETTINGS } from './timeManager.js';
import { createBoardSvg, renderBoard } from './board.js';

// ---------------------------------------------------------------------
// Settings (persisted)
// ---------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  time: { ...DEFAULT_TIME_SETTINGS },
  matchmaking: {
    autoAccept: false,
    ratedMode: 'both', // 'rated' | 'casual' | 'both'
    speeds: { bullet: true, blitz: true, rapid: true, classical: true, correspondence: false },
    maxConcurrentGames: 1,
  },
  autoQueue: {
    enabled: false,
    mode: 'open', // 'open' | 'targets' | 'bots'
    targets: '',
    timeControl: '5+3', // label into TIME_PRESETS
    rated: false,
    intervalSec: 45,
    botsPerAttempt: 3,
    botRatingMin: 0,
    botRatingMax: 3500,
    botCooldowns: {}, // username(lowercase) -> ISO date string to skip until
  },
  chat: {
    motdEnabled: false,
    motd: '',
    endMessageEnabled: true,
    endMessage: 'Good Game',
    commandsEnabled: true,
    commandPrefix: '!',
    // Fresh installs get a working example out of the box (matches the textarea's
    // placeholder). Existing users who already saved an empty commandsCode keep
    // whatever they saved — this default only applies the first time settings load.
    commandsCode: `function handleCommand(cmd, args, ctx) {
  if (cmd === 'eval') {
    if (!ctx.eval) return "haven't finished a search yet";
    const pawns = (ctx.eval.scoreCp / 100).toFixed(2);
    return \`eval: \${pawns} (depth \${ctx.eval.depth}, from \${ctx.color} to move)\`;
  }
  if (cmd === 'rating') return 'no clue, ask lichess';
  return null; // no reply
}`,
  },
  display: {
    clockTenths: true,
  },
};

let settings = mergeDeep(DEFAULT_SETTINGS, loadJSON('settings', {}));
let bundle = null; // parsed chsengine bundle, if one is loaded
let bundleFiles = loadJSON('bundle', null); // {filename: content}

function mergeDeep(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override || {})) {
    if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && base[k]) {
      out[k] = mergeDeep(base[k], override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}

function persistSettings() { saveJSON('settings', settings); }

// ---------------------------------------------------------------------
// Win/loss/draw record
// ---------------------------------------------------------------------

let stats = loadJSON('stats', { wins: 0, losses: 0, draws: 0 });
const statsDisplayEl = document.getElementById('stats-display');

function persistStats() { saveJSON('stats', stats); }

// Lichess's `status` field (plus two synthetic statuses we generate ourselves below, for
// when the console's own connection is what fails) doubles as the "why did this game end"
// reason, and maps to a human-readable line shown in the history panel.
const GAME_END_REASONS = {
  mate: 'Checkmate',
  resign: 'Resignation',
  stalemate: 'Stalemate',
  draw: 'Draw',
  outoftime: 'Time forfeit (flag fell)',
  timeout: 'Opponent abandoned the game',
  cheat: 'Cheat detected',
  variantEnd: 'Variant-specific ending',
  noStart: "Game never started (one side didn't move in time)",
  aborted: 'Aborted before it counted',
  unknownFinish: 'Ended abnormally (Lichess reported "unknownFinish")',
  connectionLost: "This console's connection dropped — the real result is unknown from here",
  consoleDisconnected: 'You disconnected the console while this game was still running',
};
function describeGameEndReason(status) {
  return GAME_END_REASONS[status] || status || 'unknown';
}

/** Shared by the win/loss/draw record and the history panel so the two can't disagree. */
function computeOutcome(gs, myColor) {
  if (gs.status === 'aborted' || gs.status === 'noStart') return 'aborted';
  if (gs.status === 'connectionLost' || gs.status === 'consoleDisconnected') return 'unknown';
  if (gs.winner === myColor) return 'win';
  if (gs.winner) return 'loss';
  return 'draw';
}

// ---------------------------------------------------------------------
// Game history (per-move log, incl. the bot's own evaluations)
// ---------------------------------------------------------------------
//
// Kept separately from `stats` above: this stores enough per-move detail (FEN before
// each move, the move played, and the bot's own eval when it was the mover) to later
// replay a game through Stockfish and compare move-by-move, per game, exportable as JSON.

const MAX_HISTORY_GAMES = 50;
let gameHistory = loadJSON('gameHistory', []); // newest first

function persistGameHistory() { saveJSON('gameHistory', gameHistory); }

/** Called once per finished game (any status, including aborted/connection-lost) with its
 * final gameState — or, for the connection-lost/disconnected cases, a synthetic one. */
function saveGameToHistory(state, gs) {
  if (state.historySaved) return;
  state.historySaved = true;
  const outcome = computeOutcome(gs, state.myColor);
  gameHistory.unshift({
    gameId: state.id,
    opponent: state.opponent?.id || state.opponent?.name || null,
    opponentRating: state.opponent?.rating ?? null,
    myColor: state.myColor,
    rated: !!state.rated,
    speed: state.speed || null,
    status: gs.status,
    reason: describeGameEndReason(gs.status),
    winner: gs.winner || null,
    outcome,
    startedAt: state.startedAt || null,
    endedAt: new Date().toISOString(),
    engine: bundle ? { name: bundle.manifest.name, version: bundle.manifest.version } : null,
    evalNote: "botEval.scoreCp is read straight off the engine's own \"info ... score cp ...\" line, "
      + 'from the perspective of the side to move at fenBefore (positive = good for the mover) — '
      + 'the same convention most UCI engines, including Stockfish, use by default.',
    moves: state.moveLog,
  });
  if (gameHistory.length > MAX_HISTORY_GAMES) gameHistory.length = MAX_HISTORY_GAMES;
  persistGameHistory();
  renderGameHistory();
  // Explicit confirmation in the log, separate from the win/loss/draw line above — if a
  // game finishes and this line never appears, saveGameToHistory itself wasn't reached
  // (e.g. the game ended before the stream saw a final status), which narrows down any
  // future "games aren't showing up in history" report to before vs. after this point.
  log(`saved game ${state.id} to history (${state.moveLog.length} ply, now ${gameHistory.length} game(s) recorded)`, 'log-ok');
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtHistoryDate(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
}

const historyListEl = document.getElementById('history-list');

function renderGameHistory() {
  if (!historyListEl) return;
  historyListEl.innerHTML = '';
  if (gameHistory.length === 0) {
    historyListEl.innerHTML = '<div class="dim">No games recorded yet</div>';
    return;
  }
  for (const entry of gameHistory) {
    // Guard each entry independently: previously, one malformed/older-schema entry
    // (e.g. missing `moves`) threw partway through the loop and silently left the
    // *entire* list empty — every game after the bad one never got appended, which
    // looked exactly like "history is empty" even though gameHistory had data in it.
    try {
      const row = document.createElement('div');
      row.className = 'history-row';
      const resultClass = entry.outcome === 'win' ? 'stat-win'
        : entry.outcome === 'loss' ? 'stat-loss'
        : entry.outcome === 'unknown' ? 'stat-unknown'
        : 'dim';
      const moves = entry.moves || [];
      const evalCount = moves.filter((m) => m.botEval).length;
      const ratingStr = entry.opponentRating != null ? ` (${entry.opponentRating})` : '';
      row.innerHTML = `
        <div class="history-meta">
          <div><strong class="${resultClass}">${entry.outcome.toUpperCase()}</strong>
            vs ${entry.opponent || '?'}${ratingStr} (${entry.myColor || '?'})</div>
          <div class="dim">${entry.speed || '?'}${entry.rated ? ' · rated' : ' · casual'} · ${moves.length} plies
            (${evalCount} with bot eval) · ${fmtHistoryDate(entry.endedAt)}</div>
          <div class="dim history-reason">${entry.reason || describeGameEndReason(entry.status)}</div>
        </div>
        <button class="btn-tiny history-export-btn">export</button>`;
      row.querySelector('.history-export-btn').addEventListener('click', () => {
        downloadJSON(`chsengine-game-${entry.gameId}.json`, entry);
      });
      historyListEl.appendChild(row);
    } catch (e) {
      console.error('failed to render history entry', entry, e);
      const errRow = document.createElement('div');
      errRow.className = 'dim history-row';
      errRow.textContent = `(couldn't render one history entry — see console)`;
      historyListEl.appendChild(errRow);
    }
  }
}
renderGameHistory();

document.getElementById('history-export-all-btn')?.addEventListener('click', () => {
  if (gameHistory.length === 0) { log('no games recorded yet to export', 'log-err'); return; }
  downloadJSON(`chsengine-history-${Date.now()}.json`, gameHistory);
  log(`exported ${gameHistory.length} game(s) from history`, 'log-ok');
});

document.getElementById('history-clear-btn')?.addEventListener('click', () => {
  if (gameHistory.length === 0) return;
  if (!window.confirm(`Delete all ${gameHistory.length} recorded game(s) from this browser? This can't be undone.`)) return;
  gameHistory = [];
  persistGameHistory();
  renderGameHistory();
  log('game history cleared');
});
document.getElementById('clear-logs-btn')?.addEventListener('click', () => {
  logEl.innerHTML = '';
  log('logs cleared');
});

function renderStats() {
  const total = stats.wins + stats.losses + stats.draws;
  const winRate = total ? ((stats.wins / total) * 100).toFixed(1) : '0.0';
  statsDisplayEl.innerHTML = `
    <div class="stats-row"><span>Wins</span><strong class="stat-win">${stats.wins}</strong></div>
    <div class="stats-row"><span>Losses</span><strong class="stat-loss">${stats.losses}</strong></div>
    <div class="stats-row"><span>Draws</span><strong>${stats.draws}</strong></div>
    <div class="stats-row"><span>Win rate</span><strong>${winRate}%</strong></div>
    <div class="stats-row dim"><span>Total tracked</span><span>${total}</span></div>
  `;
}
renderStats();

document.getElementById('reset-stats-btn').addEventListener('click', () => {
  stats = { wins: 0, losses: 0, draws: 0 };
  persistStats();
  renderStats();
  log('stats reset');
});

/** Called once per finished game with its final gameState. */
function recordGameResult(state, gs) {
  if (state.counted) return;
  state.counted = true;
  const outcome = computeOutcome(gs, state.myColor);
  if (outcome === 'aborted' || outcome === 'unknown') return; // not a completed game, don't count

  const key = { win: 'wins', loss: 'losses', draw: 'draws' }[outcome];
  stats[key]++;
  persistStats();
  renderStats();
  log(`result: ${outcome} (${gs.status}) vs ${state.opponent?.id || state.opponent?.name || '?'}`,
    outcome === 'win' ? 'log-ok' : outcome === 'loss' ? 'log-err' : '');
}

// ---------------------------------------------------------------------
// Log console
// ---------------------------------------------------------------------

const logEl = document.getElementById('log');
const MAX_LOG_LINES = 400;

function log(line, cls = '') {
  const showErrOnly = document.getElementById('filter-err-only')?.checked;
  const hideGrey = document.getElementById('filter-hide-grey')?.checked;
  const engineFinal = document.getElementById('filter-engine-final')?.checked;
  if (showErrOnly && cls !== 'log-err') return;
  if (hideGrey && !cls) return;
  if (engineFinal && line.includes('info depth')) {
    window._lastEngineInfoLine = { line, cls };
    return;
  }
  if (engineFinal && window._lastEngineInfoLine && line.includes('bestmove')) {
    const deferred = window._lastEngineInfoLine;
    window._lastEngineInfoLine = null;
    // log deferred final depth before bestmove
    const row = document.createElement('div');
    row.className = 'log-line' + (deferred.cls ? ' ' + deferred.cls : '');
    const t = new Date().toLocaleTimeString('en-GB');
    row.textContent = `[${t}] ${deferred.line}`;
    logEl.appendChild(row);
    while (logEl.children.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  }
  const row = document.createElement('div');
  row.className = 'log-line' + (cls ? ' ' + cls : '');
  const t = new Date().toLocaleTimeString('en-GB');
  row.textContent = `[${t}] ${line}`;
  logEl.appendChild(row);
  while (logEl.children.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  // Don't force scroll on new logs so user can scroll freely
  // logEl.scrollTop = logEl.scrollHeight;
}

/** Pull the actual reason out of a LichessError's response body, e.g. {"error":"..."},
 * instead of just logging the bare "POST /path -> 400". Falls back to e.message for
 * anything else (engine errors, AbortError, etc). */
function errDetail(e) {
  if (!(e instanceof LichessError) || !e.body) return e.message;
  let detail = e.body;
  try {
    const parsed = JSON.parse(e.body);
    detail = flattenErrorField(parsed.error ?? parsed.message ?? e.body);
  } catch (_) { /* body wasn't JSON, use it as-is */ }
  return detail ? `${e.message} (${detail})` : e.message;
}

/** Lichess error bodies aren't always a plain string — form-style validation errors come
 * back as {"field": ["message", ...], ...} (this is what was silently turning into the
 * useless "[object Object]" previously logged for the message-of-the-day chat failure).
 * Flatten whatever shape shows up into a readable string instead of trusting it's a string. */
function flattenErrorField(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(flattenErrorField).join(', ');
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => `${k}: ${flattenErrorField(v)}`).join('; ');
  }
  return String(raw);
}

// ---------------------------------------------------------------------
// Engine bundle loading
// ---------------------------------------------------------------------

const engineNameEl = document.getElementById('engine-name');
const engineStatusEl = document.getElementById('engine-status');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('bundle-file-input');

function refreshEngineUi() {
  if (bundle) {
    engineNameEl.textContent = `${bundle.manifest.name} v${bundle.manifest.version}`;
    engineStatusEl.textContent = `by ${bundle.manifest.author} — ${bundle.assetNames.length} asset(s) loaded`;
    engineStatusEl.className = 'engine-status ok';
  } else {
    engineNameEl.textContent = 'No engine loaded';
    engineStatusEl.textContent = 'Drop a .zip bundle, or its manifest.json/entry.js/assets, to begin';
    engineStatusEl.className = 'engine-status';
  }
}

async function loadBundleFromFiles(fileMap) {
  try {
    bundle = parseBundle(fileMap);
    bundleFiles = fileMap;
    const saveFriendly = {};
    for (const k in fileMap) {
      const v = fileMap[k];
      saveFriendly[k] = (v instanceof ArrayBuffer) ? { __base64: btoa(String.fromCharCode(...new Uint8Array(v))) } : v;
    }
    saveJSON('bundle', saveFriendly);
    log(`engine bundle loaded: ${bundle.manifest.name} v${bundle.manifest.version} (${bundle.manifest.kind})`, 'log-ok');
  } catch (e) {
    bundle = null;
    log('failed to load bundle: ' + e.message, 'log-err');
  }
  refreshEngineUi();
}

async function handleZipFile(file) {
  const JSZip = window.JSZip;
  const zip = await JSZip.loadAsync(file);
  const fileMap = {};
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    const base = name.split('/').pop();
    if (base.endsWith('.wasm')) {
      fileMap[base] = await entry.async('arraybuffer');
    } else {
      fileMap[base] = await entry.async('string');
    }
  }
  await loadBundleFromFiles(fileMap);
}

async function handleRawFiles(fileList) {
  const fileMap = {};
  for (const f of fileList) {
    if (f.name.endsWith('.wasm')) fileMap[f.name] = await f.arrayBuffer();
    else fileMap[f.name] = await f.text();
  }
  await loadBundleFromFiles(fileMap);
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = [...e.dataTransfer.files];
  if (files.length === 1 && files[0].name.endsWith('.zip')) await handleZipFile(files[0]);
  else await handleRawFiles(files);
});
fileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (files.length === 1 && files[0].name.endsWith('.zip')) await handleZipFile(files[0]);
  else await handleRawFiles(files);
});

// Restore a previously loaded bundle on page load
if (bundleFiles) {
  try {
    // Decode any base64-encoded binary assets saved to localStorage
    const decoded = {};
    for (const k in bundleFiles) {
      const v = bundleFiles[k];
      if (v && typeof v === 'object' && v.__base64) {
        const bytes = atob(v.__base64);
        const arr = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        decoded[k] = arr.buffer;
      } else {
        decoded[k] = v;
      }
    }
    bundleFiles = decoded;
    bundle = parseBundle(bundleFiles);
    log(`restored engine bundle from previous session: ${bundle.manifest.name} v${bundle.manifest.version}`);
  } catch (e) {
    log('could not restore saved bundle: ' + e.message, 'log-err');
    bundle = null;
  }
}
refreshEngineUi();

// ---------------------------------------------------------------------
// Telemetry strip (per-search depth/score sparkline)
// ---------------------------------------------------------------------

const telemetryCanvas = document.getElementById('telemetry');
const telemetryReadout = document.getElementById('telemetry-readout');
let telemetryHistory = [];

function resetTelemetry() {
  telemetryHistory = [];
  drawTelemetry();
  telemetryReadout.textContent = '';
}

function pushTelemetry(depth, score, nodes, nps, timeMs) {
  telemetryHistory.push(score);
  if (telemetryHistory.length > 40) telemetryHistory.shift();
  drawTelemetry();
  telemetryReadout.textContent =
    `depth ${depth}  score ${(score / 100).toFixed(2)}  nodes ${nodes.toLocaleString()}  nps ${nps.toLocaleString()}  time ${timeMs}ms`;
}

function drawTelemetry() {
  const ctx = telemetryCanvas.getContext('2d');
  const w = telemetryCanvas.width, h = telemetryCanvas.height;
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.strokeStyle = 'rgba(139,147,161,0.15)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  const midY = h / 2;
  ctx.strokeStyle = 'rgba(94,200,216,0.35)';
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(w, midY); ctx.stroke();

  if (telemetryHistory.length < 2) return;
  const maxAbs = Math.max(200, ...telemetryHistory.map((v) => Math.abs(v)));
  ctx.strokeStyle = '#ffb454';
  ctx.lineWidth = 2;
  ctx.beginPath();
  telemetryHistory.forEach((v, i) => {
    const x = (i / (telemetryHistory.length - 1)) * w;
    const y = midY - (v / maxAbs) * (h / 2 - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ---------------------------------------------------------------------
// Connection / account
// ---------------------------------------------------------------------

const tokenInput = document.getElementById('token-input');
const connectBtn = document.getElementById('connect-btn');
const accountStatusEl = document.getElementById('account-status');
const upgradeBotBtn = document.getElementById('upgrade-bot-btn');

tokenInput.value = loadJSON('token', '') || '';

let client = null;
let myUsername = null;
let eventStreamAbort = null;
let running = false;

async function connect() {
  const token = tokenInput.value.trim();
  if (!token) { log('enter a Lichess API token first', 'log-err'); return; }
  if (!bundle) { log('load an engine bundle first', 'log-err'); return; }

  saveJSON('token', token);
  client = new LichessClient(token);

  try {
    const account = await client.getAccount();
    myUsername = account.username;
    if (account.title !== 'BOT') {
      log(`warning: account "${account.username}" has no BOT title — upgrade it with a one-time POST to /api/bot/account/upgrade before challenges will work`, 'log-err');
      upgradeBotBtn.hidden = false;
    } else {
      upgradeBotBtn.hidden = true;
    }
    accountStatusEl.textContent = `connected as ${account.username}${account.title ? ' [' + account.title + ']' : ''}`;
    accountStatusEl.className = 'account-status ok';
    log(`connected to Lichess as ${account.username}`, 'log-ok');
  } catch (e) {
    accountStatusEl.textContent = 'connection failed';
    accountStatusEl.className = 'account-status err';
    log('connection failed: ' + errDetail(e), 'log-err');
    return;
  }

  running = true;
  connectBtn.textContent = 'Disconnect';
  const ac = new AbortController();
  eventStreamAbort = ac;
  runEventLoop(ac.signal).catch((e) => {
    if (e.name !== 'AbortError') log('event stream ended: ' + e.message, 'log-err');
  });

  if (settings.autoQueue.enabled) {
    queueOnce('on connect');
    startQueueTimer();
  }
}

function disconnect() {
  running = false;
  stopQueueTimer();
  if (eventStreamAbort) eventStreamAbort.abort();
  for (const g of activeGames.values()) g.abortController.abort();
  activeGames.clear();
  renderGameList();
  connectBtn.textContent = 'Connect';
  accountStatusEl.textContent = 'disconnected';
  accountStatusEl.className = 'account-status';
  upgradeBotBtn.hidden = true;
  log('disconnected');
}

connectBtn.addEventListener('click', () => { running ? disconnect() : connect(); });

upgradeBotBtn.addEventListener('click', async () => {
  if (!client) return;
  const ok = window.confirm(
    'Upgrade this Lichess account to a BOT account?\n\n' +
    'This is permanent: a BOT account can never play rated games as a human again, ' +
    'and can only play through the Bot API from now on. This cannot be undone.'
  );
  if (!ok) return;
  upgradeBotBtn.disabled = true;
  try {
    await client.upgradeToBot();
    log(`account "${myUsername}" upgraded to BOT`, 'log-ok');
    upgradeBotBtn.hidden = true;
    accountStatusEl.textContent = `connected as ${myUsername} [BOT]`;
  } catch (e) {
    log('BOT upgrade failed: ' + errDetail(e), 'log-err');
  } finally {
    upgradeBotBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------
// Matchmaking (challenge accept/decline)
// ---------------------------------------------------------------------

function challengeMatchesFilters(challenge) {
  const mm = settings.matchmaking;
  if (challenge.variant?.key !== 'standard') return { ok: false, reason: 'variant not standard' };
  const speed = challenge.speed;
  if (!mm.speeds[speed]) return { ok: false, reason: `speed "${speed}" not enabled` };
  if (mm.ratedMode === 'rated' && !challenge.rated) return { ok: false, reason: 'casual game, rated-only filter' };
  if (mm.ratedMode === 'casual' && challenge.rated) return { ok: false, reason: 'rated game, casual-only filter' };
  if (activeGames.size >= mm.maxConcurrentGames) return { ok: false, reason: 'max concurrent games reached' };
  return { ok: true };
}

async function handleIncomingChallenge(challenge) {
  // Lichess's `challenger.id` is always the lowercase account id, while `myUsername`
  // (from /api/account) preserves display case — compare case-insensitively or every
  // challenge you post yourself (e.g. an open challenge someone is about to join) gets
  // misread as "in" instead of "out", and this tries to accept its own challenge.
  const iAmChallenger = challenge.challenger?.id?.toLowerCase() === myUsername?.toLowerCase();
  const direction = challenge.direction || (iAmChallenger ? 'out' : 'in');
  if (direction !== 'in') return;

  log(`challenge ${challenge.id} from ${challenge.challenger?.id || '?'}: ${challenge.speed}/${challenge.variant?.key}${challenge.rated ? ' rated' : ' casual'}`);

  if (!settings.matchmaking.autoAccept) {
    renderPendingChallenge(challenge);
    return;
  }
  const verdict = challengeMatchesFilters(challenge);
  if (verdict.ok) {
    try {
      await client.acceptChallenge(challenge.id);
      log(`accepted challenge ${challenge.id}`, 'log-ok');
    } catch (e) {
      log(`failed to accept ${challenge.id}: ${errDetail(e)}`, 'log-err');
    }
  } else {
    try {
      await client.declineChallenge(challenge.id, 'generic');
      log(`declined challenge ${challenge.id}: ${verdict.reason}`);
    } catch (e) {
      log(`failed to decline ${challenge.id}: ${errDetail(e)}`, 'log-err');
    }
  }
}

const pendingListEl = document.getElementById('pending-challenges');

function renderPendingChallenge(challenge) {
  const row = document.createElement('div');
  row.className = 'pending-row';
  row.innerHTML = `
    <span>${challenge.challenger?.id || '?'} — ${challenge.speed}/${challenge.variant?.key}${challenge.rated ? ' rated' : ''}</span>
    <span class="pending-actions">
      <button class="btn-small btn-accept">Accept</button>
      <button class="btn-small btn-decline">Decline</button>
    </span>`;
  row.querySelector('.btn-accept').addEventListener('click', async () => {
    row.remove();
    try { await client.acceptChallenge(challenge.id); log(`accepted challenge ${challenge.id}`, 'log-ok'); }
    catch (e) { log('accept failed: ' + errDetail(e), 'log-err'); }
  });
  row.querySelector('.btn-decline').addEventListener('click', async () => {
    row.remove();
    try { await client.declineChallenge(challenge.id); log(`declined challenge ${challenge.id}`); }
    catch (e) { log('decline failed: ' + errDetail(e), 'log-err'); }
  });
  pendingListEl.appendChild(row);
}

document.getElementById('decline-all-btn').addEventListener('click', () => {
  [...pendingListEl.children].forEach((row) => row.querySelector('.btn-decline')?.click());
});

// ---------------------------------------------------------------------
// Auto-queue (posts a new challenge to find a game)
// ---------------------------------------------------------------------

let queueTimer = null;
let queueInFlight = false;
const RECENT_CHALLENGE_COOLDOWN_MS = 10 * 60 * 1000;
const recentlyChallenged = new Map(); // username(lowercase) -> timestamp last tried

// Real-time presets use {limit, inc} in seconds; the correspondence preset uses
// {days} instead, since that's what Lichess's challenge API expects for it (no
// clock.limit/clock.increment at all). `speed` is the exact Lichess perf key
// (matches what /api/bot/online returns per bot under `perfs`), used both for
// display and for the bot-rating-range filter below.
const TIME_PRESETS = [
  { label: '15s+0', limit: 15, inc: 0, speed: 'ultraBullet' },
  { label: '30s+0', limit: 30, inc: 0, speed: 'ultraBullet' },
  { label: '1+0', limit: 60, inc: 0, speed: 'bullet' },
  { label: '1+1', limit: 60, inc: 1, speed: 'bullet' },
  { label: '2+1', limit: 120, inc: 1, speed: 'bullet' },
  { label: '3+0', limit: 180, inc: 0, speed: 'blitz' },
  { label: '3+1', limit: 180, inc: 1, speed: 'blitz' },
  { label: '3+2', limit: 180, inc: 2, speed: 'blitz' },
  { label: '5+0', limit: 300, inc: 0, speed: 'blitz' },
  { label: '5+3', limit: 300, inc: 3, speed: 'blitz' },
  { label: '10+0', limit: 600, inc: 0, speed: 'rapid' },
  { label: '10+5', limit: 600, inc: 5, speed: 'rapid' },
  { label: '15+10', limit: 900, inc: 10, speed: 'rapid' },
  { label: '30+0', limit: 1800, inc: 0, speed: 'classical' },
  { label: '30+20', limit: 1800, inc: 20, speed: 'classical' },
  { label: 'Correspondence (2 days/move)', days: 2, speed: 'correspondence' },
];

function humanSpeed(speed) { return speed === 'ultraBullet' ? 'UltraBullet' : speed[0].toUpperCase() + speed.slice(1); }

function populateTimeControlSelect() {
  const sel = document.getElementById('autoqueue-timecontrol');
  sel.innerHTML = TIME_PRESETS.map((p) => `<option value="${p.label}">${p.label} (${humanSpeed(p.speed)})</option>`).join('');
}

function getSelectedPreset() {
  return TIME_PRESETS.find((p) => p.label === settings.autoQueue.timeControl) || TIME_PRESETS[0];
}

/** {clockLimit, clockIncrement} or {days}, whichever the selected preset needs. */
function buildClockParams() {
  const preset = getSelectedPreset();
  return preset.days != null
    ? { days: preset.days }
    : { clockLimit: preset.limit, clockIncrement: preset.inc };
}

// Heuristic for "this bot has hit its games-for-today cap" style rejections. Lichess's
// actual wording (confirmed from a live 400): "<name> played 100 games against other
// bots today, please wait until <ISO timestamp> to challenge them." — it hands back the
// exact resume time, so we parse that out and use it directly; the pattern list and the
// UTC-midnight fallback only matter if a differently-worded variant shows up.
const GAME_LIMIT_ERROR_PATTERNS = [
  /played \d+ games against other bots today/i,
  /too many games/i, /game limit/i, /maximum number of games/i,
  /daily limit/i, /already has too many/i, /reached.*limit/i,
];
function looksLikeGameLimitError(msg) {
  return GAME_LIMIT_ERROR_PATTERNS.some((re) => re.test(msg));
}
function extractCooldownUntil(msg) {
  const m = msg.match(/wait until (\S+?)(?:\s+to\b|[)\s]|$)/i);
  if (m && !isNaN(Date.parse(m[1]))) return new Date(m[1]).toISOString();
  return nextUtcMidnightIso(); // fallback if the message doesn't match this shape
}
function nextUtcMidnightIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}
function isBotCoolingDown(name) {
  const key = name.toLowerCase();
  const until = settings.autoQueue.botCooldowns[key];
  if (!until) return false;
  if (Date.now() >= Date.parse(until)) { delete settings.autoQueue.botCooldowns[key]; persistSettings(); return false; }
  return true;
}
function cooldownBot(name, reason) {
  const until = extractCooldownUntil(reason);
  settings.autoQueue.botCooldowns[name.toLowerCase()] = until;
  persistSettings();
  renderBotCooldowns();
  log(`auto-queue: bot ${name} looks maxed out for today (${reason}) — skipping until ${until}`, 'log-err');
}
function renderBotCooldowns() {
  const el = document.getElementById('bot-cooldowns-display');
  if (!el) return;
  const entries = Object.entries(settings.autoQueue.botCooldowns || {});
  el.textContent = entries.length
    ? 'On cooldown: ' + entries.map(([n, until]) => `${n} (until ${new Date(until).toLocaleString()})`).join(', ')
    : '';
}

function isRecentlyChallenged(name) {
  const t = recentlyChallenged.get(name.toLowerCase());
  return t != null && Date.now() - t < RECENT_CHALLENGE_COOLDOWN_MS;
}
function markRecentlyChallenged(name) {
  recentlyChallenged.set(name.toLowerCase(), Date.now());
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Post one round of challenge(s), per current autoQueue settings. `reason` is only for the log line. */
async function queueOnce(reason = 'manual') {
  if (queueInFlight) return;
  if (!client) { log('connect first before queueing', 'log-err'); return; }
  if (!bundle) { log('load an engine bundle first', 'log-err'); return; }
  if (activeGames.size >= settings.matchmaking.maxConcurrentGames) {
    log(`skipping queue (${reason}): max concurrent games (${settings.matchmaking.maxConcurrentGames}) already running`);
    return;
  }

  queueInFlight = true;
  const aq = settings.autoQueue;
  const preset = getSelectedPreset();
  // Variant is always "standard" — same limitation as incoming-challenge filtering:
  // the board renderer and engine bundle only understand plain chess rules.
  const params = { ...buildClockParams(), rated: aq.rated, variant: 'standard' };
  const label = `${preset.label}${aq.rated ? ' rated' : ' casual'}`;
  try {
    if (aq.mode === 'targets') {
      const names = aq.targets.split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) { log('auto-queue: no usernames configured for "Challenge users" mode', 'log-err'); return; }
      for (const name of names) {
        if (activeGames.size >= settings.matchmaking.maxConcurrentGames) break;
        try {
          await client.challengeUser(name, params);
          log(`queued (${reason}): challenged ${name} — ${label}`, 'log-ok');
        } catch (e) {
          log(`auto-queue: failed to challenge ${name}: ${errDetail(e)}`, 'log-err');
        }
      }
    } else if (aq.mode === 'bots') {
      let bots;
      try {
        bots = await client.fetchOnlineBots(200);
      } catch (e) {
        log(`auto-queue: failed to fetch online bots: ${errDetail(e)}`, 'log-err');
        return;
      }
      const candidates = shuffleInPlace(
        bots
          .map((b) => ({ name: b.username || b.id, rating: b.perfs?.[preset.speed]?.rating }))
          .filter((b) => b.name && b.name.toLowerCase() !== myUsername?.toLowerCase())
          .filter((b) => !isRecentlyChallenged(b.name))
          .filter((b) => !isBotCoolingDown(b.name))
          .filter((b) => b.rating != null && b.rating >= aq.botRatingMin && b.rating <= aq.botRatingMax)
      );
      if (!candidates.length) {
        log(`auto-queue: no eligible online bots right now (none online in ${aq.botRatingMin}-${aq.botRatingMax} ${humanSpeed(preset.speed)}, or all tried recently / on cooldown)`);
        return;
      }
      const picks = candidates.slice(0, Math.max(1, aq.botsPerAttempt));
      for (const { name } of picks) {
        if (activeGames.size >= settings.matchmaking.maxConcurrentGames) break;
        markRecentlyChallenged(name);
        try {
          await client.challengeUser(name, params);
          log(`queued (${reason}): challenged bot ${name} — ${label}`, 'log-ok');
        } catch (e) {
          const msg = errDetail(e);
          if (looksLikeGameLimitError(msg)) cooldownBot(name, msg);
          else log(`auto-queue: failed to challenge bot ${name}: ${msg}`, 'log-err');
        }
      }
    } else {
      const resp = await client.createOpenChallenge(params);
      const url = resp?.challenge?.url || resp?.url || '';
      log(`queued (${reason}): posted open challenge${url ? ' — ' + url : ''} — ${label}`, 'log-ok');
    }
  } catch (e) {
    log(`auto-queue attempt failed: ${errDetail(e)}`, 'log-err');
  } finally {
    queueInFlight = false;
  }
}

function startQueueTimer() {
  stopQueueTimer();
  if (!settings.autoQueue.enabled) return;
  const intervalMs = Math.max(5, settings.autoQueue.intervalSec) * 1000;
  queueTimer = setInterval(() => {
    if (activeGames.size < settings.matchmaking.maxConcurrentGames) queueOnce('auto-queue timer');
  }, intervalMs);
}

function stopQueueTimer() {
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = null;
}

document.getElementById('queue-now-btn').addEventListener('click', () => queueOnce('manual'));

// ---------------------------------------------------------------------
// Event loop / per-game loop
// ---------------------------------------------------------------------

const activeGames = new Map(); // gameId -> { ...state, engine, abortController }
let selectedGameId = null;

async function runEventLoop(signal) {
  log('listening for challenges and game starts…');
  await client.streamEvents(async (ev) => {
    if (ev.type === 'challenge') {
      handleIncomingChallenge(ev.challenge);
    } else if (ev.type === 'gameStart') {
      const id = ev.game.id;
      if (!activeGames.has(id)) startGame(id, signal);
    } else if (ev.type === 'gameFinish') {
      log(`game ${ev.game.id} finished`);
    }
  }, signal);
}

function uciClockFields(gameState, myColor) {
  const remainingMs = myColor === 'white' ? gameState.wtime : gameState.btime;
  const incrementMs = myColor === 'white' ? gameState.winc : gameState.binc;
  return { remainingMs, incrementMs };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** Sends the message-of-the-day with one short-delay retry. Chat right at game start is a
 * known flaky spot for bots — Lichess sometimes hasn't fully wired up the chat room for a
 * brand-new game in the same instant it sends gameFull, so an immediate POST can 400 even
 * though everything about the request is otherwise correct. If it still fails after the
 * retry, the real reason (via errDetail, which now decodes Lichess's structured error
 * bodies instead of printing "[object Object]") gets logged for a definitive diagnosis. */
async function sendMotdWithRetry(gameId, text) {
  let lastErr;
  for (const delayMs of [0, 700]) {
    if (delayMs) await sleep(delayMs);
    try {
      await client.chat(gameId, 'player', text);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function startGame(gameId, parentSignal) {
  const ac = new AbortController();
  parentSignal.addEventListener('abort', () => ac.abort());

  const chessCtor = window.Chess;
  const gameChess = new chessCtor();

  const engine = new EngineInstance(bundle).start();
  engine.onInfo = (line) => { if (selectedGameId === gameId) log('  ' + line, 'log-engine'); };

  const state = {
    id: gameId, engine, abortController: ac,
    myColor: null, opponent: null, movesPlayed: [], status: 'started',
    lastClock: null, lastEval: null, pendingMoveEval: null, moveLog: [],
    startedAt: new Date().toISOString(),
  };
  activeGames.set(gameId, state);
  renderGameList();
  if (!selectedGameId) selectGame(gameId);

  try {
    await engine.handshake();
    engine.newGame();
  } catch (e) {
    log(`engine failed to start for game ${gameId}: ${e.message}`, 'log-err');
    activeGames.delete(gameId);
    renderGameList();
    return;
  }

  try {
    await client.streamGame(gameId, async (ev) => {
      if (ev.type === 'gameFull') {
        // Same case-sensitivity trap as the challenge-direction check: ev.white/black's
        // `id` is Lichess's lowercase account id, myUsername is display-cased — compare
        // case-insensitively or this silently defaults to 'black' every game, which also
        // inverts whose-turn detection below whenever you're actually White.
        state.myColor = ev.white?.id?.toLowerCase() === myUsername?.toLowerCase() ? 'white' : 'black';
        state.opponent = state.myColor === 'white' ? ev.black : ev.white;
        state.rated = ev.rated;
        state.speed = ev.speed;
        const oppRatingStr = state.opponent?.rating != null ? ` (${state.opponent.rating})` : '';
        log(`game ${gameId} started vs ${state.opponent?.id || state.opponent?.name || 'anonymous'}${oppRatingStr} (${state.myColor}, ${ev.speed}${ev.rated ? ' rated' : ' casual'})`, 'log-ok');
        if (settings.chat.motdEnabled && settings.chat.motd.trim() && !state.motdSent) {
          state.motdSent = true;
          state.endMessageSent = false;
          // Lichess chat messages max out around 140 chars; trim defensively so an
          // overlong MOTD can't be the reason this 400s.
          const motdText = settings.chat.motd.trim().slice(0, 140);
          try {
            await sendMotdWithRetry(gameId, motdText);
            log(`sent message of the day to game ${gameId}`, 'log-ok');
          } catch (e) {
            log('failed to send message of the day: ' + errDetail(e), 'log-err');
          }
        }
        await handleGameState(state, ev.state, gameChess);
      } else if (ev.type === 'gameState') {
        await handleGameState(state, ev, gameChess);
      } else if (ev.type === 'chatLine') {
        if (ev.username?.toLowerCase() !== myUsername?.toLowerCase()) {
          log(`[chat ${gameId}] ${ev.username}: ${ev.text}`);
          await handleChatCommand(state, ev, gameChess);
        }
      } else if (ev.type === 'opponentGone') {
        if (ev.gone) log(`opponent left game ${gameId}, can claim win in ${ev.claimWinInSeconds}s`);
      }
    }, ac.signal);
  } catch (e) {
    if (e.name !== 'AbortError') {
      log(`game stream ${gameId} ended: ${e.message}`, 'log-err');
      // The game didn't reach a normal finished gameState before the stream died (network
      // drop, tab lost focus long enough to be killed, etc.) — still worth a history entry
      // so it isn't just silently missing, but be honest that the real result is unknown.
      if (!state.historySaved) saveGameToHistory(state, { status: 'connectionLost', winner: null });
    } else if (!running && !state.historySaved) {
      // Deliberate disconnect (the Connect/Disconnect button) while this game was still
      // running — also unresolved from here, just for a different reason than above.
      saveGameToHistory(state, { status: 'consoleDisconnected', winner: null });
    }
  } finally {
    engine.terminate();
    activeGames.delete(gameId);
    renderGameList();
    if (selectedGameId === gameId) {
      selectedGameId = null;
      const next = activeGames.keys().next();
      if (!next.done) selectGame(next.value);
      else clearBoardView();
    }
    if (running && settings.autoQueue.enabled) queueOnce('game finished');
  }
}

async function handleGameState(state, gs, gameChess) {
  state.status = gs.status;
  state.lastClock = gs;

  const moves = gs.moves ? gs.moves.split(' ').filter(Boolean) : [];
  const newMoves = moves.slice(state.movesPlayed.length);
  for (let i = 0; i < newMoves.length; i++) {
    const uci = newMoves[i];
    const ply = state.movesPlayed.length + i; // 0-based
    const moverColor = ply % 2 === 0 ? 'white' : 'black';
    const isBot = moverColor === state.myColor;
    const fenBefore = gameChess.fen();
    const moveObj = gameChess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    let botEval = null;
    if (isBot && state.pendingMoveEval) {
      botEval = state.pendingMoveEval;
      state.pendingMoveEval = null;
    }
    state.moveLog.push({
      ply: ply + 1,
      moveNumber: Math.floor(ply / 2) + 1,
      color: moverColor,
      by: isBot ? 'bot' : 'opponent',
      uci,
      san: moveObj ? moveObj.san : null,
      fenBefore,
      fenAfter: gameChess.fen(),
      botEval,
    });
  }
  state.movesPlayed = moves;
  state.lastMove = moves.length ? { from: moves[moves.length - 1].slice(0, 2), to: moves[moves.length - 1].slice(2, 4) } : null;

  if (selectedGameId === state.id) {
    renderBoard(boardSvg, gameChess, { orientation: state.myColor || 'white', lastMove: state.lastMove });
    updateGameInfoPanel(state);
  }
  renderGameList();

  if (gs.status !== 'started') {
    log(`game ${state.id} status: ${gs.status}${gs.winner ? ' — winner: ' + gs.winner : ''}`);
    if (settings.chat.endMessageEnabled && settings.chat.endMessage.trim() && !state.endMessageSent) {
      state.endMessageSent = true;
      try {
        await client.chat(state.id, 'player', settings.chat.endMessage.trim().slice(0, 140));
        log('sent end-of-game message', 'log-ok');
      } catch (e) {}
    }
    recordGameResult(state, gs);
    saveGameToHistory(state, gs);
    return;
  }

  const movesCount = moves.length;
  const whiteToMove = movesCount % 2 === 0;
  const myTurn = (state.myColor === 'white') === whiteToMove;
  if (!myTurn) return;

  const { remainingMs, incrementMs } = uciClockFields(gs, state.myColor);
  const params = computeGoParams(settings.time.mode, settings.time, { remainingMs, incrementMs });

  const positionCmd = moves.length ? `position startpos moves ${moves.join(' ')}` : 'position startpos';
  const goCmd = ['go', params.depth != null ? `depth ${params.depth}` : null, params.movetimeMs != null ? `movetime ${Math.round(params.movetimeMs)}` : null]
    .filter(Boolean).join(' ');
  if (selectedGameId === state.id) {
    // What we're actually telling the engine to search, so a fixed/repeating search
    // output across different games (a real engine bug seen in the wild) is easy to
    // spot: it means entry.js isn't applying the moves list below to its own board.
    log(`  -> ${positionCmd}`, 'log-engine');
    log(`  -> ${goCmd}`, 'log-engine');
  }

  state.engine.setPosition(moves);
  if (selectedGameId === state.id) resetTelemetry();
  const origOnInfo = state.engine.onInfo;
  state.engine.onInfo = (line) => {
    origOnInfo?.(line);
    const m = line.match(/depth (\d+).*?score cp (-?\d+).*?nodes (\d+).*?nps (\d+).*?time (\d+)/);
    if (m) {
      // Kept on the game state (not just pushed to the on-screen sparkline) so chat
      // commands like "!eval" can report it even when this game isn't the selected one.
      state.lastEval = { depth: +m[1], scoreCp: +m[2], nodes: +m[3], nps: +m[4], timeMs: +m[5] };
      if (selectedGameId === state.id) pushTelemetry(+m[1], +m[2], +m[3], +m[4], +m[5]);
    }
  };

  let result;
  try {
    result = await state.engine.go(params);
  } catch (e) {
    log(`search failed for game ${state.id}: ${e.message}`, 'log-err');
    return;
  }
  state.engine.onInfo = origOnInfo;

  if (!result.bestmove) { log(`engine returned no move for game ${state.id} (stalemate/mate?)`); return; }

  if (!isLegalUciMove(gameChess, result.bestmove)) {
    // Validate before spending an API call: Lichess will 400 an illegal move anyway,
    // but that error alone doesn't make clear the move was never legal in the first
    // place — this is almost always a bug in the engine bundle's own search/move
    // generation (e.g. mishandling a mate score, or not applying the position it was
    // sent — compare the "-> position ..." line above to what actually got searched).
    log(`engine returned illegal move "${result.bestmove}" for game ${state.id} — not submitting (this is a bug in the engine bundle, not Lichess or the console)`, 'log-err');
    return;
  }

  try {
    // Snapshot now, before the position moves on: this is the eval that led to this
    // exact move, and gets attached to it once it shows up in the game's move log.
    state.pendingMoveEval = state.lastEval;
    await client.makeMove(state.id, result.bestmove);
  } catch (e) {
    log(`move submission failed for game ${state.id}: ${errDetail(e)}`, 'log-err');
  }
}

/** Check a uci move (e.g. "e2e4", "e7e8q") against the position's actual legal moves. */
function isLegalUciMove(chess, uci) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4, 5) || undefined;
  const legal = chess.moves({ verbose: true });
  return legal.some((m) => m.from === from && m.to === to && (!promotion || m.promotion === promotion));
}

// ---------------------------------------------------------------------
// Chat: message of the day + custom commands
// ---------------------------------------------------------------------

let compiledCommandHandler = null;
let compiledCommandError = null;

/** Compiles user-supplied JS that must define `function handleCommand(cmd, args, ctx)`.
 * Runs as plain JS in this page's own context, no sandboxing — that's the deal the user
 * signed up for by pasting code into this field. */
function compileCommandHandler(code) {
  compiledCommandHandler = null;
  compiledCommandError = null;
  if (!code || !code.trim()) return;
  try {
    const factory = new Function(
      `${code}\nif (typeof handleCommand !== 'function') throw new Error('no function named handleCommand was defined');\nreturn handleCommand;`
    );
    compiledCommandHandler = factory();
  } catch (e) {
    compiledCommandError = e.message;
    log('chat command handler failed to compile: ' + e.message, 'log-err');
  }
}

async function handleChatCommand(state, ev, gameChess) {
  const prefix = settings.chat.commandPrefix || '!';
  const text = (ev.text || '').trim();
  if (!text.startsWith(prefix)) return; // not something meant as a command, stay quiet

  // Everything below only runs once a line actually looks like a command attempt, so
  // these checks can log loudly without spamming the log for ordinary chat banter —
  // previously each of these bailed out silently, which is exactly why a "!eval" or
  // "!rating" line in-game produced no error and no reply: nothing was actually wrong,
  // there was just nothing configured to respond to it yet.
  if (!settings.chat.commandsEnabled) {
    log(`ignored "${text}" — custom chat commands are off (Chat panel → "Enable custom chat commands")`, 'log-err');
    return;
  }
  if (!compiledCommandHandler) {
    log(compiledCommandError
      ? `ignored "${text}" — command handler has a compile error (see the message logged when it was saved/tested)`
      : `ignored "${text}" — no command handler code has been saved yet (Chat panel → paste code into "Command handler (JS)" → Test compile)`,
      'log-err');
    return;
  }

  const [rawCmd, ...args] = text.slice(prefix.length).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  const ctx = {
    gameId: state.id,
    color: state.myColor,
    opponent: state.opponent?.id || state.opponent?.name,
    movesPlayed: state.movesPlayed.slice(),
    chess: gameChess,
    eval: state.lastEval,
    log: (msg) => log(`[chat cmd ${state.id}] ${msg}`),
  };
  let reply;
  try {
    reply = await compiledCommandHandler(cmd, args, ctx);
  } catch (e) {
    log(`chat command handler threw for "${cmd}": ${e.message}`, 'log-err');
    return;
  }
  if (typeof reply === 'string' && reply.trim()) {
    try {
      await client.chat(state.id, ev.room || 'player', reply);
      log(`replied to "${text}" with "${reply}"`, 'log-ok');
    } catch (e) { log('failed to send chat reply: ' + errDetail(e), 'log-err'); }
  } else {
    log(`"${text}" handled (handleCommand returned no reply)`);
  }
}

// ---------------------------------------------------------------------
// Game list / board panel wiring
// ---------------------------------------------------------------------

const gameListEl = document.getElementById('game-list');
const boardContainer = document.getElementById('board-container');
const boardSvg = createBoardSvg(boardContainer);
const gameInfoEl = document.getElementById('game-info');
const resignBtn = document.getElementById('resign-btn');
const abortBtn = document.getElementById('abort-btn');

function renderGameList() {
  gameListEl.innerHTML = '';
  if (activeGames.size === 0) {
    gameListEl.innerHTML = '<div class="dim">No active games</div>';
    return;
  }
  for (const [id, state] of activeGames) {
    const row = document.createElement('div');
    row.className = 'game-row' + (id === selectedGameId ? ' selected' : '');
    const opp = state.opponent?.id || state.opponent?.name || 'connecting…';
    const oppRating = state.opponent?.rating != null ? ` (${state.opponent.rating})` : '';
    row.textContent = `${id.slice(0, 8)} · vs ${opp}${oppRating} · ${state.myColor || '?'}`;
    row.addEventListener('click', () => selectGame(id));
    gameListEl.appendChild(row);
  }
}

function selectGame(id) {
  selectedGameId = id;
  resetTelemetry();
  renderGameList();
  const state = activeGames.get(id);
  if (state) updateGameInfoPanel(state);
}

function clearBoardView() {
  boardSvg.innerHTML = '';
  gameInfoEl.textContent = 'No active game selected';
  resetTelemetry();
}

function fmtClock(ms) {
  if (ms == null) return '--:--';
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateGameInfoPanel(state) {
  const gs = state.lastClock;
  const opp = state.opponent?.id || state.opponent?.name || '—';
  const oppRating = state.opponent?.rating != null ? ` (${state.opponent.rating})` : '';
  gameInfoEl.innerHTML = `
    <div><strong>vs ${opp}${oppRating}</strong> (${state.speed || '?'}${state.rated ? ', rated' : ', casual'})</div>
    <div>playing: ${state.myColor || '?'} · status: ${state.status}</div>
    <div>clock — white ${fmtClock(gs?.wtime)} · black ${fmtClock(gs?.btime)}</div>
  `;
}

resignBtn.addEventListener('click', async () => {
  if (!selectedGameId) return;
  try { await client.resign(selectedGameId); log(`resigned game ${selectedGameId}`); }
  catch (e) { log('resign failed: ' + errDetail(e), 'log-err'); }
});
abortBtn.addEventListener('click', async () => {
  if (!selectedGameId) return;
  try { await client.abort(selectedGameId); log(`aborted game ${selectedGameId}`); }
  catch (e) { log('abort failed: ' + errDetail(e), 'log-err'); }
});

clearBoardView();

// ---------------------------------------------------------------------
// Settings UI wiring
// ---------------------------------------------------------------------

function bindNumber(id, path) {
  const el = document.getElementById(id);
  el.value = getPath(settings, path);
  el.addEventListener('change', () => { setPath(settings, path, Number(el.value)); persistSettings(); });
}
function bindCheckbox(id, path) {
  const el = document.getElementById(id);
  el.checked = getPath(settings, path);
  el.addEventListener('change', () => { setPath(settings, path, el.checked); persistSettings(); });
}
function bindSelect(id, path) {
  const el = document.getElementById(id);
  el.value = getPath(settings, path);
  el.addEventListener('change', () => { setPath(settings, path, el.value); persistSettings(); });
}
function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, val) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => o[k], obj);
  target[last] = val;
}

bindSelect('time-mode', 'time.mode');
bindNumber('static-depth', 'time.staticDepth');
bindNumber('static-safety-ms', 'time.staticSafetyMs');
bindNumber('dynamic-est-moves', 'time.estMovesLeft');
bindNumber('dynamic-inc-weight', 'time.incrementWeight');
bindNumber('dynamic-max-frac', 'time.maxFractionOfRemaining');
bindNumber('dynamic-min-ms', 'time.minMoveMs');
bindNumber('dynamic-max-ms', 'time.maxMoveMs');
bindNumber('dynamic-overhead-ms', 'time.overheadMs');
bindNumber('dynamic-max-depth', 'time.dynamicMaxDepth');

bindCheckbox('auto-accept', 'matchmaking.autoAccept');
bindSelect('rated-mode', 'matchmaking.ratedMode');
bindNumber('max-concurrent', 'matchmaking.maxConcurrentGames');
for (const speed of ['bullet', 'blitz', 'rapid', 'classical', 'correspondence']) {
  bindCheckbox('speed-' + speed, 'matchmaking.speeds.' + speed);
}

function toggleTimeModeUi() {
  const mode = settings.time.mode;
  document.getElementById('static-settings').style.display = mode === 'static' ? '' : 'none';
  document.getElementById('dynamic-settings').style.display = mode === 'dynamic' ? '' : 'none';
}
document.getElementById('time-mode').addEventListener('change', toggleTimeModeUi);
toggleTimeModeUi();

// ---------------------------------------------------------------------
// Time management presets (built-in + user-saved)
// ---------------------------------------------------------------------

// Reasonable starting points for each speed class, not tuned for any particular engine —
// treat them as a base to nudge from rather than an exact answer. All use dynamic mode.
const BUILTIN_TIME_PRESETS = {
  'Blitz, with increment': { estMovesLeft: 40, incrementWeight: 0.8, maxFractionOfRemaining: 0.05, minMoveMs: 200, maxMoveMs: 8000, overheadMs: 200, dynamicMaxDepth: 30 },
  'Blitz, no increment': { estMovesLeft: 40, incrementWeight: 0, maxFractionOfRemaining: 0.04, minMoveMs: 150, maxMoveMs: 6000, overheadMs: 200, dynamicMaxDepth: 30 },
  'Bullet': { estMovesLeft: 40, incrementWeight: 0.5, maxFractionOfRemaining: 0.03, minMoveMs: 50, maxMoveMs: 1500, overheadMs: 100, dynamicMaxDepth: 20 },
  'Rapid, no increment': { estMovesLeft: 40, incrementWeight: 0, maxFractionOfRemaining: 0.06, minMoveMs: 500, maxMoveMs: 15000, overheadMs: 300, dynamicMaxDepth: 40 },
};

// Maps every bound time.* field to its input element id, so a preset can be dropped
// straight into settings.time and the inputs resynced in one place.
const TIME_FIELD_IDS = {
  mode: 'time-mode',
  staticDepth: 'static-depth',
  staticSafetyMs: 'static-safety-ms',
  estMovesLeft: 'dynamic-est-moves',
  incrementWeight: 'dynamic-inc-weight',
  maxFractionOfRemaining: 'dynamic-max-frac',
  minMoveMs: 'dynamic-min-ms',
  maxMoveMs: 'dynamic-max-ms',
  overheadMs: 'dynamic-overhead-ms',
  dynamicMaxDepth: 'dynamic-max-depth',
};

let timePresets = loadJSON('timePresets', {}); // name -> saved settings.time snapshot

function refreshTimeInputsFromSettings() {
  for (const [key, id] of Object.entries(TIME_FIELD_IDS)) {
    const el = document.getElementById(id);
    if (el) el.value = settings.time[key];
  }
  toggleTimeModeUi();
}

function applyTimePreset(partial) {
  settings.time = { ...settings.time, ...partial };
  persistSettings();
  refreshTimeInputsFromSettings();
}

function populateTimePresetSelect(selectValue) {
  const sel = document.getElementById('time-preset-select');
  const prev = selectValue !== undefined ? selectValue : sel.value;
  const builtinOpts = Object.keys(BUILTIN_TIME_PRESETS)
    .map((name) => `<option value="builtin:${name}">${name}</option>`).join('');
  const savedNames = Object.keys(timePresets);
  const savedOpts = savedNames
    .map((name) => `<option value="saved:${name}">${name}</option>`).join('');
  sel.innerHTML =
    `<option value="">— select a preset —</option>` +
    `<optgroup label="Built-in">${builtinOpts}</optgroup>` +
    (savedNames.length ? `<optgroup label="Saved">${savedOpts}</optgroup>` : '');
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
}
populateTimePresetSelect();

document.getElementById('time-preset-select').addEventListener('change', (e) => {
  const val = e.target.value;
  if (!val) return;
  const sep = val.indexOf(':');
  const kind = val.slice(0, sep);
  const name = val.slice(sep + 1);
  if (kind === 'builtin' && BUILTIN_TIME_PRESETS[name]) {
    applyTimePreset({ mode: 'dynamic', ...BUILTIN_TIME_PRESETS[name] });
    log(`loaded built-in time preset "${name}"`, 'log-ok');
  } else if (kind === 'saved' && timePresets[name]) {
    applyTimePreset(timePresets[name]);
    log(`loaded saved time preset "${name}"`, 'log-ok');
  }
});

document.getElementById('time-preset-save-btn').addEventListener('click', () => {
  const nameInput = document.getElementById('time-preset-name');
  const name = nameInput.value.trim();
  if (!name) { log('enter a name before saving a time preset', 'log-err'); return; }
  timePresets[name] = { ...settings.time };
  saveJSON('timePresets', timePresets);
  populateTimePresetSelect(`saved:${name}`);
  nameInput.value = '';
  log(`saved current time settings as preset "${name}"`, 'log-ok');
});

document.getElementById('time-preset-delete-btn').addEventListener('click', () => {
  const sel = document.getElementById('time-preset-select');
  const val = sel.value;
  if (!val.startsWith('saved:')) {
    log('select one of your saved presets to delete it (built-in presets can\'t be removed)', 'log-err');
    return;
  }
  const name = val.slice('saved:'.length);
  delete timePresets[name];
  saveJSON('timePresets', timePresets);
  populateTimePresetSelect('');
  log(`deleted saved time preset "${name}"`);
});

// ---------------------------------------------------------------------
// Collapsible panels
// ---------------------------------------------------------------------

for (const panel of document.querySelectorAll('.panel[data-collapse-key]')) {
  const key = panel.dataset.collapseKey;
  const header = panel.querySelector('h2');
  if (!header) continue;

  const chevron = document.createElement('span');
  chevron.className = 'panel-chevron';
  chevron.textContent = '▸';
  header.prepend(chevron);

  const body = document.createElement('div');
  body.className = 'panel-body';
  for (const child of [...panel.children]) {
    if (child === header) continue;
    body.appendChild(child);
  }
  panel.appendChild(body);

  function setCollapsed(collapsed) {
    panel.classList.toggle('collapsed', collapsed);
    saveJSON(`panelCollapsed:${key}`, collapsed);
  }
  setCollapsed(!!loadJSON(`panelCollapsed:${key}`, false));

  header.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select, textarea, .info-icon')) return;
    setCollapsed(!panel.classList.contains('collapsed'));
  });
}

bindSelect('autoqueue-mode', 'autoQueue.mode');
populateTimeControlSelect();
bindSelect('autoqueue-timecontrol', 'autoQueue.timeControl');
bindCheckbox('autoqueue-rated', 'autoQueue.rated');
bindNumber('autoqueue-bots-per-attempt', 'autoQueue.botsPerAttempt');
bindNumber('autoqueue-bot-rating-min', 'autoQueue.botRatingMin');
bindNumber('autoqueue-bot-rating-max', 'autoQueue.botRatingMax');
renderBotCooldowns();

const autoQueueTargetsInput = document.getElementById('autoqueue-targets');
autoQueueTargetsInput.value = settings.autoQueue.targets;
autoQueueTargetsInput.addEventListener('change', () => {
  settings.autoQueue.targets = autoQueueTargetsInput.value;
  persistSettings();
});

const autoQueueIntervalInput = document.getElementById('autoqueue-interval');
autoQueueIntervalInput.value = settings.autoQueue.intervalSec;
autoQueueIntervalInput.addEventListener('change', () => {
  settings.autoQueue.intervalSec = Number(autoQueueIntervalInput.value);
  persistSettings();
  if (running) startQueueTimer(); // re-apply new interval immediately
});

const autoQueueEnabledInput = document.getElementById('autoqueue-enabled');
autoQueueEnabledInput.checked = settings.autoQueue.enabled;
autoQueueEnabledInput.addEventListener('change', () => {
  settings.autoQueue.enabled = autoQueueEnabledInput.checked;
  persistSettings();
  if (!running) return; // just a saved preference until the next connect
  if (settings.autoQueue.enabled) { queueOnce('auto-queue enabled'); startQueueTimer(); }
  else stopQueueTimer();
});

function toggleAutoQueueUi() {
  document.getElementById('autoqueue-targets-group').style.display =
    settings.autoQueue.mode === 'targets' ? '' : 'none';
  document.getElementById('autoqueue-bots-group').style.display =
    settings.autoQueue.mode === 'bots' ? '' : 'none';
}
document.getElementById('autoqueue-mode').addEventListener('change', toggleAutoQueueUi);
toggleAutoQueueUi();

bindCheckbox('chat-motd-enabled', 'chat.motdEnabled');
const chatMotdInput = document.getElementById('chat-motd');
chatMotdInput.value = settings.chat.motd;
chatMotdInput.addEventListener('change', () => { settings.chat.motd = chatMotdInput.value; persistSettings(); });

bindCheckbox('chat-end-message-enabled', 'chat.endMessageEnabled');
const chatEndInput = document.getElementById('chat-end-message');
chatEndInput.value = settings.chat.endMessage;
chatEndInput.addEventListener('change', () => { settings.chat.endMessage = chatEndInput.value || 'Good Game'; persistSettings(); });

bindCheckbox('chat-commands-enabled', 'chat.commandsEnabled');
const chatPrefixInput = document.getElementById('chat-command-prefix');
chatPrefixInput.value = settings.chat.commandPrefix;
chatPrefixInput.addEventListener('change', () => {
  settings.chat.commandPrefix = chatPrefixInput.value.trim() || '!';
  chatPrefixInput.value = settings.chat.commandPrefix;
  persistSettings();
});

const chatCodeInput = document.getElementById('chat-commands-code');
chatCodeInput.value = settings.chat.commandsCode;
chatCodeInput.addEventListener('change', () => {
  settings.chat.commandsCode = chatCodeInput.value;
  persistSettings();
  compileCommandHandler(chatCodeInput.value);
});
document.getElementById('chat-test-compile-btn').addEventListener('click', () => {
  compileCommandHandler(chatCodeInput.value);
  if (!compiledCommandError) log('chat command handler compiled OK', 'log-ok');
});
compileCommandHandler(settings.chat.commandsCode); // whatever was saved from last session

log('console ready. load an engine bundle and connect to begin.');

// -----------------------------------------------------------------
// Engine library (indexedDB) integration
// -----------------------------------------------------------------
let selectedLibraryId = null;

async function refreshLibraryUI() {
  const list = await listEngines();
  const container = document.getElementById('library-list');
  if (!container) return;
  container.innerHTML = list.map((r, i) =>
    `<div style="cursor:pointer;padding:2px 4px;border-bottom:1px solid #333;${i===0?'background:#333;':''}" onclick="window.selectLibraryId('${r.id}')">${r.manifest?.name || r.sourceName} (${r.manifest?.kind || '?'}) — ${new Date(r.addedAt).toLocaleString()}</div>`
  ).join('') || '<div style="color:#777">No stored engines</div>';
}
window.selectLibraryId = (id) => { selectedLibraryId = id; refreshLibraryUI(); };
window.loadLibraryEngine = async () => {
  if (!selectedLibraryId) return alert('Select an engine in the library first');
  const blob = await getEngineBlob(selectedLibraryId);
  if (!blob) return alert('Engine blob missing');
  // Feed to existing drop-zone handler via File-like object
  const file = new File([blob], 'library.zip', { type: 'application/zip' });
  fileInput.files = createFileList(file);
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
};
window.removeLibraryEngine = async () => {
  if (!selectedLibraryId) return alert('Select an engine to remove');
  await removeEngine(selectedLibraryId);
  selectedLibraryId = null;
  refreshLibraryUI();
};

function createFileList(file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  return dt.files;
}

// Library file input
const libInput = document.getElementById('library-file-input');
if (libInput) {
  libInput.addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      try {
        await addEngine(file);
        log('Library: added ' + file.name, 'log-ok');
      } catch (err) {
        log('Library: failed to add ' + file.name + ' — ' + err.message, 'log-err');
      }
    }
    libInput.value = '';
    refreshLibraryUI();
  });
}

refreshLibraryUI();
