'use strict';
const {maxPossibleRatingDetailed} = require('./html_extracted_ubs.js');
const {bruteForceMax} = require('./gap_lib.js');

function randInt(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function choice(arr){return arr[randInt(0,arr.length-1)];}
function sample(arr,k){const c=arr.slice();const out=[];for(let i=0;i<k&&c.length;i++){out.push(c.splice(randInt(0,c.length-1),1)[0]);}return out;}

const posSets=[
  ['P','Q','R','S'],
  ['GK','CB','RB','LB','CM','ST'],
  ['A','B','C'],
  ['LB','LM','LW','CM'],
];
const TRIALS = parseInt(process.argv[2]||'150000',10);
const EPS = 1e-6;
const methods=['a','b','c','d','e','h2'];
const stats={}; for(const m of methods) stats[m]={feasible:0,violations:0,over:0,overSum:0,overMax:0,tight:0,firstViol:null};
const combo={violations:0, tight:0, over:0, overSum:0, overMax:0};
const wins={}; const ties={}; for(const m of methods){wins[m]=0;ties[m]=0;}
// pairwise dominance-violation tracking (does X ever beat Y despite a "never looser than Y" claim?)
const pairChecks = [['e','d'],['d','c'],['c','b']]; // (should-never-be-looser-than) claims in the codebase
const pairViol = {}; for(const [x,y] of pairChecks) pairViol[`${x}<${y}`]=0, pairViol[`${y}<${x}`]=0;

let trialsWithXI=0;
const worst=[];

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
  let det, best;
  try{ det = maxPossibleRatingDetailed(pool, form); }catch(e){ continue; }
  try{ ({best} = bruteForceMax(pool, slots)); }catch(e){ continue; }
  if(best===null) continue;
  trialsWithXI++;
  if(!det){ continue; } // no method feasible at all (rare/impossible if best!=null, but guard)

  const named = det.named;
  for(const m of methods){
    const v = named[m];
    if(v===undefined) continue;
    stats[m].feasible++;
    const gap = v-best;
    if(gap < -EPS){ stats[m].violations++; if(!stats[m].firstViol) stats[m].firstViol={pool,slots,best,v}; }
    else if(gap > EPS){ stats[m].over++; stats[m].overSum+=gap; if(gap>stats[m].overMax) stats[m].overMax=gap; }
    else stats[m].tight++;
  }
  for(const [x,y] of pairChecks){
    if(named[x]!==undefined && named[y]!==undefined){
      if(named[x] < named[y]-EPS) pairViol[`${x}<${y}`]++;
      if(named[y] < named[x]-EPS) pairViol[`${y}<${x}`]++;
    }
  }

  const minV = det.min;
  const gap = minV-best;
  if(gap < -EPS) combo.violations++;
  else if(gap > EPS){ combo.over++; combo.overSum+=gap; if(gap>combo.overMax) combo.overMax=gap; worst.push({gap,pool,slots,best,named,minV}); }
  else combo.tight++;
  const atMin = methods.filter(m=>named[m]!==undefined && Math.abs(named[m]-minV)<=EPS);
  if(atMin.length===1) wins[atMin[0]]++;
  for(const m of atMin) ties[m]++;
}

function pct(n,d){return d?(100*n/d).toFixed(2)+'%':'n/a';}
function fmt(n){return typeof n==='number'?n.toFixed(4):n;}

console.log('=== FULL v10.3 maxPossibleRating() FUZZ (A,B,C,D,E,H2 + combined) ===');
console.log('trials:', TRIALS, ' trials with legal XI:', trialsWithXI);
console.log('');
for(const m of methods){
  const s=stats[m];
  console.log(`UB-${m.toUpperCase()}: feasible=${s.feasible}(${pct(s.feasible,trialsWithXI)}) VIOLATIONS=${s.violations} tight=${s.tight}(${pct(s.tight,s.feasible)}) over=${s.over}(${pct(s.over,s.feasible)}) avgOver=${s.over?fmt(s.overSum/s.over):'n/a'} maxOver=${fmt(s.overMax)}`);
  if(s.firstViol) console.log('   FIRST VIOLATION:', JSON.stringify(s.firstViol));
}
console.log('');
console.log('COMBINED min(A..H2): VIOLATIONS=',combo.violations,' tight=',combo.tight,pct(combo.tight,trialsWithXI),' over=',combo.over,pct(combo.over,trialsWithXI),' avgOver=',combo.over?fmt(combo.overSum/combo.over):'n/a',' maxOver=',fmt(combo.overMax));
console.log('');
console.log('Win-rate (sole-tightest / tied-or-tightest):');
for(const m of methods) console.log(`  UB-${m.toUpperCase()}: sole=${wins[m]}(${pct(wins[m],trialsWithXI)}) tied-or-sole=${ties[m]}(${pct(ties[m],trialsWithXI)})`);
console.log('');
console.log('Pairwise dominance-claim checks (codebase claims X "never looser than" Y -- looking for violations):');
for(const [x,y] of pairChecks){
  console.log(`  claim: UB-${y.toUpperCase()} never looser than UB-${x.toUpperCase()} predecessor / UB-${x.toUpperCase()} never looser than UB-${y.toUpperCase()}:`);
  console.log(`    UB-${x.toUpperCase()} < UB-${y.toUpperCase()} count: ${pairViol[`${x}<${y}`]}`);
  console.log(`    UB-${y.toUpperCase()} < UB-${x.toUpperCase()} count: ${pairViol[`${y}<${x}`]}`);
}
worst.sort((a,b)=>b.gap-a.gap);
console.log('\n=== TOP 5 WORST COMBINED-OVERCOUNT CASES ===');
for(let i=0;i<Math.min(5,worst.length);i++){
  const w=worst[i];
  console.log(`\n#${i+1} gap=${w.gap.toFixed(3)} best=${w.best.toFixed(3)} min=${w.minV.toFixed(3)} named=${JSON.stringify(w.named)}`);
  console.log('  slots:', JSON.stringify(w.slots));
  console.log('  pool:', JSON.stringify(w.pool));
}
