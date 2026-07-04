'use strict';
const {maxPossibleRatingRaw, bruteForceMax, futRatingRaw} = require('./gap_lib.js');
const {ubD} = require('./ubd_fixed.js');

function randInt(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function choice(arr){return arr[randInt(0,arr.length-1)];}
function sample(arr,k){const c=arr.slice();const out=[];for(let i=0;i<k&&c.length;i++){out.push(c.splice(randInt(0,c.length-1),1)[0]);}return out;}

const posSets=[
  ['P','Q','R','S'],
  ['GK','CB','RB','LB','CM','ST'],
  ['A','B','C'],
  ['LB','LM','LW','CM'],
  ['GK','CB','CB','RB','LB','CM','CM','RW','LW','ST','ST'.slice(0)], // denser overlap flavor
];

const TRIALS = 150000;
const EPS = 1e-6;

const methods = ['a','b','c','d'];
const stats = {};
for(const m of methods){
  stats[m] = {feasible:0, violations:0, overcountN:0, overcountSum:0, overcountMax:0, tight:0, firstViolation:null};
}
const combo = {violations:0, overcountN:0, overcountSum:0, overcountMax:0, tight:0};
const worstCases = []; // top offenders by combined overcount, for diagnosis
const wins = {a:0,b:0,c:0,d:0}; // unique-tightest count
const ties = {a:0,b:0,c:0,d:0}; // participates in a tie for tightest
let bothFeasibleAny=0, noMethodFeasible=0, trialsWithLegalXI=0;

for(let t=0;t<TRIALS;t++){
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
  const form={slots};

  let abc, d, best;
  try { abc = maxPossibleRatingRaw(pool, form); } catch(e){ continue; }
  try { d = ubD(pool, form); } catch(e){ continue; }
  try { ({best} = bruteForceMax(pool, slots)); } catch(e){ continue; }
  if(best===null) continue; // no legal XI exists at all -- nothing to score
  trialsWithLegalXI++;

  const vals = {a:abc.a, b:abc.b, c:abc.c, d:d};
  let anyFeasible=false;
  for(const m of methods){
    const v = vals[m];
    if(v===null || v===undefined) continue;
    anyFeasible=true;
    stats[m].feasible++;
    const gap = v - best;
    if(gap < -EPS){
      stats[m].violations++;
      if(!stats[m].firstViolation) stats[m].firstViolation = {pool,slots,best,v};
    } else if(gap > EPS){
      stats[m].overcountN++;
      stats[m].overcountSum += gap;
      if(gap > stats[m].overcountMax) stats[m].overcountMax = gap;
    } else {
      stats[m].tight++;
    }
  }
  if(anyFeasible) bothFeasibleAny++; else noMethodFeasible++;

  // combined min() -- what the app actually uses
  const feasibleVals = methods.map(m=>vals[m]).filter(v=>v!==null&&v!==undefined);
  if(feasibleVals.length){
    const minV = Math.min(...feasibleVals);
    const gap = minV - best;
    if(gap < -EPS) combo.violations++;
    else if(gap > EPS){
      combo.overcountN++; combo.overcountSum += gap; if(gap>combo.overcountMax) combo.overcountMax = gap;
      worstCases.push({gap, pool, slots, best, vals:{a:vals.a,b:vals.b,c:vals.c,d:vals.d}, minV});
    }
    else combo.tight++;
    // which method(s) achieve minV (within eps) -- for win-rate bookkeeping
    const atMin = methods.filter(m=>vals[m]!==null&&vals[m]!==undefined && Math.abs(vals[m]-minV)<=EPS);
    if(atMin.length===1) wins[atMin[0]]++;
    for(const m of atMin) ties[m]++;
  }
}

function pct(n,d){ return d? (100*n/d).toFixed(2)+'%' : 'n/a'; }
function fmt(n){ return (typeof n==='number') ? n.toFixed(4) : n; }

console.log('=== BROAD UB FUZZ: A vs B vs C vs D vs combined min() ===');
console.log('trials run:', TRIALS, ' | trials with a legal XI to compare against:', trialsWithLegalXI);
console.log('');
for(const m of methods){
  const s = stats[m];
  console.log(`UB-${m.toUpperCase()}`);
  console.log('  feasible (produced a bound):', s.feasible, pct(s.feasible, trialsWithLegalXI));
  console.log('  VIOLATIONS (ub < true max -- must be 0):', s.violations);
  console.log('  exact/tight (ub === true max):', s.tight, pct(s.tight, s.feasible));
  console.log('  overcounts (ub > true max):', s.overcountN, pct(s.overcountN, s.feasible));
  console.log('  avg overcount when loose:', s.overcountN? fmt(s.overcountSum/s.overcountN) : 'n/a');
  console.log('  max overcount observed:', fmt(s.overcountMax));
  if(s.firstViolation) console.log('  FIRST VIOLATION EXAMPLE:', JSON.stringify(s.firstViolation));
  console.log('');
}
console.log('COMBINED min(A,B,C,D) -- what the app actually uses as maxPossibleRating()');
console.log('  VIOLATIONS (must be 0):', combo.violations);
console.log('  exact/tight:', combo.tight, pct(combo.tight, trialsWithLegalXI));
console.log('  overcounts:', combo.overcountN, pct(combo.overcountN, trialsWithLegalXI));
console.log('  avg overcount when loose:', combo.overcountN? fmt(combo.overcountSum/combo.overcountN) : 'n/a');
console.log('  max overcount observed:', fmt(combo.overcountMax));
console.log('');
console.log('WIN-RATE (which method actually determines the combined min):');
for(const m of methods){
  console.log(`  UB-${m.toUpperCase()}: sole-tightest ${wins[m]} (${pct(wins[m],trialsWithLegalXI)}), tied-or-tightest ${ties[m]} (${pct(ties[m],trialsWithLegalXI)})`);
}

worstCases.sort((x,y)=>y.gap-x.gap);
console.log('');
console.log('=== TOP 5 WORST COMBINED-OVERCOUNT CASES (for diagnosing remaining looseness) ===');
for(let i=0;i<Math.min(5,worstCases.length);i++){
  const w = worstCases[i];
  console.log(`\n#${i+1} gap=${w.gap.toFixed(3)}  best=${w.best.toFixed(3)}  min(A,B,C,D)=${w.minV.toFixed(3)}`);
  console.log('  per-method:', JSON.stringify(w.vals));
  console.log('  slots:', JSON.stringify(w.slots));
  console.log('  pool:', JSON.stringify(w.pool));
}
