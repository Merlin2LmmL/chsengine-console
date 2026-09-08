export function computeGoParams(mode, settings, clock) {
  if (mode === 'static') {
    return {
      depth: settings.staticDepth,
      movetimeMs: settings.staticSafetyMs,
    };
  }

  // dynamic
  if (settings.useEngineTimeManagement) {
    // Return raw clock state for engine-side time management (wtime/btime/winc/binc).
    // Do NOT include movetimeMs — movetime takes precedence over wtime/btime
    // in the engine's UCI fix (src/uci.rs) and would suppress the clock params.
    const { wtime, btime, winc, binc } = clock;
    return {
      depth: settings.dynamicMaxDepth,
      wtimeMs: wtime,
      btimeMs: btime,
      wincMs: winc,
      bincMs: binc,
    };
  }

  const { remainingMs, incrementMs } = clock;
  const overhead = settings.overheadMs;
  const safeRemaining = Math.max(remainingMs - overhead, 50);

  let budget = safeRemaining / settings.estMovesLeft + incrementMs * settings.incrementWeight;
  budget = Math.min(budget, safeRemaining * settings.maxFractionOfRemaining);
  budget = Math.max(budget, settings.minMoveMs);
  budget = Math.min(budget, settings.maxMoveMs);

  return {
    depth: settings.dynamicMaxDepth,
    movetimeMs: Math.round(budget),
  };
}

export const DEFAULT_TIME_SETTINGS = {
  mode: 'dynamic',
  useEngineTimeManagement: false,
  // static mode
  staticDepth: 5,
  staticSafetyMs: 10000,
  // dynamic mode
  estMovesLeft: 30,
  incrementWeight: 0.8,
  maxFractionOfRemaining: 0.5,
  minMoveMs: 200,
  maxMoveMs: 8000,
  overheadMs: 300,
  dynamicMaxDepth: 30,
};
