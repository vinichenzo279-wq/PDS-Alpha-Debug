import json, os, sys
from playwright.sync_api import sync_playwright

os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/opt/pw-browsers')

APP = 'file:///home/claude/pacwyn_fixed_v9_5_0.html'
TRACED_JS = open('/home/claude/solveBestTraced.js').read()
INJECT_JS = open('/home/claude/fuzz_inject.js').read()

# ---------------------------------------------------------------------------
# "Scaled" tier: small-ish drafts, rerolled until the candidate-space estimate is small enough
# that most trials finish uncapped. RC is modeled the way the real app derives it (see rcMode
# below / computeRC() in fuzz_inject.js) instead of a flat constant, mostly 'auto' (mirrors the
# app's default "Optimal RC" mode) with some 'auto-jitter' and 'manual' trials mixed in so we can
# compare RC-derivation modes against each other.
# ---------------------------------------------------------------------------
SCALED_PRESETS = [
    dict(minBust=0, maxBust=2, minPer=1, maxPer=2, maxEst=200000, cap=5000000, rcMode='auto'),
    dict(minBust=1, maxBust=3, minPer=1, maxPer=3, maxEst=400000, cap=5000000, rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=1, maxPer=2, maxEst=150000, cap=5000000, rcMode='auto'),
    dict(minBust=2, maxBust=4, minPer=1, maxPer=3, maxEst=400000, cap=5000000, rcMode='auto-jitter'),
    dict(minBust=0, maxBust=3, minPer=1, maxPer=2, maxEst=250000, cap=5000000, rcMode='auto'),
    dict(minBust=0, maxBust=2, minPer=1, maxPer=4, maxEst=800000, cap=5000000, rcMode='auto-jitter'),
    dict(minBust=1, maxBust=4, minPer=2, maxPer=3, maxEst=600000, cap=5000000, rcMode='manual', rc=99),
]

# ---------------------------------------------------------------------------
# "Complex" tier: NOT rerolled away from big estimates -- these are meant to be big and, often,
# node-capped. The point is to see where node counts / solve time jump as active-slot count and
# per-slot candidate count grow, without ever letting a single trial run unbounded. Wall time is
# controlled purely by `cap` (see COMPLEX_HARD_CAP_CEILING clamp in fuzz_inject.js), never by
# search-space size, so these are safe to run even though estCombos can be enormous.
# ---------------------------------------------------------------------------
COMPLEX_PRESETS = [
    dict(minBust=0, maxBust=1, minPer=2, maxPer=4, cap=750000,  rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=3, maxPer=5, cap=1500000, rcMode='auto'),
    dict(minBust=0, maxBust=0, minPer=3, maxPer=6, cap=1500000, rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=4, maxPer=6, cap=3000000, rcMode='auto'),
    dict(minBust=0, maxBust=0, minPer=4, maxPer=7, cap=3000000, rcMode='auto-jitter'),
    dict(minBust=0, maxBust=0, minPer=5, maxPer=8, cap=4000000, rcMode='auto'),  # will hit COMPLEX_HARD_CAP_CEILING
]


def run_phase(page, label, presets, n_total, batch_fn):
    all_results = []
    done = 0
    pi = 0
    while done < n_total:
        n = min(50, n_total - done)
        opts = presets[pi % len(presets)]
        pi += 1
        res = page.evaluate("([fn,n,opts])=>window[fn](n,opts)", [batch_fn, n, opts])
        for r in res:
            r['preset'] = pi
            r['presetOpts'] = opts
        all_results.extend(res)
        done += n
        print(f'[{label}] progress: {done}/{n_total}')
    return all_results


def main():
    n_scaled = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    n_complex = int(sys.argv[2]) if len(sys.argv) > 2 else 150

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.on('console', lambda m: print('CONSOLE:', m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: print('PAGEERROR:', e))
        page.goto(APP)
        page.wait_for_timeout(200)
        # sanity: confirm globals exist (playerDB/FORMS from the app, plus maxPossibleRating
        # which the RC modeling in fuzz_inject.js depends on)
        ok = page.evaluate(
            "typeof FORMS!=='undefined' && typeof playerDB!=='undefined' && "
            "typeof maxPossibleRating==='function' && playerDB.length"
        )
        print('sanity (playerDB length / maxPossibleRating present):', ok)

        page.evaluate("(code) => { (0, eval)(code); }", TRACED_JS)
        page.evaluate("(code) => { (0, eval)(code); }", INJECT_JS)

        scaled_results = run_phase(page, 'scaled', SCALED_PRESETS, n_scaled, '__runFuzzBatch')
        complex_results = run_phase(page, 'complex', COMPLEX_PRESETS, n_complex, '__runFuzzBatchComplex')

        browser.close()

    all_results = scaled_results + complex_results
    with open('/home/claude/fuzz_results.json', 'w') as f:
        json.dump(all_results, f)
    print(f'Saved {len(scaled_results)} scaled + {len(complex_results)} complex = {len(all_results)} trial results')


if __name__ == '__main__':
    main()
