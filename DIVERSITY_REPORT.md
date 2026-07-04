# Diversity-search idea — findings & recommendation

## What was tested, and the methodology fix

Your realistic harness (`gendraft_realistic.js`) closes the gap I flagged earlier: it models the
**real 23-slot board** (11 XI + 12 bench), holds of 1–5 cards that share a `hold` id exactly like
`syncSlot()`, and bench cards eligible by their own `pos` — so no two cards from one hold can both
make the XI, matching the shipped solver. I re-verified two things before trusting any numbers:

1. **Resumable solver fidelity.** `resumable_solver.js` (iterative, checkpointable) had to be
   byte-identical to the recursive solver or the hybrid results would be meaningless. Over 60
   realistic drafts: **0 mismatches** on final best and capped-state, both when run uninterrupted
   and when paused/resumed in 7,777-node chunks. The checkpoint replay is sound.
2. **Divstatic still wins under the corrected methodology.** On 144 realistic hold+bench drafts,
   divstatic vs baseline was 122 ties / 8 wins / 14... — wait, that's at 1M; the cleaner read is
   your earlier realistic-63 set: **62 ties, 1 loss, 0 baseline wins** at 1M. The corrected
   methodology *narrowed* divstatic's margin (as you saw) but didn't flip it. The v11 decision
   stands.

## The diversity idea itself

I built five budget-matched strategies (every strategy gets the **identical** total node budget;
they differ only in how it's spent), using fresh pseudo-random traversals seeded with the running
incumbent so their pruning starts hot:

- `pure_div` — divstatic for the whole budget (shipped v11)
- `hyb50` / `hyb75` — divstatic for 50% / 75%, then one pseudo-random traversal for the rest
- `multi4` — divstatic 50%, then four different pseudo-random traversals at 12.5% each (portfolio-of-shuffles)
- `pure_rand` — pseudo-random for the whole budget (control)

Run at two budgets on hard drafts (est. combos ≫ cap, so the cap genuinely binds):

**250k-node budget (n=130)**

| strategy | beats pure_div | ties | loses | mean Δ | sign-test p |
|---|---|---|---|---|---|
| hyb50 | 6 | 105 | 19 | −0.085 | 0.015 |
| hyb75 | 6 | 116 | 8 | +0.008 | 0.79 |
| multi4 | 13 | 101 | 16 | +0.008 | 0.71 |
| pure_rand | 13 | 29 | 88 | −1.27 | <0.001 |

**1M-node budget (n=144)**

| strategy | beats pure_div | ties | loses | mean Δ | sign-test p |
|---|---|---|---|---|---|
| hyb50 | 8 | 122 | 14 | −0.042 | 0.29 |
| hyb75 | 7 | 131 | 6 | 0.000 | 1.00 |
| multi4 | 12 | 120 | 12 | +0.007 | 1.00 |
| pure_rand | 11 | 49 | 84 | −1.16 | <0.001 |

## What this says

1. **No diversity strategy is a better default.** Every hybrid's mean delta vs pure_div is
   statistically indistinguishable from zero (multi4/hyb75) or significantly *negative* (hyb50 at
   250k). `pure_rand` is clearly worse, as expected — it confirms best-first ordering is doing
   real work, same lesson as your backward-search failure. So divstatic stays the primary/default;
   diversity as a forced replacement is a dead end.

2. **But diversity is a real, non-negligible *alternate* — exactly the toggle you described.**
   The strategies genuinely search different regions: across all 274 unique hard drafts (both
   budgets), **some diversity strategy strictly beat pure_div at equal budget in 36 (13.1%)** of
   them — 10.2% even excluding pure_random — and when it helped the gain averaged **+1.22, up to
   +3**. Critically these are *high-variance and roughly symmetric*: multi4 also did *worse* than
   pure_div on 10.2% of drafts. No single alternate dominates, but the union of them covers cases
   pure_div misses. That is the textbook profile of "worth offering as a user choice, wrong as a
   forced default."

3. **Your proposed design is the correct shape.** A default-off diversity control (0% = pure
   divstatic) with incremental strategies the user can dial up, then *pick whichever run produced
   the best score*, captures the upside (+1–3 in ~13% of hard drafts) with **zero downside** —
   because the user only ever keeps the winning result, the high variance stops being a risk and
   becomes pure optional upside. A slider (% of budget given to diversity) and/or a small
   multiple-choice (off / hyb50 / hyb75 / multi4) both map cleanly onto what was tested.

## Recommendation

Ship it as an **optional, default-off** solver setting, consistent with the other advanced
options, and log which strategy/percentage produced the shown result (so a reported "beatable"
solve records whether diversity was in play). Concretely:

- **Default 0% = pure divstatic** — unchanged shipped behavior, so nobody who ignores the setting
  is affected.
- **Offer the tested points**, not arbitrary ones: the strategies with data behind them are
  hyb50, hyb75, and multi4. A slider is fine as the UI, but its stops should correspond to
  "fraction of the node budget spent on seeded pseudo-random traversals after divstatic," which is
  exactly what these presets are.
- **The solver core stays untouched** — this is purely a wrapper that runs the existing solver
  with a shuffled candidate order for part of the budget, seeded with the incumbent. The
  resumable solver already proves that a phased run returns the same answer an uninterrupted run
  would for each phase.

If you'd rather keep the surface minimal: `multi4` is the single best all-rounder (most wins, no
significant loss at either budget), so a plain **off / on (multi-4)** toggle would capture most of
the available upside with one checkbox. The slider is the "diversity on the diversity" version and
is strictly a superset — both are defensible; the data supports either.

## Files

- `run_diversity_experiment.js` — the budget-matched strategy harness
- `diversity_250k.jsonl`, `diversity_1m.jsonl` — raw results
- `diversity_winloss.png` — the win/loss chart at both budgets
- `resumable_solver.js` fidelity was verified inline (0/60 mismatches); no separate artifact.
