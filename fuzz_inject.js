// ===== Fuzz harness injected into the page =====
// v2: (1) RC is now modeled after how the real app derives it instead of a flat opts.rc=99,
//     (2) drafts can be generated at a separate, deliberately larger/harder "complex" tier so
//     we get data on big search spaces too, bounded purely by nodeCap so trials can't run forever.
window.__fuzzResults = [];

function scaledRandomDraft(opts){
  opts = opts||{};
  const f = FORMS[Math.floor(Math.random()*FORMS.length)];
  const rnd=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
  function shuffle(arr){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

  const slots = f.slots.map((p,i)=>({id:'P'+i,pos:p,busted:false}));
  // scaled-down bust range: bust MORE of the 11 slots so far fewer stay active
  const minBust = opts.minBust!==undefined?opts.minBust:3;
  const maxBust = opts.maxBust!==undefined?opts.maxBust:8;
  const numBusts = rnd(minBust, Math.min(maxBust, slots.length-2)); // keep at least 2 active
  const bustSet = new Set(shuffle(slots.slice()).slice(0,numBusts).map(s=>s.id));
  slots.forEach(s=>{s.busted=bustSet.has(s.id);});

  const nonBusted = slots.filter(s=>!s.busted);
  const minPer = opts.minPer!==undefined?opts.minPer:1;
  const maxPer = opts.maxPer!==undefined?opts.maxPer:2;

  function candidatesFor(pos){
    return playerDB.filter(p=>(p.pos||[]).includes(pos));
  }

  let uidLocal=1;
  const draftCards=[];
  nonBusted.forEach(slot=>{
    const pool=candidatesFor(slot.pos);
    if(!pool.length) return;
    const n=rnd(minPer,maxPer);
    const indices=shuffle(pool.map((_,i)=>i)).slice(0,Math.min(n,pool.length));
    indices.forEach(idx=>{
      const p=pool[idx];
      draftCards.push({
        id:uidLocal++,
        slot:slot.id,
        hold:null, // singles only for simplicity/scale-down (no hold-groups)
        label:p.name, type:p.type, rating:p.rating,
        nation:p.nation, league:p.league, club:p.club,
        pos:(p.pos||[]).slice()
      });
    });
  });

  // IMPORTANT: the solver must only ever be asked to fill the slots we actually generated cards
  // for. The real app never hands solveBest() the full formation when slots are busted --
  // completeOOP() always builds a subForm of only "coverable" slots (cand.length>0) first, and
  // handles busted/uncoverable slots separately via an out-of-position fallback outside the DFS.
  // Passing the untouched 11-slot `f` here (as the original harness did) forces the solver to
  // also fill the busted slots, which draftCards was never populated for -- either causing a hard
  // "no eligible card" error, or (worse, silently) a false "no legal XI" result from a genuine
  // pigeonhole failure across slots that were never supposed to be part of this search at all.
  // subForm is the form the solver should actually see.
  const subForm = {name: f.name, slots: nonBusted.map(s=>s.pos)};
  return {form:f, subForm, slots, draftCards, numBusts, activeCount: nonBusted.length};
}

function estimateCombos(form, cards){
  // rough product of per-slot candidate counts (upper bound, ignores hold-group collisions)
  const cand = form.slots.map(s=>cards.filter(c=>c.pos.includes(s)).length);
  if(cand.some(n=>n===0)) return 0;
  let prod=1;
  for(const n of cand){ prod*=n; if(prod>1e9) return prod; }
  return prod;
}

// ---------------------------------------------------------------------------
// RC modeling
// ---------------------------------------------------------------------------
// The real app defaults to "Optimal RC" ON: before every solve it snaps the Rating Ceiling
// slider to maxPossibleRating(cards, form) -- a closed-form, search-independent upper bound on
// any legal squad's rating for that exact draft -- and hides the manual slider entirely. A flat
// opts.rc=99 constant doesn't reflect that at all: real RC values move draft-to-draft with the
// pool (sometimes far below 99, sometimes above it), and it's *that* coupling between draft
// difficulty and RC tightness that drives node counts in production. We reproduce it here by
// calling the page's own maxPossibleRating() (already loaded as part of the app, not
// reimplemented) and using it as the default RC, with a couple of alternate modes to also gather
// comparison data on manual/mistuned RC behavior:
//   - 'auto'        : RC = maxPossibleRating(cards, form)  (the real, default app behavior)
//   - 'auto-jitter'  : RC = auto +/- a few points, simulating a user nudging the slider off the
//                      auto value (or the app falling back before a solve settles)
//   - 'manual'      : RC = opts.rc (flat constant, old harness behavior) -- kept only so we can
//                      diff against the realistic modes
function rndInt(a,b){return Math.floor(Math.random()*(b-a+1))+a;}

function computeRC(form, cards, opts){
  let ub = null;
  try{
    if(typeof maxPossibleRating === 'function'){
      ub = maxPossibleRating(cards, form);
    }
  }catch(e){ ub = null; } // e.g. no legal XI in this draft -- caller already filters those out
  const mode = opts.rcMode || 'auto';
  const fallback = 96; // the app's own slider default (85 + value 11) when ub can't be computed
  if(mode==='manual'){
    return {rc: (opts.rc!==undefined?opts.rc:99), ubRating: ub, rcMode: mode};
  }
  if(mode==='auto-jitter'){
    const base = (ub!==null?ub:fallback);
    const jitter = rndInt(-2,3);
    return {rc: base+jitter, ubRating: ub, rcMode: mode};
  }
  return {rc: (ub!==null?ub:fallback), ubRating: ub, rcMode: 'auto'};
}

function rcVsUb(rc, ub){
  if(ub===null||ub===undefined) return 'unknown';
  if(rc<ub) return 'below';       // may have pruned a real, better squad
  if(rc===ub) return 'exact';     // tightest sound ceiling
  return 'above';                 // sound but looser than necessary
}

// ---------------------------------------------------------------------------
// "Scaled" tier (original behavior): reroll the draft until the candidate-count estimate is
// small enough that the search is likely to finish uncapped, so we get clean improvement traces.
// ---------------------------------------------------------------------------
async function runFuzzTrial(i, opts){
  opts = opts||{};
  let draft, est, tries=0;
  const maxEst = opts.maxEst || 300000;
  do{
    draft = scaledRandomDraft(opts);
    est = estimateCombos(draft.subForm, draft.draftCards);
    tries++;
  } while((est===0 || est>maxEst) && tries<40);

  if(est===0 || est>maxEst){
    return {trial:i, skipped:true, reason:'could_not_scale_down', est, complexity:'scaled'};
  }

  const {rc:RC, ubRating, rcMode} = computeRC(draft.subForm, draft.draftCards, opts);

  const trace=[];
  const cap = opts.cap || 3000000;
  const t0=performance.now();
  const r = solveBestTraced(draft.subForm, draft.draftCards, cap, RC, undefined, undefined, trace);
  const ms = performance.now()-t0;

  return {
    trial:i,
    complexity:'scaled',
    skipped:false,
    formation: draft.form.name,
    numBusts: draft.numBusts,
    activeSlots: draft.activeCount,
    numCards: draft.draftCards.length,
    estCombos: est,
    capped: r.capped,
    totalNodes: r.nodes,
    bestScore: r.best,
    maxRating: r.maxRating,
    rcMode: rcMode,
    rcUsed: RC,
    ubRating: ubRating,
    rcVsUb: rcVsUb(RC, ubRating),
    ms: ms,
    trace: trace, // [{nodes,score}, ...] every time best improved
    finalFoundAt: trace.length? trace[trace.length-1].nodes : null,
    numImprovements: trace.length
  };
}

// ---------------------------------------------------------------------------
// "Complex" tier: deliberately generate bigger drafts (more active slots, more candidates per
// slot) without the reroll-until-small filter above, specifically so we can see where node
// counts / timings jump as the search space grows. These are expected to hit the node cap
// often -- that's the point (we want capped-search data, not just clean small cases) -- so the
// only thing bounding wall-clock time is `cap` (opts.cap), which every caller MUST set to a
// hard, safe ceiling (default kept modest below). No reroll loop, no maxEst gating.
// ---------------------------------------------------------------------------
const COMPLEX_HARD_CAP_CEILING = 4000000; // safety clamp: no complex trial is ever allowed above this, regardless of opts.cap
async function runFuzzTrialComplex(i, opts){
  opts = opts||{};
  const draft = scaledRandomDraft(opts);
  const est = estimateCombos(draft.subForm, draft.draftCards);

  if(est===0){
    return {trial:i, skipped:true, reason:'no_legal_combo', est, complexity:'complex'};
  }

  const {rc:RC, ubRating, rcMode} = computeRC(draft.subForm, draft.draftCards, opts);

  const trace=[];
  const cap = Math.min(opts.cap || 1500000, COMPLEX_HARD_CAP_CEILING);
  const t0=performance.now();
  const r = solveBestTraced(draft.subForm, draft.draftCards, cap, RC, undefined, undefined, trace);
  const ms = performance.now()-t0;

  return {
    trial:i,
    complexity:'complex',
    skipped:false,
    formation: draft.form.name,
    numBusts: draft.numBusts,
    activeSlots: draft.activeCount,
    numCards: draft.draftCards.length,
    estCombos: est,
    nodeCap: cap,
    capped: r.capped,
    totalNodes: r.nodes,
    bestScore: r.best,
    maxRating: r.maxRating,
    rcMode: rcMode,
    rcUsed: RC,
    ubRating: ubRating,
    rcVsUb: rcVsUb(RC, ubRating),
    ms: ms,
    trace: trace,
    finalFoundAt: trace.length? trace[trace.length-1].nodes : null,
    numImprovements: trace.length
  };
}

window.__runFuzzBatch = async function(n, opts){
  const out=[];
  for(let i=0;i<n;i++){
    out.push(await runFuzzTrial(i, opts||{}));
  }
  window.__fuzzResults = out;
  return out;
};

window.__runFuzzBatchComplex = async function(n, opts){
  const out=[];
  for(let i=0;i<n;i++){
    out.push(await runFuzzTrialComplex(i, opts||{}));
  }
  return out;
};
