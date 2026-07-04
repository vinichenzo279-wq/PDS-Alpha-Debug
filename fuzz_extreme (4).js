'use strict';
const {maxPossibleRating} = require('./extracted_ub_module.js');
const {bruteForceMax, futRatingRaw} = require('./ubverify/gap_lib.js');

function randInt(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function choice(arr){return arr[randInt(0,arr.length-1)];}
function sample(arr,k){const c=arr.slice();const out=[];for(let i=0;i<k&&c.length;i++){out.push(c.splice(randInt(0,c.length-1),1)[0]);}return out;}
function shuffle(arr){const c=arr.slice();for(let i=c.length-1;i>0;i--){const j=randInt(0,i);[c[i],c[j]]=[c[j],c[i]];}return c;}

const EPS=1e-6;

// ---------------------------------------------------------------------------
// GENERATORS. Each returns {pool, form, tag} where tag is a short label so
// overcount can be broken down per scenario type.
// ---------------------------------------------------------------------------

const posSets=[
  ['P','Q','R','S'],
  ['GK','CB','RB','LB','CM','ST'],
  ['A','B','C'],
  ['LB','LM','LW','CM'],
  ['GK','CB','CB','RB','LB','CM','CM','RW','LW','ST','ST'.slice(0)],
];

function genRandom(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(1,7);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const poolSize=randInt(N, N+7);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const nPos = Math.random()<0.3 ? randInt(2,3) : 1;
    const pos = sample(posAlphabet, Math.min(nPos, posAlphabet.length));
    if(!pos.length) continue;
    const hold = Math.random()<0.35 ? choice(['H1','H2','H3','H4']) : null;
    pool.push({id:i, rating: randInt(60,99), pos, hold});
  }
  return {pool, form:{slots}, tag:'random_baseline'};
}

// Every card shares ONE hold group but is spread across many positions -- forces the true max
// to use at most one player, while position-relaxed methods might be tempted to "use" several.
function genAllSameHold(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(2,7);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const pool=[];
  let id=0;
  // dominant hold group: many versatile, high-rated cards, but only ONE can ever be fielded
  const nDominant=randInt(3,8);
  for(let i=0;i<nDominant;i++){
    const nPos=randInt(1,Math.min(3,posAlphabet.length));
    const pos=sample(posAlphabet,nPos);
    if(!pos.length)continue;
    pool.push({id:id++, rating:randInt(80,99), pos, hold:'H_SAME'});
  }
  // distinct-hold/no-hold fillers so the other N-1 slots are still fillable
  for(let i=0;i<N+randInt(2,6);i++){
    const nPos=Math.random()<0.3?randInt(1,2):1;
    const pos=sample(posAlphabet,Math.min(nPos,posAlphabet.length));
    if(!pos.length)continue;
    const hold=Math.random()<0.4?choice(['F1','F2','F3','F4']):null;
    pool.push({id:id++, rating:randInt(60,90), pos, hold});
  }
  return {pool, form:{slots}, tag:'all_same_hold'};
}

// Small number of holds, but every card in every hold is eligible for EVERY formation position
// (maximally versatile) -- stresses the "position-agnostic" relaxations (UB-A) hardest.
function genFullyVersatile(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(2,6);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const nHolds=randInt(1,4);
  const holds=[]; for(let i=0;i<nHolds;i++) holds.push('HV'+i);
  const poolSize=randInt(N,N+5);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    pool.push({id:i, rating:randInt(60,99), pos:posAlphabet.slice(), hold: Math.random()<0.7?choice(holds):null});
  }
  return {pool, form:{slots}, tag:'fully_versatile'};
}

// All N slots are the SAME single position, pool is stacked with far more eligible cards than
// slots -- stresses UB-A (position-agnostic top-N) hardest since only N of the M eligible cards
// can really play, all M get "counted" by UB-A's non-position-aware top-N.
function genStackedSinglePosition(){
  const pos = choice(['ST','CB','GK','CM']);
  const N = randInt(1,5);
  const slots = new Array(N).fill(pos);
  const poolSize = randInt(N+3, N+12);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const hold = Math.random()<0.3 ? choice(['H1','H2','H3']) : null;
    pool.push({id:i, rating:randInt(60,99), pos:[pos], hold});
  }
  return {pool, form:{slots}, tag:'stacked_single_position'};
}

