'use strict';
const { scoreXI } = require('./scoring');
const { bruteForce, estimateCombos } = require('./brute');
const { genSynthetic, mulberry32, REGIMES } = require('./fuzzgen');
const I = require('./solvers_ideas');

const COMBO_SKIP = 1500000, BRUTE_MS = 1200, CAP = 50000000;
const VARIANTS = [
  ['baseline (D+A live)', (f, c, rc) => I.solveBaseline(f, c, CAP, rc)],
  ['idea2 dupCollapse',   (f, c, rc) => I.solveDup(f, c, CAP, rc)],
  ['idea3 forcedMove',    (f, c, rc) => I.solveForced(f, c, CAP, rc)],
  ['idea4 rootCeilCut',   (f, c, rc) => I.solveRootCeil(f, c, CAP, rc)],
  ['idea5 hallCheck',     (f, c, rc) => I.solveHall(f, c, CAP, rc)],
  ['ALL (2+3+4+5)',       (f, c, rc) => I.solveAllSafe(f, c, CAP, rc)],
];

// ---- isolated component tests (fast, no search) ----
function componentTests() {
  console.log('=== ISOLATED COMPONENT TESTS ===');
  // idea 5: Hall check -- hand-built feasible/infeasible cases
  const h1 = I.components.hallCheckIsolated([['A', 'B'], ['A', 'B'], ['A', 'B']]); // 3 slots share only {A,B} -> infeasible
  const h2 = I.components.hallCheckIsolated([['A', 'B'], ['A', 'C'], ['B', 'C']]); // 3 slots, pairwise overlap, 3 groups total -> feasible (necessary check passes)
  console.log('idea5 Hall: 3-slots-share-2-groups infeasible?', h1.feasible === false, '| 3-slots-3-groups feasible-check passes?', h2.feasible === true);
  // idea 2: dup collapse -- exact duplicates collapse, near-duplicates (1 differing field) don't
  const cards = [
    { id: 1, rating: 90, nation: 'England', league: 'PL', club: 'A', type: 'normal' },
    { id: 2, rating: 90, nation: 'England', league: 'PL', club: 'A', type: 'normal' }, // exact dup of #1 -> collapses
    { id: 3, rating: 90, nation: 'England', league: 'PL', club: 'B', type: 'normal' }, // differs by club -> kept
  ];
  const kept = I.components.dupCollapseIsolated(cards);
  console.log('idea2 dupCollapse: 3 cards -> kept', kept.length, '(want 2: exact dup removed, near-dup kept)');
  console.log();
}

function stressify(draft, seed, regime) {
  const rng = mulberry32(seed * 7919 + 13);
  if (regime === 'holds') {
    for (const c of draft.cards) c.hold = null;
    const loose = draft.cards.slice(); let hid = 1;
    while (loose.length >= 2 && rng() < 0.9) {
      const size = Math.min(2 + Math.floor(rng() * 3), loose.length);
      const gid = 'G' + (hid++);
      for (let i = 0; i < size; i++) { const j = Math.floor(rng() * loose.length); loose[j].hold = gid; loose.splice(j, 1); }
    }
  } else {
    const posList = [...new Set(draft.cards.map(c => c.pos[0]).concat(draft.form.slots))];
    for (const c of draft.cards) {
      if (rng() < 0.85) {
        const e = posList[Math.floor(rng() * posList.length)]; if (!c.pos.includes(e)) c.pos.push(e);
        if (rng() < 0.5) { const e2 = posList[Math.floor(rng() * posList.length)]; if (!c.pos.includes(e2)) c.pos.push(e2); }
      }
    }
  }
  for (const c of draft.cards) { c._lg = undefined; c._group = undefined; }
}

function dupHeavify(draft, rng) {
  // idea2's payoff scales with duplicate density -- occasionally clone a card's scoring-relevant
  // fields onto another (different id/group, identical signature) so dupCollapse has something to do
  if (rng() < 0.4) {
    const a = draft.cards[Math.floor(rng() * draft.cards.length)];
    const b = draft.cards[Math.floor(rng() * draft.cards.length)];
    if (a !== b) { b.rating = a.rating; b.nation = a.nation; b.league = a.league; b.club = a.club; b.type = a.type; }
  }
}

