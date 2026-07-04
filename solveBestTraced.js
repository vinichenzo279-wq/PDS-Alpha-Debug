function solveBestTraced(form,cards,nodeCap,ratingCeil,seedBest,seedXIs,trace){
  const RC=ratingCeil!==undefined?ratingCeil:99;
  const slots=form.slots;
  const cand=slots.map(s=>cards.filter(c=>c.pos.includes(s))
    .sort((a,b)=>b.rating-a.rating)); // v5.1: best-first — high-rated candidates tried first so the first complete path is near-optimal, making pruning bite much earlier on capped searches
  if(cand.some(l=>l.length===0))
    return {error:'A slot has no eligible card: '+slots.filter((s,i)=>cand[i].length===0).join(', ')};
  // v5.5 #2: cache _lg (leagueOf) and _group on every candidate once instead of recomputing in the hot loop
  for(const slot of cand)for(const c of slot){
    if(c._lg===undefined)c._lg=leagueOf(c);
    if(c._group===undefined)c._group=c.hold||('C'+c.id);
  }
  const order=slots.map((s,i)=>i).sort((a,b)=>cand[a].length-cand[b].length);
  // v6 UB precompute — per remaining slot, the OLD bound assumed a flat "+2" for anything
  // that wasn't the one reserved "first icon"/"first hero" slot. That's safe (never an
  // underestimate) but loose whenever a slot's candidate pool is icon-only or hero-only —
  // e.g. a position where a user has stacked several icons and has no normal/hero card that
  // fits there. A 2nd+ icon can only ever add +1 (nation; "Icons" league + the icon club-
  // bonus are awarded once, to whichever icon comes first), so an icon-only slot's true max
  // is +1, not +2. This is computed ONCE per solveBest() call (static — resorting cand[] for
  // traversal order doesn't change which TYPES are present) as suffix aggregates, so the
  // per-node bound check below stays O(1), same as before.
  const slotTypes=cand.map(list=>{const s=new Set();for(const c of list)s.add(c.type);return s;});
  const N=slots.length;
  const ubBaseline=new Array(N),ubSuffixBase=new Array(N+1).fill(0);
  const ubTopIconV=new Array(N+1),ubTopIconI=new Array(N+1),ubTopIconV2=new Array(N+1),ubTopIconI2=new Array(N+1);
  const ubTopHeroV=new Array(N+1),ubTopHeroI=new Array(N+1),ubTopHeroV2=new Array(N+1),ubTopHeroI2=new Array(N+1);
  ubTopIconV[N]=-Infinity;ubTopIconI[N]=-1;ubTopIconV2[N]=-Infinity;ubTopIconI2[N]=-1;
  ubTopHeroV[N]=-Infinity;ubTopHeroI[N]=-1;ubTopHeroV2[N]=-Infinity;ubTopHeroI2[N]=-1;
  for(let k=N-1;k>=0;k--){
    const st=slotTypes[order[k]];
    let b=-Infinity;
    if(st.has('normal'))b=2;
    if(st.has('hero')&&b<2)b=2;
    if(st.has('icon')&&b<1)b=1;
    ubBaseline[k]=b;ubSuffixBase[k]=ubSuffixBase[k+1]+b;
    let iv=ubTopIconV[k+1],ii=ubTopIconI[k+1],iv2=ubTopIconV2[k+1],ii2=ubTopIconI2[k+1];
    if(st.has('icon')){const g=3-b;if(g>iv){iv2=iv;ii2=ii;iv=g;ii=k;}else if(g>iv2){iv2=g;ii2=k;}}
    ubTopIconV[k]=iv;ubTopIconI[k]=ii;ubTopIconV2[k]=iv2;ubTopIconI2[k]=ii2;
    let hv=ubTopHeroV[k+1],hi=ubTopHeroI[k+1],hv2=ubTopHeroV2[k+1],hi2=ubTopHeroI2[k+1];
    if(st.has('hero')){const g=3-b;if(g>hv){hv2=hv;hi2=hi;hv=g;hi=k;}else if(g>hv2){hv2=g;hi2=k;}}
    ubTopHeroV[k]=hv;ubTopHeroI[k]=hi;ubTopHeroV2[k]=hv2;ubTopHeroI2[k]=hi2;
  }
  let best=(typeof seedBest==="number"&&seedBest>=0)?seedBest:-1;
  let bestXIs=(best>=0&&seedXIs&&seedXIs.length)?seedXIs.map(x=>({xi:x.xi,sc:x.sc,foundAt:0,seed:true})):[];
  // Highest TRUE squad rating (floor(ratingExact), the same integer that enters sc.total) seen across
  // every complete XI scored. RC only ever enters the search as the rating ceiling in the pruning UB
  // (ub = RC+33+chem/diversity); the score itself never clamps rating. So comparing this max to RC
  // tells the user whether RC was actually binding: max<RC means RC never touched a real squad (sound,
  // and RC could be lowered to save time); max===RC is the boundary (a higher-rated squad, if one
  // exists, would rate >RC and could have been pruned before we ever scored it); max>RC means the UB
  // underestimated at least one branch's rating, so better squads were likely pruned. One integer
  // compare per leaf — sc.rating is already computed for the score, so this adds no measurable cost.
  let maxRating=-1;
  if(bestXIs.length)for(const b of bestXIs){const rr=b.sc&&b.sc.rating;if(typeof rr==='number'&&rr>maxRating)maxRating=rr;}
  let nodes=0;const CAP=nodeCap||3000000;let capped=false;
  const usedGroups=new Set(),pick=new Array(slots.length).fill(null);
  // v5.5 #1: incremental diversity state — add on descent, delete on backtrack; eliminates
  // ~9M Set allocations at the 3M-node cap that the old per-node filter/map/Set pattern caused.
  const seenNat=new Set(),seenLg=new Set(),seenClub=new Set();
  let partialIcon=0,partialHero=0;
  function dfs(k){
    if(nodes++>CAP){capped=true;return;}
    if(capped)return;
    if(k===order.length){
      const xi=pick.slice(),sc=scoreXI(xi);
      if(sc.rating>maxRating)maxRating=sc.rating;   // cheap: sc.rating already computed for the score
      if(sc.total>best){best=sc.total;const key=xi.map(c=>c.id).sort().join(',');bestXIs=[{xi,sc,foundAt:nodes,key}];trace.push({nodes:nodes,score:sc.total});}
      else if(sc.total===best){
        const key=xi.map(c=>c.id).sort().join(',');
        if(!bestXIs.some(b=>(b.key||(b.key=b.xi.map(c=>c.id).sort().join(',')))===key))bestXIs.push({xi,sc,foundAt:nodes,key});
      }
      return;
    }
    const slotIdx=order[k];
    // v6 tighter UB — per remaining slot, use its ACTUAL candidate-type composition
    // (ubBaseline/ubSuffixBase, precomputed once above) instead of assuming every slot
    // can flex to +2. Baseline per slot (no "first icon/hero" bonus yet): normal=2
    // (nation+club), hero=2 (nation+own league), icon=1 (nation only — "Icons" league
    // and the icon club-bonus are only ever awarded once, to the first icon overall).
    // On top of the suffix's total baseline we optimally award the at-most-one remaining
    // "first icon" bonus (+2 over that slot's baseline) and at-most-one "first hero" bonus
    // (+1 over baseline) to whichever eligible slots gain the most — trying both assignment
    // orders (icon picks first vs hero picks first) since a slot able to take either bonus
    // can only be awarded one of them. Falls back to the old flat "+2 everywhere" bound
    // whenever every remaining slot also has a normal/hero option (the common case), so this
    // only bites — and only helps — when a position pool has gone icon/hero-only.
    // Verified against 20k+ randomized states + brute force: never below the true max,
    // and strictly tighter than the old bound in ~45% of those states.
    if(best>=0){
      const premUnseen=seenLg.has('England Premier League')?0:1;
      const total0=ubSuffixBase[k];
      let bonusGain;
      if(partialIcon&&partialHero){
        bonusGain=0;
      }else{
        const ic0v=partialIcon?0:(ubTopIconV[k]>0?ubTopIconV[k]:0),ic0i=partialIcon?-1:ubTopIconI[k];
        const he0v=partialHero?0:(ubTopHeroV[k]>0?ubTopHeroV[k]:0),he0i=partialHero?-1:ubTopHeroI[k];
        let orderA=ic0v; // icon takes its best slot first
        if(!partialHero){
          if(he0i!==ic0i)orderA+=he0v;
          else orderA+=(ubTopHeroV2[k]>0?ubTopHeroV2[k]:0);
        }
        let orderB=he0v; // hero takes its best slot first
        if(!partialIcon){
          if(ic0i!==he0i)orderB+=ic0v;
          else orderB+=(ubTopIconV2[k]>0?ubTopIconV2[k]:0);
        }
        bonusGain=Math.max(orderA,orderB);
      }
      const ub=RC+33
        +seenNat.size+seenLg.size+seenClub.size+partialIcon+partialHero
        +total0+bonusGain+premUnseen;
      if(ub<best)return;
    }
    // v5.6 dynamic in-flight presort — reorders cand[slotIdx] using the *live* path state
    // (seenNat/seenLg/seenClub/partialIcon/partialHero) instead of the static rating-only
    // order computed once before the search began. A card's true value along THIS path is
    // rating + whatever NEW nation/league/club it would add right now; that marginal value
    // shifts every time a different sibling is picked higher up the tree, so resorting per
    // node keeps best-first traversal accurate as the search descends, not just at depth 0.
    // This is ordering only — every candidate already in cand[slotIdx] is still iterated and
    // the usedGroups skip + UB bound above are untouched, so no node is pruned that the static
    // order would have visited; we only change WHEN each sibling is tried, which lets `best`
    // converge faster and makes the existing UB cutoff bite earlier on capped searches.
    // Safe to sort in place: `order` is a fixed permutation computed once, so each depth k
    // owns exactly one slotIdx for the whole search — no other stack frame is ever mid-loop
    // over this same array, so resorting it here can't disturb a parent's in-progress iteration.
    // [v8.2 REMOVED: the v5.6 dynamic in-flight presort that lived here — a full comparator sort
    // (~10 Set.has per comparison) at EVERY node with >1 candidate. Measured head-to-head: optimum
    // identical on every fixture at every RC, capped-incumbent quality identical at 500k/3M caps on
    // the two hardest drafts, fingerprint 357,777 untouched — and removing it is 10-16% faster
    // wall-time across the board (nodes +1.8% on one fixture, each node far cheaper). The static
    // rating-order computed once before the search already finds the incumbent just as fast; the
    // endgame is bound-proving, which ordering cannot help. Same lesson as scarcity ordering and
    // the suffix resource caps: per-node cleverness must be measured, and it keeps losing.]
    for(const c of cand[slotIdx]){
      const g=c._group;
      if(usedGroups.has(g))continue;
      usedGroups.add(g);pick[slotIdx]=c;
      // Incremental updates (O(1) each)
      const addNat=seenNat.has(c.nation)?0:(seenNat.add(c.nation),1);
      const addLg =seenLg.has(c._lg)   ?0:(seenLg.add(c._lg),1);
      const addClub=c.type==='normal'&&!seenClub.has(c.club)?(seenClub.add(c.club),1):0;
      const addIcon=!partialIcon&&c.type==='icon'?1:0;if(addIcon)partialIcon=1;
      const addHero=!partialHero&&c.type==='hero'?1:0;if(addHero)partialHero=1;
      dfs(k+1);
      // Backtrack (O(1) each)
      if(addNat) seenNat.delete(c.nation);
      if(addLg)  seenLg.delete(c._lg);
      if(addClub)seenClub.delete(c.club);
      if(addIcon)partialIcon=0;
      if(addHero)partialHero=0;
      usedGroups.delete(g);pick[slotIdx]=null;
      if(capped)return;
    }
  }
  dfs(0);
  return {best,bestXIs,nodes,capped,slots,maxRating,rcUsed:RC};
}
