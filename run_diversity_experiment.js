'use strict';
// node run_diversity_experiment.js <outPath> <cap> <seedStart> <needHard>
// All strategies get the IDENTICAL total node budget (cap). Differences are purely in how the
// budget is spent:
//   pure_div   : divstatic for the whole budget (the shipped v11 behavior)
//   hyb50      : divstatic 50%, then ONE fresh pseudo-random traversal (seeded with the phase-1
//                incumbent, so its pruning starts hot) for the remaining 50%
//   hyb75      : divstatic 75% + pseudo-random 25%
//   multi4     : divstatic 50% + FOUR different pseudo-random traversals x 12.5% each, each
//                seeded with the best incumbent found so far (portfolio-of-shuffles)
//   pure_rand  : one pseudo-random traversal for the whole budget (control / lower bound)
// A strategy "uses diversity well" if it ever strictly beats pure_div at the same budget, and
// doesn't systematically lose (i.e. the nodes stolen from divstatic cost less than the random
// phases gain).
const fs = require('fs');
const { generateRealisticDraft, estimateCombos, mulberry32 } = require('./gendraft_realistic.js');
const { maxPossibleRating } = require('./engine.js');
const { buildResumableSolver } = require('./resumable_solver.js');

const outPath = process.argv[2];
const CAP = parseInt(process.argv[3] || '1000000', 10);
let seedCtr = parseInt(process.argv[4] || '700000', 10);
const NEED = parseInt(process.argv[5] || '10', 10);

const divstaticSort = (list)=>{
  const natCount={}, clubCount={};
  for(const c of list){
    natCount[c.nation]=(natCount[c.nation]||0)+1;
    if(c.type==='normal') clubCount[c.club]=(clubCount[c.club]||0)+1;
  }
  return list.map(c=>{
    const natRarity = 1/(natCount[c.nation]||1);
    const clubRarity = c.type==='normal' ? 1/(clubCount[c.club]||1) : 0;
    return {c, score: c.rating + 0.4*natRarity + 0.4*clubRarity};
  }).sort((a,b)=>b.score-a.score).map(x=>x.c);
};
function shuffleSort(seed){
  const rand = mulberry32(seed);
  return (list)=>{
    const a = list.slice();
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(rand()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  };
}

function runStrategy(d, rc, plan){
  // plan: array of {sort, frac} summing to 1. Each phase is a FRESH traversal seeded with the
  // best incumbent from all prior phases. If any phase finishes its whole tree (done), stop early
  // (the result is proven optimal; remaining budget is irrelevant).
  let best=-1, bestXIs=[], maxRating=-1, spent=0, provenDone=false;
  for(const ph of plan){
    const budget = Math.max(1, Math.round(CAP*ph.frac));
    const solve = buildResumableSolver({presortFn: ph.sort});
    const seedCp = { path: [], best, bestXIs, nodes: 0, maxRating };
    const r = solve(d.subForm, d.cards, rc, budget, seedCp, budget);
    if(r.error) return {error:r.error};
    spent += r.nodes;
    if(r.best>best){ best=r.best; bestXIs=r.bestXIs; }
    if(r.maxRating>maxRating) maxRating=r.maxRating;
    if(r.done){ provenDone=true; break; }
  }
  return {best, spent, provenDone};
}

fs.appendFileSync(outPath, ''); // ensure exists (append across invocations)
let collected=0, attempts=0;
while(collected<NEED && attempts<NEED*60){
  attempts++;
  const seed = seedCtr++;
  const d = generateRealisticDraft({seed, minBust:0, maxBust:6, holdSizeDist:[1,1,1,1,2,2,2,3,3,4,5]});
  const est = estimateCombos(d.subForm, d.cards);
  if(est===0 || est < CAP*3) continue; // only hard drafts where the cap binds
  let rc; try{ rc=maxPossibleRating(d.cards,d.subForm);}catch(e){rc=96;} if(rc===null)rc=96;

  const S = seed*2654435761;
  const plans = {
    pure_div:  [{sort:divstaticSort, frac:1}],
    hyb50:     [{sort:divstaticSort, frac:.5},{sort:shuffleSort(S), frac:.5}],
    hyb75:     [{sort:divstaticSort, frac:.75},{sort:shuffleSort(S), frac:.25}],
    multi4:    [{sort:divstaticSort, frac:.5},{sort:shuffleSort(S), frac:.125},{sort:shuffleSort(S+1), frac:.125},{sort:shuffleSort(S+2), frac:.125},{sort:shuffleSort(S+3), frac:.125}],
    pure_rand: [{sort:shuffleSort(S), frac:1}],
  };
  const row = {seed, formName:d.formName, est, rc, cap:CAP, strategies:{}};
  let bad=false;
  for(const [name, plan] of Object.entries(plans)){
    const r = runStrategy(d, rc, plan);
    if(r.error){ bad=true; break; }
    row.strategies[name] = r;
  }
  if(bad) continue;
  fs.appendFileSync(outPath, JSON.stringify(row)+'\n');
  collected++;
}
console.log(`collected=${collected} attempts=${attempts} nextSeed=${seedCtr}`);
