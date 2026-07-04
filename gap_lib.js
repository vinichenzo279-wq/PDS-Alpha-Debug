'use strict';
function futRatingRaw(rs){const S=rs.reduce((a,b)=>a+b,0),A=S/rs.length;let sp=0;for(const r of rs)if(r>A)sp+=r-A;return (S+sp)/rs.length;}

// Brute-force oracle: true max achievable futRatingRaw over all legal assignments of
// distinct hold-groups to formation slots (one card per slot, card must be eligible for
// that slot's position, at most one card per hold-group used across the whole XI).
function bruteForceMax(pool, slots){
  const N = slots.length;
  const groupOf = c => c.hold || ('C'+c.id);
  const cands = slots.map(s => pool.filter(c=>c.pos && c.pos.includes(s)));
  // quick infeasibility check
  for(const c of cands) if(c.length===0) return {best:null, capped:false};

  let bestVal = null;
  let nodes = 0;
  const NODE_CAP = 150000;
  let capped = false;
  const usedGroups = new Set();
  const chosenRatings = new Array(N);

  // order slots by fewest candidates first (better pruning)
  const order = cands.map((c,i)=>i).sort((a,b)=>cands[a].length-cands[b].length);

  function backtrack(k){
    if (capped) return;
    nodes++;
    if (nodes > NODE_CAP){ capped = true; return; }
    if (k === N){
      const val = futRatingRaw(chosenRatings.slice());
      if (bestVal === null || val > bestVal) bestVal = val;
      return;
    }
    const slotIdx = order[k];
    for (const c of cands[slotIdx]){
      const g = groupOf(c);
      if (usedGroups.has(g)) continue;
      usedGroups.add(g);
      chosenRatings[slotIdx] = c.rating;
      backtrack(k+1);
      usedGroups.delete(g);
    }
  }
  backtrack(0);
  return {best: bestVal, capped};
}

module.exports = {futRatingRaw, bruteForceMax};
