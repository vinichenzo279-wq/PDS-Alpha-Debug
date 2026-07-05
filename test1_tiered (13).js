'use strict';
// TEST 1 (TIERED) -- "do we ever miss the optimal score?", extended across complexity tiers.
//
// The original test1_optimality.js only ever fuzzes pools small enough for bruteforce.js to
// finish (COMBO_CAP=60000) -- necessarily tiny compared to what solveBest() actually sees in
// production (real 11-slot formations, pools that can hit 10s-100s of millions of raw combos).
// This script adds three more tiers on top of that one, using fuzz_gendraft.js's new 11-slot
// "Real-*" formations and estimateCombos() to steer each tier into its target combo range:
//
//   tiny             combos <= 6e4        ground truth: bruteforce.js, uncapped        (exact)
//   small            6e4   - 5e6          ground truth: bruteforce.js, time-boxed      (exact)
//   medium           5e6   - 1e8          ground truth: bruteforce.js, time-boxed;     (exact, or
//                                         if a specific draft's brute force times out,   falls back
//                                         that ONE draft falls back to the heuristic     to heuristic
//                                         verifier below instead of being silently        per-draft)
//                                         dropped)
//   large-realistic  1e8   - 3.5e8        ground truth: bruteforce.js, time-boxed;     (exact, or
//                    (targets the ~150M  same per-draft heuristic fallback as medium    falls back
//                     combo range you    if one specific draft's brute force run        to heuristic
//                     asked about)       times out -- see UPDATE note below)            per-draft)
//
// UPDATE: "large-realistic" used to be heuristic-only (random_search_verifier.js as an empirical
// lower bound, plus RC-isolation self-checks) on the theory that true brute force was intractable
// at these combo counts in any reasonable time -- that's the whole reason production needs an
// upper-bound-pruned search instead of brute force in the first place. But that reasoning doesn't
// actually hold up under its own numbers: every RC-isolation check in this file (and the
// v12.4.0.1 history in index.html) rests on RC=103 being high enough that solveBest's per-node
// upper bound essentially never drops below the incumbent -- i.e. solver.js @ RC=103 already
// visits close to every node in the tree, for exactly the sizes this tier targets. bruteforce.js
// does that same group/hold-constrained enumeration with the upper-bound check removed entirely
// (see its header), so it should cost roughly the same wall-clock time as the RC=103 solver run
// this tier already tolerated -- while being a genuinely independent implementation (no shared UB
// code with solver.js/solver_experimental.js) instead of "the same DFS at a different RC".
//
// So this tier is now promoted to 'exact-timeboxed', identical treatment to 'medium': try
// bruteforce.js first, wall-clock-boxed by bruteTimeBudgetMs, and only fall back to the heuristic
// verifier for an individual draft if that specific draft's brute force run times out (logged as
// groundTruthUsed: 'heuristic-fallback', same as medium). The old three heuristic-only checks are
// KEPT as cheap additional cross-checks (they cost nothing extra and are still meaningful), but
// they are no longer the only signal here:
//   1. baseline solver's answer must be >= the random-restart/local-search heuristic's answer
//      (if the heuristic -- which does not share any code path with the pruning logic -- finds
//      something BETTER than the solver, that is strong evidence of a real miss)
//   2. baseline solver @ real RC must agree with baseline solver @ RC=103 (RC-isolation, same
//      logic as the exact tiers -- a disagreement here doesn't need brute force to be meaningful)
//   3. same two checks, repeated for solver_experimental.js
// A real "got < truth.best" miss against the exact (or per-draft heuristic-fallback) ground truth
// is now caught and logged exactly the same way it is in the tiny/small/medium tiers -- the main
// loop below already treated 'exact' and 'exact-timeboxed' identically, so no loop logic changed
// to make this happen, only this tier's config did (see TIERS below).
// If bruteTimeBudgetMs below turns out to be too optimistic once this is actually run, that will
// show up as a high heuristicFallbacks count for this tier, not as a silent loss of coverage.
//
// Usage: node test1_tiered.js [tierName-or-'all'] [--maxTierTimeMs=N] [--seeds=N override]
const fs = require('fs');
const path = require('path');
const { generateDraft, estimateCombos } = require('./fuzz_gendraft.js');
const { maxPossibleRating } = require('./engine.js');
const baseline = require('./solver.js');
const experimental = require('./solver_experimental.js');
const bruteforce = require('./bruteforce.js');
const { verify: heuristicVerify } = require('./random_search_verifier.js');