function tightRCof(brute) {
  const rt = brute.bestXI.map(c => c.rating);
  const S = rt.reduce((a, b) => a + b, 0), A = S / rt.length; let sp = 0;
  for (const r of rt) if (r > A) sp += r - A;
  return Math.floor((S + sp) / rt.length);
}

function collect(mode) {
  const out = []; let seed = mode === 'stress' ? 100000 : (mode === 'tight' ? 200000 : 1);
  const regimes = mode === 'stress' ? ['holds', 'multiPos'] : REGIMES;
  const per = mode === 'stress' ? 60 : 30;
  const rng = mulberry32(seed + 999);
  for (const regime of regimes) {
    for (let i = 0; i < per; i++) {
      seed++;
      const draft = genSynthetic(seed, regime);
      if (mode === 'stress') stressify(draft, seed, regime);
      dupHeavify(draft, rng);
      const combos = estimateCombos(draft.form, draft.cards);
      if (combos === 0 || combos > COMBO_SKIP) continue;
      const brute = bruteForce(draft.form, draft.cards, scoreXI, { timeBudgetMs: BRUTE_MS });
      if (!brute.complete || !brute.bestXI) continue;
      const rc = mode === 'tight' ? tightRCof(brute) : 103;
      out.push({ form: draft.form, cards: draft.cards, rc, bruteBest: brute.best });
    }
  }
  return out;
}

function runSuite(name, drafts) {
  const agg = {}; for (const [n] of VARIANTS) agg[n] = { nodes: 0, ns: 0n, mm: 0, better: 0, worse: 0, rootHits: 0, forced: 0, hallKills: 0, dupCol: 0 };
  let base = 0, tested = 0;
  for (const { form, cards, rc, bruteBest } of drafts) {
    tested++;
    let baseNodes = null;
    for (const [n, fn] of VARIANTS) {
      const cc = cards.map(c => Object.assign({}, c, { pos: c.pos.slice() }));
      for (const c of cc) { c._lg = undefined; c._group = undefined; }
      const t0 = process.hrtime.bigint();
      const r = fn(form, cc, rc);
      const t1 = process.hrtime.bigint();
      agg[n].ns += t1 - t0;
      if (r.best !== bruteBest) { agg[n].mm++; continue; }
      agg[n].nodes += r.nodes;
      if (n === 'baseline (D+A live)') { baseNodes = r.nodes; base += r.nodes; }
      else if (baseNodes !== null) { if (r.nodes < baseNodes) agg[n].better++; else if (r.nodes > baseNodes) agg[n].worse++; }
      if (r.stats) {
        if (r.stats.rootCeilHit) agg[n].rootHits++;
        agg[n].forced += r.stats.forcedCommits || 0;
        agg[n].hallKills += r.stats.hallKills || 0;
        agg[n].dupCol += r.stats.dupCollapsed || 0;
      }
    }
  }
  console.log(`\n=== ${name} (${tested} drafts) ===`);
  const baseNs = agg['baseline (D+A live)'].ns;
  for (const [n] of VARIANTS) {
    const a = agg[n];
    const extra = [];
    if (a.rootHits) extra.push(`rootCeilHits=${a.rootHits}`);
    if (a.forced) extra.push(`forcedCommits=${a.forced}`);
    if (a.hallKills) extra.push(`hallKills=${a.hallKills}`);
    if (a.dupCol) extra.push(`dupCollapsed=${a.dupCol}`);
    console.log(`${n.padEnd(22)} nodes ${(a.nodes / base * 100).toFixed(3)}%  time ${(Number(a.ns) / Number(baseNs) * 100).toFixed(1)}%  mm=${a.mm} better=${a.better} worse=${a.worse}` + (extra.length ? `  [${extra.join(' ')}]` : ''));
  }
}

componentTests();
for (const mode of [process.argv[2] || 'fuzz']) {
  runSuite(mode === 'fuzz' ? 'LOOSE RC=103' : (mode === 'stress' ? 'STRESS holds+multiPos RC=103' : 'TIGHT (auto) RC'), collect(mode));
}
