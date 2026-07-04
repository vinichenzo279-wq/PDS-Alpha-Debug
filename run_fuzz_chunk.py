import json, os, sys
from playwright.sync_api import sync_playwright

APP = 'file:///home/claude/pacwyn_fixed_v9_5_0.html'
TRACED_JS = open('/home/claude/solveBestTraced.js').read()
INJECT_JS = open('/home/claude/fuzz_inject.js').read()

SCALED_PRESETS = [
    dict(minBust=0, maxBust=2, minPer=1, maxPer=2, maxEst=200000, cap=5000000, rcMode='auto'),
    dict(minBust=1, maxBust=3, minPer=1, maxPer=3, maxEst=400000, cap=5000000, rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=1, maxPer=2, maxEst=150000, cap=5000000, rcMode='auto'),
    dict(minBust=2, maxBust=4, minPer=1, maxPer=3, maxEst=400000, cap=5000000, rcMode='auto-jitter'),
    dict(minBust=0, maxBust=3, minPer=1, maxPer=2, maxEst=250000, cap=5000000, rcMode='auto'),
    dict(minBust=0, maxBust=2, minPer=1, maxPer=4, maxEst=800000, cap=5000000, rcMode='auto-jitter'),
    dict(minBust=1, maxBust=4, minPer=2, maxPer=3, maxEst=600000, cap=5000000, rcMode='manual', rc=99),
]
COMPLEX_PRESETS = [
    dict(minBust=0, maxBust=1, minPer=2, maxPer=4, cap=750000,  rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=3, maxPer=5, cap=1500000, rcMode='auto'),
    dict(minBust=0, maxBust=0, minPer=3, maxPer=6, cap=1500000, rcMode='auto'),
    dict(minBust=0, maxBust=1, minPer=4, maxPer=6, cap=3000000, rcMode='auto'),
    dict(minBust=0, maxBust=0, minPer=4, maxPer=7, cap=3000000, rcMode='auto-jitter'),
    dict(minBust=0, maxBust=0, minPer=5, maxPer=8, cap=4000000, rcMode='auto'),
]

def main():
    phase = sys.argv[1]  # 'scaled' or 'complex'
    n_total = int(sys.argv[2])
    preset_offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    out_path = sys.argv[4] if len(sys.argv) > 4 else f'/home/claude/fuzz_{phase}.jsonl'

    presets = SCALED_PRESETS if phase == 'scaled' else COMPLEX_PRESETS
    batch_fn = '__runFuzzBatch' if phase == 'scaled' else '__runFuzzBatchComplex'

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(APP)
        page.wait_for_timeout(200)
        page.evaluate("(code) => { (0, eval)(code); }", TRACED_JS)
        page.evaluate("(code) => { (0, eval)(code); }", INJECT_JS)

        done = 0
        pi = preset_offset
        with open(out_path, 'a') as f:
            while done < n_total:
                n = min(50, n_total - done)
                opts = presets[pi % len(presets)]
                pi += 1
                res = page.evaluate("([fn,n,opts])=>window[fn](n,opts)", [batch_fn, n, opts])
                for r in res:
                    r['preset'] = pi
                    r['presetOpts'] = opts
                    f.write(json.dumps(r) + '\n')
                f.flush()
                done += n
                print(f'[{phase}] {done}/{n_total} (preset_idx={pi})')
        browser.close()
    print(f'DONE phase={phase} next_preset_offset={pi}')

if __name__ == '__main__':
    main()
