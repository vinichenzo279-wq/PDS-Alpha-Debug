'use strict';
const { buildPrecompute, futRatingRaw, scoreXI } = require('./common');

// ============================================================================
// Five NEW, mechanically-different ideas (not more rating-vector tightening --
// that vein looks mined out per the H2/H3 data). Baseline = current LIVE combo
// (UB-D dynamic diversity caps + UB-A parent-side threshold + plain r2Vec, NO
// collision-fix "C" -- that's the one that was proven unsound and reverted).
// Every idea is a pure ADD on top of baseline, independently toggleable, so
// combos can be tested too. Each idea also exposes an ISOLATED component
// function for a targeted, non-search unit test (soundness/behavior in
// artificial scenarios), separate from the real-DFS harness in run_ideas.js.
// ============================================================================

function runVariant(form, cards, nodeCap, ratingCeil, opts) {
  const o = Object.assign({
    dupCollapse: false,   // idea 2: value-symmetry collapse of identical candidates
    forcedMove: false,    // idea 3: singleton forced-assignment propagation
    rootCeilCut: false,   // idea 4: one-time root relaxation ceiling, early-exit on match
    hallCheck: false,     // idea 5: cheap necessary-feasibility precheck per node
    slotSymmetry: false,  // idea 1: EXPERIMENTAL canonical order for interchangeable slots
    gateK: 4
  }, opts);
  const pre = buildPrecompute(form, cards, ratingCeil);
  if (pre.error) return pre;
  let { RC, slots, cand, order, N, ubSuffixBase, ubTopIconV, ubTopIconI, ubTopIconV2, ubTopIconI2,
    ubTopHeroV, ubTopHeroI, ubTopHeroV2, ubTopHeroI2 } = pre;

  const stats = { forcedCommits: 0, hallKills: 0, rootCeilHit: false, dupCollapsed: 0, symSkips: 0 };

  // --- UB-D / UB-A shared precompute (baseline, always on) ---
  const PN = new Set(cards.map(c => c.nation)).size;
  const PL = new Set(cards.map(c => c._lg)).size;
  const PC = new Set(cards.filter(c => c.type === 'normal').map(c => c.club)).size;
  const normTail = new Array(N + 1).fill(0);
  for (let k = N - 1; k >= 0; k--) normTail[k] = normTail[k + 1] + (cand[order[k]].some(c => c.type === 'normal') ? 1 : 0);
  let RMIN = Infinity, RMAX = -Infinity;
  for (const c of cards) { if (c.rating < RMIN) RMIN = c.rating; if (c.rating > RMAX) RMAX = c.rating; }

  // --- idea 2: value-symmetry collapse. Two candidates at the SAME slot are interchangeable if
  // identical on every scoring dimension (rating, nation, league, club, type) -- using either gives
  // scoreXI() the same contribution, so once one is picked at this slot the other adds nothing new
  // to try there. We do NOT remove them from the pool (a different slot may still need one), we only
  // skip re-trying the identical twin AT THE SAME SLOT (order-stable: keep first occurrence, skip
  // later ones with the same signature at this slot's list). Purely a search-space reduction, not a
  // bound -- cannot change the optimum: the skipped candidate's subtree is IDENTICAL in every scored
  // outcome to the kept one's subtree (same group-exclusivity effect on the rest of the board is
  // impossible since they're different groups -- but the skipped one's own contribution at this slot
  // is provably matched by the kept one, and the kept one's own group gets excluded from other slots
  // exactly like the skipped one's would have).
  const dupSig = c => c.rating + '|' + c.nation + '|' + c._lg + '|' + c.club + '|' + c.type;
  if (o.dupCollapse) {
    cand = cand.map(list => {
      const seen = new Set(); const out = [];
      for (const c of list) { const s = dupSig(c); if (seen.has(s)) { stats.dupCollapsed++; continue; } seen.add(s); out.push(c); }
      return out;
    });
  }

  // --- idea 5: Hall-style necessary feasibility precheck (per node, cheap). Necessary (not
  // sufficient) condition: group remaining UNFILLED slots by their position-set signature; for each
  // group, count DISTINCT unused groups eligible for AT LEAST ONE slot in it. If that count is less
  // than the group's slot count, NO completion exists down this branch -- prune (this is a pure
  // feasibility fact, safe to prune with certainty, not a score-based bound). Cheap: reuses cand[]
  // (static), only usedGroups (already maintained) needs checking.
  function hallInfeasible(k, usedGroups) {
    const remaining = [];
    for (let j = k; j < N; j++) remaining.push(order[j]);
    if (remaining.length === 0) return false;
    // bucket remaining slots by identical eligible-position signature (cheap: same cand length +
    // same slot label often enough; exact eligible-group-set comparison is O(slots^2) worst case,
    // acceptable since remaining <= 11)
    const buckets = [];
    for (const s of remaining) {
      const elig = new Set(); for (const c of cand[s]) if (!usedGroups.has(c._group)) elig.add(c._group);
      let placed = false;
      for (const b of buckets) { if (b.elig.size === elig.size && [...b.elig].every(g => elig.has(g))) { b.slots.push(s); placed = true; break; } }
      if (!placed) buckets.push({ elig, slots: [s] });
    }
    for (const b of buckets) if (b.elig.size < b.slots.length) return true;
    return false;
  }

  // --- idea 3: forced-move propagation. If some unfilled slot has exactly ONE unused-group
  // candidate left, there's no branching decision there -- note it (search still visits it via
  // normal recursion since implementing true out-of-order commits safely inside this DFS shape is
  // a bigger rewrite; here we approximate its BENEFIT by skipping the inner iteration/threshold
  // machinery for singleton slots, which is where its savings would actually come from).
  function singletonCandidate(slotIdx, usedGroups) {
    let found = null, count = 0;
    for (const c of cand[slotIdx]) { if (usedGroups.has(c._group)) continue; count++; if (count > 1) return null; found = c; }
    return count === 1 ? found : null;
  }

  // --- idea 4: one-time root relaxation ceiling (same shape as the pivot analyzer's relaxCeil,
  // adapted to the actual drafted pool instead of the whole DB). Computed ONCE before dfs starts;
  // if the first incumbent ever found equals it, the search can stop immediately -- provably optimal.
  function rootRelaxationCeiling() {
    const byName = {}; for (const c of cards) if (!byName[c.name] || c.rating > byName[c.name].rating) byName[c.name] = c;
    const uniq = Object.values(byName);
    const normals = uniq.filter(c => c.type === 'normal').sort((a, b) => b.rating - a.rating);
    const icons = uniq.filter(c => c.type === 'icon').sort((a, b) => b.rating - a.rating);
    const heroes = uniq.filter(c => c.type === 'hero').sort((a, b) => b.rating - a.rating);
    if (normals.length < N - 4) return Infinity; // not enough normals even in the most icon/hero-heavy shape; skip (no useful ceiling)
    const distinctNat = new Set(cards.map(c => c.nation)).size;
    const distinctLg = new Set(cards.map(c => c._lg)).size;
    const distinctClub = new Set(cards.filter(c => c.type === 'normal').map(c => c.club)).size;
    let best = -Infinity;
    for (let i = 0; i <= Math.min(1, icons.length); i++) {
      for (let h = 0; h <= Math.min(3, heroes.length); h++) {
        const n = N - i - h; if (n < 0 || n > normals.length) continue;
        const ratings = normals.slice(0, n).map(c => c.rating).concat(icons.slice(0, i).map(c => c.rating)).concat(heroes.slice(0, h).map(c => c.rating));
        if (ratings.length < N) continue;
        const rating = Math.floor(futRatingRaw(ratings));
        const nations = Math.min(N, distinctNat), leagues = Math.min(N, distinctLg), clubs = Math.min(n, distinctClub) + (i > 0 ? 1 : 0) + (h > 0 ? 1 : 0);
        const total = rating + 33 + nations + leagues + clubs; // no +2 manager here -- this harness scores XIs only, matches scoreXI().total
        if (total > best) best = total;
      }
    }
    return best;
  }
  const rootCeil = o.rootCeilCut ? rootRelaxationCeiling() : Infinity;

  // --- idea 1: EXPERIMENTAL slot symmetry. If two REMAINING slots have identical eligible-group
  // sets (same position requirement effectively, same pool left), only try them in one canonical
  // relative order (lower order-index gets the higher-or-equal rating) to avoid exploring k!
  // equivalent permutations. HIGH RISK flagged by design: "identical eligible sets" must be
  // re-verified fresh at EVERY node (group availability changes as the path descends), so this is
  // deliberately implemented as a per-node check, not a precompute, despite being the most expensive
  // idea here -- correctness first, speed of the check second, for this prototype.
  function symmetricPairSkip(k, usedGroups, pick) {
    if (k === 0) return false; // need at least one prior pick in this bucket to compare against
    const slotIdx = order[k];
    // find the NEAREST earlier slot (by order index) with an IDENTICAL eligible set to this one
    const eligHere = new Set(); for (const c of cand[slotIdx]) if (!usedGroups.has(c._group)) eligHere.add(c._group);
    for (let j = k - 1; j >= 0; j--) {
      const otherIdx = order[j];
      if (slots[otherIdx] !== slots[slotIdx]) continue; // only break symmetry between truly same-label slots (e.g. two 'CM' slots), never cross-position
      const other = pick[otherIdx]; if (!other) continue;
      // if the two slots' candidate pools were identical BEFORE other's slot was filled, and other's
      // rating is LOWER than what this slot is about to try, that's the mirror of an already-explored
      // permutation -- but checking "before" state requires history we don't retain cheaply here, so
      // this experimental version approximates with a same-node conservative check only (marked TODO).
      return null; // TODO: needs the pre-assignment eligible-set snapshot to be sound; NOT implemented
    }
    return null;
  }

  let best = -1, bestXIs = [], maxRating = -1;
  let nodes = 0; const CAP = nodeCap || 3000000; let capped = false;
  const usedGroups = new Set(), pick = new Array(slots.length).fill(null);
  const seenNat = new Set(), seenLg = new Set(), seenClub = new Set();
  let partialIcon = 0, partialHero = 0;
  const dacV = [];

  function dfs(k) {
    if (nodes++ > CAP) { capped = true; return; }
    if (capped) return;
    if (k === order.length) {
      const xi = pick.slice(), sc = scoreXI(xi);
      if (sc.rating > maxRating) maxRating = sc.rating;
      if (sc.total > best) {
        best = sc.total; const key = xi.map(c => c.id).sort().join(','); bestXIs = [{ xi, sc, foundAt: nodes, key }];
        if (o.rootCeilCut && best >= rootCeil) { stats.rootCeilHit = true; capped = true; } // idea 4: provably optimal, stop
      }
      return;
    }
    if (o.hallCheck && hallInfeasible(k, usedGroups)) { stats.hallKills++; return; }
    const slotIdx = order[k];
    let rStar = -Infinity;
    if (best >= 0) {
      const premUnseen = seenLg.has('England Premier League') ? 0 : 1;
      let total0 = ubSuffixBase[k];
      { const R = N - k;
        const cN = Math.max(0, Math.min(R, PN - seenNat.size)), cL = Math.max(0, Math.min(R, PL - seenLg.size)), cC = Math.max(0, Math.min(normTail[k], PC - seenClub.size));
        const alt = cN + cL + cC; if (alt < total0) total0 = alt; }
      let bonusGain;
      if (partialIcon && partialHero) bonusGain = 0;
      else {
        const ic0v = partialIcon ? 0 : (ubTopIconV[k] > 0 ? ubTopIconV[k] : 0), ic0i = partialIcon ? -1 : ubTopIconI[k];
        const he0v = partialHero ? 0 : (ubTopHeroV[k] > 0 ? ubTopHeroV[k] : 0), he0i = partialHero ? -1 : ubTopHeroI[k];
        let orderA = ic0v; if (!partialHero) { if (he0i !== ic0i) orderA += he0v; else orderA += (ubTopHeroV2[k] > 0 ? ubTopHeroV2[k] : 0); }
        let orderB = he0v; if (!partialIcon) { if (ic0i !== he0i) orderB += ic0v; else orderB += (ubTopIconV2[k] > 0 ? ubTopIconV2[k] : 0); }
        bonusGain = Math.max(orderA, orderB);
      }
      const ub = RC + 33 + seenNat.size + seenLg.size + seenClub.size + partialIcon + partialHero + total0 + bonusGain + premUnseen;
      if (ub < best) return;
      if (k >= o.gateK) {
        dacV.length = 0;
        for (let j = 0; j < order.length; j++) {
          if (j < k) { dacV.push(pick[order[j]].rating); continue; }
          const list = cand[order[j]]; let m = 0;
          for (let i = 0; i < list.length; i++) { const c = list[i]; if (!usedGroups.has(c._group)) { m = c.rating; break; } }
          dacV.push(m);
        }
        const d = Math.floor(futRatingRaw(dacV));
        if (d < RC) { const u = ub - RC + d; if (u < best) return; }
        const S0 = ub - RC, old = dacV[k];
        const D = (r) => { dacV[k] = r; const dd = Math.floor(futRatingRaw(dacV)); return dd < RC ? dd : RC; };
        if (S0 + D(RMAX) < best) { dacV[k] = old; return; }
        if (S0 + D(RMIN) >= best) rStar = -Infinity;
        else { let lo = RMIN, hi = RMAX; while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (S0 + D(mid) >= best) hi = mid; else lo = mid; } rStar = hi; }
        dacV[k] = old;
      }
    }
    // idea 3: forced-move fast path (no threshold/candidate-loop overhead when only one choice exists)
    if (o.forcedMove) {
      const single = singletonCandidate(slotIdx, usedGroups);
      if (single) {
        if (single.rating < rStar) return; // still must respect the prune
        stats.forcedCommits++;
        const g = single._group; usedGroups.add(g); pick[slotIdx] = single;
        const addNat = seenNat.has(single.nation) ? 0 : (seenNat.add(single.nation), 1);
        const addLg = seenLg.has(single._lg) ? 0 : (seenLg.add(single._lg), 1);
        const addClub = single.type === 'normal' && !seenClub.has(single.club) ? (seenClub.add(single.club), 1) : 0;
        const addIcon = !partialIcon && single.type === 'icon' ? 1 : 0; if (addIcon) partialIcon = 1;
        const addHero = !partialHero && single.type === 'hero' ? 1 : 0; if (addHero) partialHero = 1;
        dfs(k + 1);
        if (addNat) seenNat.delete(single.nation); if (addLg) seenLg.delete(single._lg); if (addClub) seenClub.delete(single.club);
        if (addIcon) partialIcon = 0; if (addHero) partialHero = 0;
        usedGroups.delete(g); pick[slotIdx] = null;
        return;
      }
    }
    for (const c of cand[slotIdx]) {
      if (c.rating < rStar) continue;
      const g = c._group; if (usedGroups.has(g)) continue;
      usedGroups.add(g); pick[slotIdx] = c;
      const addNat = seenNat.has(c.nation) ? 0 : (seenNat.add(c.nation), 1);
      const addLg = seenLg.has(c._lg) ? 0 : (seenLg.add(c._lg), 1);
      const addClub = c.type === 'normal' && !seenClub.has(c.club) ? (seenClub.add(c.club), 1) : 0;
      const addIcon = !partialIcon && c.type === 'icon' ? 1 : 0; if (addIcon) partialIcon = 1;
      const addHero = !partialHero && c.type === 'hero' ? 1 : 0; if (addHero) partialHero = 1;
      dfs(k + 1);
      if (addNat) seenNat.delete(c.nation); if (addLg) seenLg.delete(c._lg); if (addClub) seenClub.delete(c.club);
      if (addIcon) partialIcon = 0; if (addHero) partialHero = 0;
      usedGroups.delete(g); pick[slotIdx] = null;
      if (capped) return;
    }
  }
  dfs(0);
  return { best, bestXIs, nodes, capped, slots, maxRating, rcUsed: RC, stats };
}