// Deliberately construct TWO disjoint eligibility components (so UB-C/D/E's union-find really
// does split them) but give BOTH components a card from the SAME hold group as their top pick.
// This targets the one relaxation UB-E does NOT fix (cross-component hold-sharing is still
// ignored, same as UB-C/D) -- the goal is to see how often/how badly this remaining gap bites.
function genCrossComponentSharedHold(){
  const compAPos=['P1','P2'], compBPos=['Q1','Q2'];
  const N = randInt(2,4)+randInt(2,4);
  const slotsA = new Array(randInt(1,3)).fill(0).map(()=>choice(compAPos));
  const slotsB = new Array(randInt(1,3)).fill(0).map(()=>choice(compBPos));
  const slots = shuffle([...slotsA, ...slotsB]);
  const sharedHold = 'SHARED';
  const pool=[];
  let id=0;
  // the shared-hold group's best card in EACH component (only one can really be fielded)
  pool.push({id:id++, rating:randInt(90,99), pos:[choice(compAPos)], hold:sharedHold});
  pool.push({id:id++, rating:randInt(90,99), pos:[choice(compBPos)], hold:sharedHold});
  // filler distinct-hold cards so each component can otherwise be filled
  for(let i=0;i<randInt(3,8);i++){
    const useA = Math.random()<0.5;
    const posAlphabet = useA?compAPos:compBPos;
    pool.push({id:id++, rating:randInt(60,95), pos:sample(posAlphabet,randInt(1,posAlphabet.length)), hold: Math.random()<0.4?choice(['F1','F2','F3']):null});
  }
  return {pool, form:{slots}, tag:'cross_component_shared_hold'};
}

// Pool exactly equals N (or N+1): almost no slack, forces the relaxations to be nearly exact
// (mostly a sanity/edge check, expect very high tight%).
function genTightPool(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(1,7);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const poolSize=N+randInt(0,1);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const nPos=Math.random()<0.5?randInt(1,2):1;
    const pos=sample(posAlphabet,Math.min(nPos,posAlphabet.length));
    if(!pos.length)continue;
    const hold=Math.random()<0.35?choice(['H1','H2']):null;
    pool.push({id:i, rating:randInt(60,99), pos, hold});
  }
  return {pool, form:{slots}, tag:'tight_pool_no_slack'};
}

// Huge, loose pool (lots of slack, lots of position overlap) -- the "worst case" direction for
// overcounting size, since more candidates means more room for every relaxation to be fooled.
function genHugePool(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(4,6);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const poolSize=randInt(N+6,N+11);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const nPos=Math.random()<0.5?randInt(2,Math.min(3,posAlphabet.length)):1;
    const pos=sample(posAlphabet,Math.min(nPos,posAlphabet.length));
    if(!pos.length)continue;
    const hold=Math.random()<0.5?choice(['H1','H2','H3','H4','H5','H6']):null;
    pool.push({id:i, rating:randInt(60,99), pos, hold});
  }
  return {pool, form:{slots}, tag:'huge_loose_pool'};
}

// Extreme rating spread: a tiny handful of 99s and a sea of 60s, all fully versatile, heavy hold
// sharing -- stress-tests futRatingRaw's spread-above-mean term (which is where the sum-vs-
// domination subtleties documented in the CHANGELOG live).
function genExtremeSpread(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N=randInt(2,6);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const poolSize=randInt(N+3,N+12);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const rating = Math.random()<0.15 ? randInt(96,99) : randInt(60,65);
    const nPos = Math.random()<0.4?randInt(2,Math.min(3,posAlphabet.length)):1;
    const pos=sample(posAlphabet,Math.min(nPos,posAlphabet.length));
    if(!pos.length)continue;
    const hold=Math.random()<0.5?choice(['H1','H2','H3']):null;
    pool.push({id:i, rating, pos, hold});
  }
  return {pool, form:{slots}, tag:'extreme_rating_spread'};
}

// Single-slot formation (N=1) edge case, and max-slot (N=7) with a small posAlphabet -- boundary
// sizes.
function genBoundarySizes(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N = choice([1,7]);
  const slots=[];for(let i=0;i<N;i++)slots.push(choice(posAlphabet));
  const poolSize=randInt(N,N+6);
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const nPos=Math.random()<0.3?randInt(2,3):1;
    const pos=sample(posAlphabet,Math.min(nPos,posAlphabet.length));
    if(!pos.length)continue;
    const hold=Math.random()<0.35?choice(['H1','H2','H3']):null;
    pool.push({id:i, rating:randInt(60,99), pos, hold});
  }
  return {pool, form:{slots}, tag:'boundary_sizes'};
}

