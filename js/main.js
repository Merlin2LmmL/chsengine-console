import { saveJSON, loadJSON } from './store.js';
import { parseBundle, EngineInstance } from './engineLoader.js';
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
    clockLimitSec: 300,
    clockIncrementSec: 3,
    rated: false,
    intervalSec: 45,
    botsPerAttempt: 3,
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
  if (gs.status === 'aborted' || gs.status === 'noStart') return; // not a completed game, don't count

  let outcome;
  if (gs.winner === state.myColor) outcome = 'win';
  else if (gs.winner && gs.winner !== state.myColor) outcome = 'loss';
  else outcome = 'draw';

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
  const row = document.createElement('div');
  row.className = 'log-line' + (cls ? ' ' + cls : '');
  const t = new Date().toLocaleTimeString('en-GB');
  row.textContent = `[${t}] ${line}`;
  logEl.appendChild(row);
  while (logEl.children.length > MAX_LOG_LINES) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Pull the actual reason out of a LichessError's response body, e.g. {"error":"..."},
 * instead of just logging the bare "POST /path -> 400". Falls back to e.message for
 * anything else (engine errors, AbortError, etc). */
function errDetail(e) {
  if (!(e instanceof LichessError) || !e.body) return e.message;
  let detail = e.body;
  try {
    const parsed = JSON.parse(e.body);
    detail = parsed.error || parsed.message || e.body;
  } catch (_) { /* body wasn't JSON, use it as-is */ }
  return detail ? `${e.message} (${detail})` : e.message;
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
    saveJSON('bundle', fileMap);
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
    fileMap[base] = await entry.async('string');
  }
  await loadBundleFromFiles(fileMap);
}

async function handleRawFiles(fileList) {
  const fileMap = {};
  for (const f of fileList) fileMap[f.name] = await f.text();
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

function fmtClockSetting(aq) {
  return `${Math.round(aq.clockLimitSec / 60)}+${aq.clockIncrementSec}`;
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
  // Variant is always "standard" — same limitation as incoming-challenge filtering:
  // the board renderer and engine bundle only understand plain chess rules.
  const params = {
    clockLimit: aq.clockLimitSec,
    clockIncrement: aq.clockIncrementSec,
    rated: aq.rated,
    variant: 'standard',
  };
  try {
    if (aq.mode === 'targets') {
      const names = aq.targets.split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) { log('auto-queue: no usernames configured for "Challenge users" mode', 'log-err'); return; }
      for (const name of names) {
        if (activeGames.size >= settings.matchmaking.maxConcurrentGames) break;
        try {
          await client.challengeUser(name, params);
          log(`queued (${reason}): challenged ${name} — ${fmtClockSetting(aq)}${aq.rated ? ' rated' : ' casual'}`, 'log-ok');
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
          .map((b) => b.username || b.id)
          .filter((name) => name && name.toLowerCase() !== myUsername?.toLowerCase())
          .filter((name) => !isRecentlyChallenged(name))
      );
      if (!candidates.length) {
        log('auto-queue: no eligible online bots right now (none online, or all tried recently)');
        return;
      }
      const picks = candidates.slice(0, Math.max(1, aq.botsPerAttempt));
      for (const name of picks) {
        if (activeGames.size >= settings.matchmaking.maxConcurrentGames) break;
        markRecentlyChallenged(name);
        try {
          await client.challengeUser(name, params);
          log(`queued (${reason}): challenged bot ${name} — ${fmtClockSetting(aq)}${aq.rated ? ' rated' : ' casual'}`, 'log-ok');
        } catch (e) {
          log(`auto-queue: failed to challenge bot ${name}: ${errDetail(e)}`, 'log-err');
        }
      }
    } else {
      const resp = await client.createOpenChallenge(params);
      const url = resp?.challenge?.url || resp?.url || '';
      log(`queued (${reason}): posted open challenge${url ? ' — ' + url : ''} — ${fmtClockSetting(aq)}${aq.rated ? ' rated' : ' casual'}`, 'log-ok');
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
    lastClock: null,
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
        log(`game ${gameId} started vs ${state.opponent?.id || state.opponent?.name || 'anonymous'} (${state.myColor}, ${ev.speed}${ev.rated ? ' rated' : ' casual'})`, 'log-ok');
        await handleGameState(state, ev.state, gameChess);
      } else if (ev.type === 'gameState') {
        await handleGameState(state, ev, gameChess);
      } else if (ev.type === 'chatLine') {
        if (ev.username?.toLowerCase() !== myUsername?.toLowerCase()) log(`[chat ${gameId}] ${ev.username}: ${ev.text}`);
      } else if (ev.type === 'opponentGone') {
        if (ev.gone) log(`opponent left game ${gameId}, can claim win in ${ev.claimWinInSeconds}s`);
      }
    }, ac.signal);
  } catch (e) {
    if (e.name !== 'AbortError') log(`game stream ${gameId} ended: ${e.message}`, 'log-err');
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
  for (const m of newMoves) {
    gameChess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m.slice(4, 5) || undefined });
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
    recordGameResult(state, gs);
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
    if (selectedGameId !== state.id) return;
    const m = line.match(/depth (\d+).*?score cp (-?\d+).*?nodes (\d+).*?nps (\d+).*?time (\d+)/);
    if (m) pushTelemetry(+m[1], +m[2], +m[3], +m[4], +m[5]);
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
    row.textContent = `${id.slice(0, 8)} · vs ${opp} · ${state.myColor || '?'}`;
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
  gameInfoEl.innerHTML = `
    <div><strong>vs ${opp}</strong> (${state.speed || '?'}${state.rated ? ', rated' : ', casual'})</div>
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

bindSelect('autoqueue-mode', 'autoQueue.mode');
bindNumber('autoqueue-clock-limit', 'autoQueue.clockLimitSec');
bindNumber('autoqueue-clock-increment', 'autoQueue.clockIncrementSec');
bindCheckbox('autoqueue-rated', 'autoQueue.rated');
bindNumber('autoqueue-bots-per-attempt', 'autoQueue.botsPerAttempt');

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

log('console ready. load an engine bundle and connect to begin.');
