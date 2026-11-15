# token-radar-01 v2 — Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: every pre-token protocol in the sealed snapshot, ranked by
a fitted implied value, with a costed, timed farm plan per protocol.

## Value model

Comps are the 129 live-token protocols in the snapshot. Per category with ≥ 5
comps, a least-squares size curve `log10(mcap) = a + b·log10(TVL)` is fitted
(`fitSizeCurve` in `lib/model.ts`); thinner categories shrink to the global fit.
Implied value = curve value × growth factor (7-day TVL change, clamped 0.8–1.2)
× age factor (log-scaled 0.85–1.00), capped at 10× TVL.

Validation is out-of-sample and reported honestly in the dashboard:
leave-one-out over the comps (`leaveOneOut`) and a time-split test
(`timeSplitTest`, fitted before the median listing date, tested after it).

## Board

198 pre-token protocols pass the watchlist rules (no token recorded, no
wrapped/staked/bridged product, no versioned name, no exchange prefix) — the
watchlist's 40 are all included, with no extra TVL floor and no hardcoded names.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22 stdlib only. `main.ts` writes `board.json`, the dashboard (`dashboard/`
+ `data.js`), copies `screenshots/`, and writes `dossier.json` via
`buildDossier` from `vendor/makefun-board.ts`.

## License

MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrcbfccn&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