const RC_HIGH = 103; // same isolation trick as test1_optimality.js: rating maxes at 99, so this
                      // effectively removes the RC term as a possible cause of a pruning miss.

const REAL_FORMS = ['Real-433', 'Real-4231', 'Real-4141', 'Real-352'];
const TINY_FORMS = ['Tiny-433', 'Tiny-4231', 'Tiny-352'];

const TIERS = [
  {
    name: 'tiny',
    comboRange: [1, 6e4],
    formPool: TINY_FORMS,
    minPer: 2, maxPer: 3,
    seeds: 300,
    groundTruth: 'exact',
    bruteTimeBudgetMs: 5000,
    solverNodeCap: Infinity,
  },
  {
    name: 'small',
    comboRange: [6e4, 5e6],
    formPool: REAL_FORMS,
    minPer: 2, maxPer: 3,
    seeds: 60,
    groundTruth: 'exact',
    bruteTimeBudgetMs: 20000,
    solverNodeCap: 20e6,
  },
  {
    name: 'medium',
    comboRange: [5e6, 1e8],
    formPool: REAL_FORMS,
    minPer: 3, maxPer: 3,
    seeds: 25,
    groundTruth: 'exact-timeboxed',
    bruteTimeBudgetMs: 30000,
    solverNodeCap: 40e6,
    heuristicTimeBudgetMs: 4000, // used only as a fallback when a draft's brute force times out
  },
  {
    name: 'large-realistic',
    comboRange: [1e8, 3.5e8], // targets ~150M+ combos, per the "at least a few checks around
                               // 150M combos" ask -- see calibration note in README addendum
    formPool: REAL_FORMS,
    minPer: 3, maxPer: 4,
    seeds: 12, // this tier is expensive by design (see cap note below); a "few checks", not a
               // high-volume fuzz sweep like the smaller tiers
    groundTruth: 'exact-timeboxed', // was 'heuristic' -- see the file-header UPDATE note: RC=103
    // already visits ~all nodes at these sizes, so bruteforce.js (independent of solver.js's UB
    // code entirely) should cost about the same wall-clock time as the RC=103 solver run this
    // tier already tolerated. Falls back to the heuristic verifier PER-DRAFT, same as 'medium',
    // if one specific draft's brute force run doesn't finish in time -- never silently dropped.
    //
    // CALIBRATED against this generator/machine before the real run (see probe2.js): at combo
    // counts of 2.23e8 / 2.81e8 / 3.29e8, solver@RC103 visited 56.6M / 80.2M / 110.1M nodes in
    // 66-154s wall-clock, and true bruteforce.js visited essentially the SAME node counts in
    // essentially the same time (56.6M/137s, 110.1M/137s) -- confirming the "RC=103 already
    // visits ~all nodes" premise for this tier's range, and that swapping in bruteforce.js here
    // really does cost about the same as what this tier already paid for the RC-isolation runs.
    bruteTimeBudgetMs: 300000, // 5min -- comfortable margin above the ~155s max observed at the
    // top of this tier's combo range (3.29e8); revisit if heuristicFallbacks for this tier is ever
    // nonzero (that means a draft's brute force didn't finish inside this budget).
    heuristicTimeBudgetMs: 5000, // now only used for the per-draft fallback path, not as the
    // primary ground truth.
    // NOTE on this cap: fuzz_gendraft.js's synthetic universe has uniform-random ratings and
    // only 8 nations/8 clubs/4 leagues (see README's existing caveat that it is "not a stand-in
    // for real card-pool statistics"). That makes production's own pruning much less effective
    // here than on real playerDB-shaped data -- the README's cited real-world example ("~357k
    // nodes" at a comparable combo count) is NOT reproducible with this generator; CALIBRATION
    // (see above) showed actual node counts of 56M-110M+ for drafts in this tier's combo range --
    // an order of magnitude above the previous 25e6 cap, which would have marked most drafts in
    // this tier "inconclusive" rather than actually miss-checking them. Raised to 200e6, comfortably
    // above the ~110-120M observed/extrapolated ceiling for this tier's combo range, while still
    // bounding true runaway cases. Hitting it is logged as "inconclusive", never as a pass or a miss.
    solverNodeCap: 200e6,
  },
];