const GENERATORS = [
  [genRandom, 0.30],
  [genAllSameHold, 0.08],
  [genFullyVersatile, 0.10],
  [genStackedSinglePosition, 0.12],
  [genCrossComponentSharedHold, 0.12],
  [genTightPool, 0.08],
  [genHugePool, 0.08],
  [genExtremeSpread, 0.07],
  [genBoundarySizes, 0.05],
];
function pickGenerator(){
  let r=Math.random(), acc=0;
  for(const [fn,w] of GENERATORS){ acc+=w; if(r<=acc) return fn; }
  return GENERATORS[0][0];
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
const TRIALS = parseInt(process.argv[2]||'150000',10);
const perTag = {};
let totalComparable=0, totalViolations=0, totalCapped=0;
const worst=[];

for(let t=0;t<TRIALS;t++){
  const gen = pickGenerator();
  const {pool, form, tag} = gen();
  if(!perTag[tag]) perTag[tag]={n:0, violations:0, tight:0, overcount:0, sumOver:0, maxOver:0, firstViolation:null, capped:0};
  const S = perTag[tag];

  let ub, bestRes;
  try { ub = maxPossibleRating(pool, form); } catch(e){ continue; }
  try { bestRes = bruteForceMax(pool, slotsOf(form)); } catch(e){ continue; }
  if(bestRes.capped){ totalCapped++; S.capped++; continue; } // oracle gave up -- can't compare, skip (not a violation)
  const best = bestRes.best;
  if(best===null) continue; // no legal XI exists at all under this draft
  if(ub===null) continue; // shouldn't happen if best exists, but guard anyway
  totalComparable++; S.n++;

  const bestFloored = Math.floor(best); // app compares floor(ub) vs floor(real rating) everywhere
  const gap = ub - bestFloored;
  if(gap < -EPS){
    S.violations++; totalViolations++;
    if(!S.firstViolation) S.firstViolation={pool,form,best,ub};
  } else if(gap > EPS){
    S.overcount++; S.sumOver+=gap; if(gap>S.maxOver) S.maxOver=gap;
    worst.push({tag,gap,pool,form,best,ub});
  } else {
    S.tight++;
  }
}
function slotsOf(form){return form.slots;}

function pct(n,d){return d?(100*n/d).toFixed(2)+'%':'n/a';}

console.log('=== EXTREME + RANDOM FUZZ: maxPossibleRating() (A+B+C+D+E combined) vs brute-force oracle ===');
console.log('trials requested:', TRIALS, ' | comparable trials (legal XI existed):', totalComparable, ' | oracle gave up (skipped):', totalCapped);
console.log('TOTAL VIOLATIONS (must be 0):', totalViolations);
console.log('');
console.log('Per-scenario breakdown:');
const tags=Object.keys(perTag).sort((a,b)=>perTag[b].n-perTag[a].n);
for(const tag of tags){
  const S=perTag[tag];
  console.log(`\n[${tag}]  n=${S.n}  (oracle capped/skipped: ${S.capped})`);
  console.log('  violations:', S.violations, S.violations? '  <<< CRITICAL':'');
  console.log('  tight:', S.tight, pct(S.tight,S.n));
  console.log('  overcount:', S.overcount, pct(S.overcount,S.n));
  console.log('  avg overcount when loose:', S.overcount?(S.sumOver/S.overcount).toFixed(4):'n/a');
  console.log('  max overcount observed:', S.maxOver.toFixed(4));
  if(S.firstViolation) console.log('  FIRST VIOLATION:', JSON.stringify(S.firstViolation));
}

worst.sort((a,b)=>b.gap-a.gap);
console.log('\n=== TOP 8 WORST OVERCOUNT CASES ACROSS ALL SCENARIOS ===');
for(let i=0;i<Math.min(8,worst.length);i++){
  const w=worst[i];
  console.log(`\n#${i+1} [${w.tag}] gap=${w.gap.toFixed(3)}  best=${w.best.toFixed(3)}  ub=${w.ub}`);
  console.log('  slots:', JSON.stringify(w.form.slots));
  console.log('  pool:', JSON.stringify(w.pool));
}
