'use strict';
const {maxPossibleRating} = require('./maxPossibleRating_full.js');
const {bruteForceMax} = require('./gap_lib.js');

function randInt(a,b){return a+Math.floor(Math.random()*(b-a+1));}
function choice(arr){return arr[randInt(0,arr.length-1)];}
function sample(arr,k){const c=arr.slice();const out=[];for(let i=0;i<k&&c.length;i++){out.push(c.splice(randInt(0,c.length-1),1)[0]);}return out;}

const EPS = 1e-6;

// Realistic-ish position alphabets (actual formation-shaped, not abstract letters)
const posSets=[
  ['GK','CB','RB','LB','CM','ST'],
  ['GK','CB','RB','LB','CDM','CM','CAM','RW','LW','ST'],
  ['GK','CB','RB','LB','CM','RM','LM','ST'],
  ['GK','CB','RB','LB','CDM','RM','LM','CAM','ST'],
];

// "Randomish" generator: modest pool sizes relative to formation, modest position
// versatility, modest hold-sharing rate -- meant to resemble an ordinary draft, not an
// adversarially constructed worst case.
function genRandomish(){
  const posAlphabet=[...new Set(choice(posSets))];
  const N = randInt(4,11); // realistic XI-ish sizes
  const slots=[]; for(let i=0;i<N;i++) slots.push(choice(posAlphabet));
  const poolSize = randInt(N+2, N+15); // realistic amount of slack
  const pool=[];
  for(let i=0;i<poolSize;i++){
    const nPos = Math.random()<0.25 ? randInt(2,3) : 1; // most cards have one natural position
    const pos = sample(posAlphabet, Math.min(nPos, posAlphabet.length));
    if(!pos.length) continue;
    const hold = Math.random()<0.20 ? choice(['H1','H2','H3','H4','H5']) : null; // modest hold-sharing
    pool.push({id:i, rating: randInt(60,99), pos, hold});
  }
  return {pool, form:{slots}};
}

const TRIALS = parseInt(process.argv[2]||'300000',10);
let comparable=0, capped=0, violations=0;
let tight=0, over_0_1=0, over_1_2=0, over_2_5=0, over_5plus=0;
let sumOver=0, maxOver=0;
const worst=[];
const violationCases=[];

for(let t=0;t<TRIALS;t++){
  const {pool, form} = genRandomish();
  let ub, bestRes;
  try { ub = maxPossibleRating(pool, form); } catch(e){ continue; }
  try { bestRes = bruteForceMax(pool, form.slots); } catch(e){ continue; }
  if(bestRes.capped){ capped++; continue; }
  const best = bestRes.best;
  if(best===null) continue;
  if(ub===null) continue;
  comparable++;

  const bestFloored = Math.floor(best);
  const gap = ub - bestFloored;
  if(gap < -EPS){
    violations++;
    violationCases.push({pool,form,best,ub});
  } else if(gap <= EPS){
    tight++;
  } else {
    sumOver += gap;
    if(gap > maxOver) maxOver = gap;
    if(gap <= 1) over_0_1++;
    else if(gap <= 2) over_1_2++;
    else if(gap <= 5) over_2_5++;
    else over_5plus++;
    if(gap > 1) worst.push({gap,pool,form,best,ub});
  }
}

function pct(n,d){return d?(100*n/d).toFixed(3)+'%':'n/a';}

console.log('=== SHIPPED maxPossibleRating() (UB-A..E) vs BRUTE FORCE, RANDOMISH/REALISTIC POOLS ===');
console.log('trials:', TRIALS, '| comparable:', comparable, '| oracle capped/skipped:', capped);
console.log('VIOLATIONS (ub < true max, must be 0):', violations);
console.log('');
console.log('tight (exact):           ', tight, pct(tight,comparable));
console.log('overcount 0 < gap <= 1:  ', over_0_1, pct(over_0_1,comparable));
console.log('overcount 1 < gap <= 2:  ', over_1_2, pct(over_1_2,comparable));
console.log('overcount 2 < gap <= 5:  ', over_2_5, pct(over_2_5,comparable));
console.log('overcount gap > 5:       ', over_5plus, pct(over_5plus,comparable));
console.log('');
console.log('overcount > 1 total:     ', over_1_2+over_2_5+over_5plus, pct(over_1_2+over_2_5+over_5plus,comparable));
console.log('avg overcount (when loose):', (sumOver/(comparable-tight)).toFixed(4));
console.log('max overcount observed:    ', maxOver.toFixed(4));

if(violationCases.length){
  console.log('\n=== VIOLATIONS (should be empty!) ===');
  console.log(JSON.stringify(violationCases.slice(0,3)));
}

worst.sort((a,b)=>b.gap-a.gap);
console.log('\n=== TOP 5 WORST (gap>1) CASES ===');
for(let i=0;i<Math.min(5,worst.length);i++){
  const w=worst[i];
  console.log(`#${i+1} gap=${w.gap.toFixed(3)} best=${w.best.toFixed(3)} ub=${w.ub}`);
  console.log('  slots:', JSON.stringify(w.form.slots));
  console.log('  pool:', JSON.stringify(w.pool));
}