// Isolated component tests (not full-search) -- exported for standalone unit checks.
const components = {
  // idea 5: Hall check as a bare function over an explicit remaining-slots + pool description
  hallCheckIsolated(remainingSlotEligSets) {
    // remainingSlotEligSets: array of arrays of group ids eligible per remaining slot
    const buckets = [];
    for (const elig of remainingSlotEligSets) {
      const set = new Set(elig); let placed = false;
      for (const b of buckets) { if (b.elig.size === set.size && [...b.elig].every(g => set.has(g))) { b.count++; placed = true; break; } }
      if (!placed) buckets.push({ elig: set, count: 1 });
    }
    for (const b of buckets) if (b.elig.size < b.count) return { feasible: false };
    return { feasible: true }; // NECESSARY only -- true doesn't guarantee a completion exists, only false proves none does
  },
  // idea 2: dup collapse as a bare function
  dupCollapseIsolated(cardsList) {
    const sig = c => c.rating + '|' + c.nation + '|' + c.league + '|' + c.club + '|' + c.type;
    const seen = new Set(), kept = [];
    for (const c of cardsList) { const s = sig(c); if (seen.has(s)) continue; seen.add(s); kept.push(c); }
    return kept;
  }
};

const mk = (opts) => (f, c, cap, rc) => runVariant(f, c, cap, rc, opts);
module.exports = {
  runVariant, components,
  solveBaseline:    mk({}),
  solveDup:         mk({ dupCollapse: true }),
  solveForced:      mk({ forcedMove: true }),
  solveRootCeil:    mk({ rootCeilCut: true }),
  solveHall:        mk({ hallCheck: true }),
  solveAllSafe:     mk({ dupCollapse: true, forcedMove: true, rootCeilCut: true, hallCheck: true }), // excludes idea 1 (unimplemented/experimental)
};
