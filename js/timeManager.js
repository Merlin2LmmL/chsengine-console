// timeManager.js
//
// Turns the current clock state + user settings into the {depth, movetimeMs}
// pair that gets sent to the engine as a "go" command.
//
// Two modes:
//
//   static   - fixed search depth every move. `safetyMs` is passed as the
//              movetime cap so the iterative-deepening loop isn't cut off
//              before it reaches that depth (the engine already hard-caps
//              at 15s internally regardless of what we send).
//
//   dynamic  - depth is uncapped (up to `maxDepth`, a sanity ceiling) and the
//              move gets a computed time budget instead, based on remaining
//              clock. Standard "fraction of remaining time" allocator:
//
//                budget = remaining / estMovesLeft + increment * incWeight
//                budget = clamp(budget, minMoveMs, maxMoveMs)
//                budget = min(budget, remaining * maxFractionOfRemaining)
//
//              estMovesLeft is a rough guess of how many moves are left in
//              the game; smaller means it burns time faster early, larger
//              means it conserves more. The maxFractionOfRemaining clamp is
//              what actually prevents flagging: no single move is ever
//              allowed to spend more than that fraction of what's left on
//              the clock, no matter what the formula above says.

export function computeGoParams(mode, settings, clock) {
  if (mode === 'static') {
    return {
      depth: settings.staticDepth,
      movetimeMs: settings.staticSafetyMs,
    };
  }

  // dynamic
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