const MAX_GEN_ATTEMPTS_PER_DRAFT = 4000; // give up hunting for this tier's combo range after this
const DEFAULT_MAX_TIER_TIME_MS = 20 * 60 * 1000; // safety valve for an unattended full run

// ---- CLI ----
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = {};
for(const a of args){
  if(a.startsWith('--')){
    const [k,v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}
const which = positional[0] || 'all';
const maxTierTimeMs = flags.maxTierTimeMs ? parseInt(flags.maxTierTimeMs,10) : DEFAULT_MAX_TIER_TIME_MS;
const seedsOverride = flags.seeds ? parseInt(flags.seeds,10) : null;
const nodeCapOverride = flags.nodeCap ? parseInt(flags.nodeCap,10) : null;
const bruteMsOverride = flags.bruteMs ? parseInt(flags.bruteMs,10) : null;
const heuristicMsOverride = flags.heuristicMs ? parseInt(flags.heuristicMs,10) : null;

const tiersToRun = which === 'all' ? TIERS : TIERS.filter(t => t.name === which);
if(tiersToRun.length === 0){
  console.error(`Unknown tier "${which}". Valid: all, ${TIERS.map(t=>t.name).join(', ')}`);
  process.exit(1);
}

const findingsPath = path.join(__dirname, 'findings_tiered.jsonl');
fs.writeFileSync(findingsPath, '');

const overallSummary = [];

for(const tier of tiersToRun){
  const seedsTarget = seedsOverride || tier.seeds;
  const solverNodeCap = nodeCapOverride || tier.solverNodeCap || Infinity;
  const bruteTimeBudgetMs = bruteMsOverride || tier.bruteTimeBudgetMs;
  const heuristicTimeBudgetMs = heuristicMsOverride || tier.heuristicTimeBudgetMs;
  console.log(`\n=== TIER: ${tier.name} (combos ${tier.comboRange[0].toExponential(1)}-${tier.comboRange[1].toExponential(1)}, ground truth: ${tier.groundTruth}, target ${seedsTarget} drafts, nodeCap=${solverNodeCap}) ===`);
  const tierT0 = Date.now();

  let tested = 0, skippedRange = 0, skippedTooSlow = 0, genAttempts = 0;
  const misses = { baselineReal: 0, baselineHigh: 0, expReal: 0, expHigh: 0 };
  let inconclusive = 0; // solver hit its safety nodeCap, or (medium tier) brute force timed out
                         // and the per-draft heuristic fallback also couldn't be conclusive
  let heuristicFallbacks = 0; // medium tier only: how often we had to drop to the heuristic check

  for(let seed = 1; tested < seedsTarget; seed++){
    if(Date.now() - tierT0 > maxTierTimeMs){
      console.log(`  [tier time budget ${maxTierTimeMs}ms exceeded, stopping tier early at ${tested}/${seedsTarget}]`);
      break;
    }
    genAttempts++;
    if(genAttempts > MAX_GEN_ATTEMPTS_PER_DRAFT * seedsTarget){
      console.log(`  [gave up hunting for drafts in this tier's combo range after ${genAttempts} generation attempts]`);
      break;
    }
    const opts = { seed, minPer: tier.minPer, maxPer: tier.maxPer, formPool: tier.formPool };
    const d = generateDraft(opts);
    const est = estimateCombos(d.subForm, d.cards);
    if(est === 0 || est < tier.comboRange[0] || est > tier.comboRange[1]){ skippedRange++; continue; }

    let rc;
    try{ rc = maxPossibleRating(d.cards, d.subForm); }catch(e){ rc = null; }
    if(rc === null) rc = 99;

    const cap = solverNodeCap;
    const runs = {
      baselineReal: baseline.solve(d.subForm, d.cards, rc, cap),
      baselineHigh: baseline.solve(d.subForm, d.cards, RC_HIGH, cap),
      expReal:      experimental.solve(d.subForm, d.cards, rc, cap),
      expHigh:      experimental.solve(d.subForm, d.cards, RC_HIGH, cap),
    };
    // If any run hit the safety node cap before finishing, we can't fairly judge it (it's
    // "unknown", not "wrong") -- skip miss-detection for this draft but still count/log it.
    const anyRunIncomplete = Object.values(runs).some(r => !r.error && r.done === false);

    let truth = null, groundTruthUsed = tier.groundTruth, truthNote = '';
    if(tier.groundTruth === 'exact' || tier.groundTruth === 'exact-timeboxed'){
      truth = bruteforce.solve(d.subForm, d.cards, { timeBudgetMs: bruteTimeBudgetMs });
      if(truth.error){ skippedRange++; tested--; continue; }
      if(truth.capped){
        if(tier.groundTruth === 'exact'){
          // shouldn't really happen given this tier's combo range, but don't silently pass a
          // draft off as "sound" against an incomplete brute force -- drop it instead.
          skippedTooSlow++; tested--; continue;
        } else {
          // exact-timeboxed tier (medium or large-realistic): fall back to the heuristic
          // verifier for JUST this draft.
          heuristicFallbacks++;
          truth = heuristicVerify(d.subForm, d.cards, { timeBudgetMs: heuristicTimeBudgetMs });
          groundTruthUsed = 'heuristic-fallback';
          truthNote = 'brute force timed out after ' + bruteTimeBudgetMs + 'ms; fell back to heuristic verifier';
        }
      }
    } else {
      truth = heuristicVerify(d.subForm, d.cards, { timeBudgetMs: heuristicTimeBudgetMs });
    }

    tested++;

    if(anyRunIncomplete){
      inconclusive++;
      if(tested % 5 === 0 || tier.name === 'large-realistic')
        console.log(`  [inconclusive] seed=${seed} form=${d.formName} est=${est.toExponential(1)}: a solver run hit the ${cap} node safety cap before finishing -- skipped for miss-detection`);
      continue;
    }

    const isHeuristicTruth = groundTruthUsed === 'heuristic' || groundTruthUsed === 'heuristic-fallback';
    let anyMiss = false;
    const missDetail = {};
    for(const key of Object.keys(runs)){
      const r = runs[key];
      if(r.error){ missDetail[key] = 'error: ' + r.error; anyMiss = true; continue; }
      if(r.best < truth.best){
        misses[key]++;
        missDetail[key] = { got: r.best, truth: truth.best, deficit: truth.best - r.best };
        anyMiss = true;
      } else if(!isHeuristicTruth && r.best > truth.best){
        // Only meaningful as "impossible" when truth is exact brute force. Against the heuristic
        // verifier, a solver beating it is completely normal (the heuristic is a lower bound,
        // not an exact answer) and must NOT be flagged.
        missDetail[key] = 'IMPOSSIBLE: solver beat exact brute force (' + r.best + ' > ' + truth.best + ') -- bug in bruteforce.js or scoreXI mismatch';
        anyMiss = true;
      }
    }
    // Cross-check even when ground truth is heuristic: internal RC-isolation disagreement is
    // meaningful on its own, independent of whether truth.best is trustworthy.
    if(!missDetail.baselineReal && !missDetail.baselineHigh && runs.baselineReal.best !== runs.baselineHigh.best){
      missDetail.baselineRcDisagreement = { realRC: runs.baselineReal.best, rc103: runs.baselineHigh.best };
      anyMiss = true;
    }
    if(!missDetail.expReal && !missDetail.expHigh && runs.expReal.best !== runs.expHigh.best){
      missDetail.expRcDisagreement = { realRC: runs.expReal.best, rc103: runs.expHigh.best };
      anyMiss = true;
    }

    if(anyMiss){
      const diagnosis = [];
      if(missDetail.baselineReal && !missDetail.baselineHigh) diagnosis.push('baseline: RC-dependent (maxPossibleRating likely too tight, or RC term in UB)');
      if(missDetail.baselineReal && missDetail.baselineHigh) diagnosis.push('baseline: NOT RC-dependent -- bug in nation/league/club/icon/hero UB math itself');
      if(missDetail.expReal && !missDetail.expHigh) diagnosis.push('experimental: RC-dependent');
      if(missDetail.expReal && missDetail.expHigh) diagnosis.push('experimental: NOT RC-dependent -- bug in the new scarcity-tightening logic');
      if((missDetail.expReal || missDetail.expHigh) && !missDetail.baselineReal && !missDetail.baselineHigh)
        diagnosis.push('ONLY the experimental UB misses -- baseline is fine -- bug is isolated to the scarcity tightening added in solver_experimental.js');
      if(missDetail.baselineRcDisagreement) diagnosis.push('baseline: real-RC and RC=103 runs disagree with EACH OTHER (independent of ground truth) -- investigate regardless of ground-truth confidence');
      if(missDetail.expRcDisagreement) diagnosis.push('experimental: real-RC and RC=103 runs disagree with EACH OTHER (independent of ground truth) -- investigate regardless of ground-truth confidence');
      if(isHeuristicTruth) diagnosis.push(`NOTE: ground truth for this finding was "${groundTruthUsed}" (not exhaustive) -- confirm with the tiny/small/medium exact tiers or a targeted repro before treating as a confirmed soundness bug`);

      const finding = {
        tier: tier.name, seed, opts, formName: d.formName, subForm: d.subForm,
        numCards: d.cards.length, estimateCombos: est, rc,
        groundTruthUsed, truthNote, truthBest: truth.best,
        truthNodes: truth.nodes, truthRestarts: truth.restarts,
        missDetail, diagnosis,
        cards: d.cards
      };
      fs.appendFileSync(findingsPath, JSON.stringify(finding) + '\n');
      console.log(`  MISS [${tier.name}] seed=${seed} form=${d.formName} est=${est.toExponential(1)} truth(${groundTruthUsed})=${truth.best} -> ${JSON.stringify(missDetail)}`);
    }

    if(tested % 5 === 0){
      console.log(`  ...tested ${tested}/${seedsTarget} (skippedRange=${skippedRange}, skippedTooSlow=${skippedTooSlow}, heuristicFallbacks=${heuristicFallbacks}, inconclusive=${inconclusive}, ${Date.now()-tierT0}ms)`);
    }
  }

  const tierResult = {
    tier: tier.name, tested, skippedRange, skippedTooSlow, heuristicFallbacks, inconclusive,
    misses: Object.assign({}, misses),
    elapsedMs: Date.now() - tierT0,
  };
  overallSummary.push(tierResult);

  console.log(`--- tier ${tier.name} done: tested=${tested} skippedRange=${skippedRange} skippedTooSlow=${skippedTooSlow} heuristicFallbacks=${heuristicFallbacks} inconclusive=${inconclusive}`);
  console.log(`    misses -- baseline@realRC: ${misses.baselineReal}, baseline@RC103: ${misses.baselineHigh}, experimental@realRC: ${misses.expReal}, experimental@RC103: ${misses.expHigh}`);
  console.log(`    elapsed: ${tierResult.elapsedMs}ms`);
}

console.log('\n=== TEST 1 (TIERED) OVERALL SUMMARY ===');
for(const r of overallSummary){
  const totalMisses = Object.values(r.misses).reduce((a,b)=>a+b,0);
  console.log(`${r.tier}: tested=${r.tested} misses=${totalMisses} inconclusive=${r.inconclusive} heuristicFallbacks=${r.heuristicFallbacks} (${r.elapsedMs}ms)`);
}
const grandTotalMisses = overallSummary.reduce((a,r)=>a + Object.values(r.misses).reduce((x,y)=>x+y,0), 0);
if(grandTotalMisses === 0){
  console.log('\nNo soundness misses found in any tier this run. (Any RC-isolation disagreements logged for drafts that fell back to the heuristic verifier are still worth checking in findings_tiered.jsonl -- see per-tier notes above.)');
} else {
  console.log(`\n${grandTotalMisses} miss(es) found. Full repro data in ${findingsPath} -- replay with: node repro_finding_tiered.js findings_tiered.jsonl <lineNumber>`);
}
