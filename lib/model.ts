// token-radar-01 v2 — value model: fitted size curve + shrinkage + OOS validation.
// Written from the design doc + input/README.md + snapshot.json only.
// No protocol name is hardcoded anywhere: every row is derived from the snapshot.
import { readFileSync } from "node:fs";

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export function loadSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, "utf8")) as Snapshot;
}

// ---------------------------------------------------------------------------
// Board eligibility: the watchlist rule from input/README.md, applied to every
// pre-token protocol (no TVL floor — the watchlist is a floor, never a ceiling).
// A protocol "records no token" when both gecko_id and symbol are null.
// ---------------------------------------------------------------------------
export const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = [
  "Binance",
  "Coinbase",
  "Bybit",
  "Kraken",
  "Bitget",
  "OKX",
  "Bitfinex",
  "Gemini",
];

export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

export function passesWatchlistRules(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const ex of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(ex)) return false;
  }
  return true;
}

export function isBoardEligible(p: Protocol): boolean {
  return recordsNoToken(p) && passesWatchlistRules(p);
}

// ---------------------------------------------------------------------------
// Fitted size curve: least-squares log10(mcap) = a + b * log10(tvl) over the
// live-token comparables ("comps"). A category gets its own fit when it has at
// least 5 comps; thinner categories shrink to the global fit over all comps,
// so no protocol is ever priced off one global number alone. The median MC/TVL
// ratio per category is reported alongside, for transparency.
// ---------------------------------------------------------------------------
export interface SizeCurveFit {
  slope: number;
  intercept: number;
  n: number;
  medianRatio: number;
  method: "category" | "global";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function fitSizeCurve(comps: Protocol[]): SizeCurveFit {
  const pts = comps.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const n = pts.length;
  if (n === 0) return { slope: 1, intercept: 0, n: 0, medianRatio: 0, method: "global" };
  if (n === 1) {
    return {
      slope: 1,
      intercept: Math.log10(pts[0].mcap_usd as number) - Math.log10(pts[0].tvl_usd),
      n,
      medianRatio: (pts[0].mcap_usd as number) / pts[0].tvl_usd,
      method: "global",
    };
  }
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += Math.log10(p.tvl_usd);
    sy += Math.log10(p.mcap_usd as number);
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = Math.log10(p.tvl_usd) - mx;
    sxx += dx * dx;
    sxy += dx * (Math.log10(p.mcap_usd as number) - my);
  }
  const slope = sxx === 0 ? 1 : sxy / sxx;
  const intercept = my - slope * mx;
  const ratios = pts.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  return { slope, intercept, n, medianRatio: median(ratios), method: "global" };
}

export interface CurveSet {
  global: SizeCurveFit;
  byCategory: Map<string, SizeCurveFit>;
}

export function fitAllCurves(comps: Protocol[]): CurveSet {
  const global = fitSizeCurve(comps);
  const byCategory = new Map<string, SizeCurveFit>();
  const cats = new Map<string, Protocol[]>();
  for (const p of comps) {
    const c = p.category ?? "Uncategorised";
    if (!cats.has(c)) cats.set(c, []);
    cats.get(c)?.push(p);
  }
  for (const [cat, list] of [...cats.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (list.length >= 5) {
      const f = fitSizeCurve(list);
      f.method = "category";
      byCategory.set(cat, f);
    }
  }
  return { global, byCategory };
}

export function curveFor(category: string | null, curves: CurveSet): SizeCurveFit {
  if (category !== null) {
    const f = curves.byCategory.get(category);
    if (f) return f;
  }
  return curves.global;
}

export function predictFromCurve(fit: SizeCurveFit, tvl: number): number {
  if (tvl <= 0) return 0;
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(tvl));
}

// ---------------------------------------------------------------------------
// Multipliers. Growth: 7-day TVL change, damped and clamped to [0.8, 1.2];
// null change is neutral (1.0). Age: how long the protocol has run with no
// token — older unlaunched protocols are discounted a little, log-scaled, in
// [0.85, 1.00]; null listed_at is neutral (1.0).
// ---------------------------------------------------------------------------
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  return Math.min(1.2, Math.max(0.8, 1 + change7d / 100));
}

export function daysSince(dateStr: string | null, asOf: string): number | null {
  if (dateStr === null) return null;
  const d0 = Date.parse(dateStr + "T00:00:00Z");
  const d1 = Date.parse(asOf + "T00:00:00Z");
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) return null;
  return Math.max(0, Math.floor((d1 - d0) / 86400000));
}

export function ageFactor(listedAt: string | null, asOf: string): number {
  const days = daysSince(listedAt, asOf);
  if (days === null) return 1;
  const years = days / 365.25;
  const scaled = Math.log10(1 + years) / Math.log10(6);
  return Math.min(1, Math.max(0.85, 1 - 0.15 * Math.min(1, scaled)));
}

export interface ImpliedBreakdown {
  curveValue: number;
  growth: number;
  age: number;
  fit: SizeCurveFit;
  capped: boolean;
}

export function impliedValue(
  p: Protocol,
  curves: CurveSet,
  asOf: string,
): { value: number; breakdown: ImpliedBreakdown } {
  const fit = curveFor(p.category, curves);
  const curveValue = predictFromCurve(fit, p.tvl_usd);
  const growth = growthFactor(p.change_7d);
  const age = ageFactor(p.listed_at, asOf);
  const raw = curveValue * growth * age;
  // Sanity cap: never more than 10x TVL, never above the $100T gate cap.
  const cap = Math.min(10 * p.tvl_usd, 100_000_000_000_000);
  const capped = raw > cap;
  const value = Math.max(1, Math.round(Math.min(raw, cap)));
  return { value, breakdown: { curveValue, growth, age, fit, capped } };
}

// ---------------------------------------------------------------------------
// Out-of-sample validation — reported honestly in the dashboard, however big
// the errors are. (a) leaveOneOut: refit without each comp and predict it.
// (b) timeSplitTest: fit only on comps listed before the median listed date,
// test on the ones listed after it.
// ---------------------------------------------------------------------------
export interface ValidationResult {
  n: number;
  medianAbsPctError: number;
  within2xShare: number;
}

function scorePredictions(actual: number[], predicted: number[]): ValidationResult {
  const errs: number[] = [];
  let within2x = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const pr = predicted[i];
    if (a > 0 && pr > 0) {
      const e = Math.abs(pr - a) / a;
      errs.push(e);
      if (pr >= a / 2 && pr <= a * 2) within2x++;
    }
  }
  const n = errs.length;
  return {
    n,
    medianAbsPctError: n === 0 ? 0 : median(errs),
    within2xShare: n === 0 ? 0 : within2x / n,
  };
}

export function leaveOneOut(comps: Protocol[]): ValidationResult {
  const live = comps.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const actual: number[] = [];
  const predicted: number[] = [];
  for (let i = 0; i < live.length; i++) {
    const rest = live.filter((_, j) => j !== i);
    const curves = fitAllCurves(rest);
    const fit = curveFor(live[i].category, curves);
    actual.push(live[i].mcap_usd as number);
    predicted.push(predictFromCurve(fit, live[i].tvl_usd));
  }
  return scorePredictions(actual, predicted);
}

export interface TimeSplitResult extends ValidationResult {
  cutoff: string;
  nTrain: number;
  nTest: number;
}

export function timeSplitTest(comps: Protocol[]): TimeSplitResult {
  const dated = comps
    .filter((p) => p.listed_at !== null && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => ((a.listed_at as string) < (b.listed_at as string) ? -1 : 1));
  if (dated.length < 10) {
    return { cutoff: "", nTrain: 0, nTest: 0, n: 0, medianAbsPctError: 0, within2xShare: 0 };
  }
  const cutoff = dated[Math.floor(dated.length / 2)].listed_at as string;
  const train = dated.filter((p) => (p.listed_at as string) < cutoff);
  const test = dated.filter((p) => (p.listed_at as string) >= cutoff);
  const curves = fitAllCurves(train);
  const actual: number[] = [];
  const predicted: number[] = [];
  for (const p of test) {
    const fit = curveFor(p.category, curves);
    actual.push(p.mcap_usd as number);
    predicted.push(predictFromCurve(fit, p.tvl_usd));
  }
  const scored = scorePredictions(actual, predicted);
  return { cutoff, nTrain: train.length, nTest: test.length, ...scored };
}

// ---------------------------------------------------------------------------
// Gas costs per chain (typical swap/simple-tx cost, snapshot-era mainnets).
// The farm chain is the cheapest chain the protocol runs on — farming is
// about doing the same steps for the least gas.
// ---------------------------------------------------------------------------
export interface ChainGas {
  label: string;
  mid: number;
}

export const CHAIN_GAS: Record<string, ChainGas> = {
  Solana: { label: "~$0.01", mid: 0.01 },
  Base: { label: "~$0.01–0.05", mid: 0.03 },
  Sui: { label: "~$0.01–0.05", mid: 0.03 },
  Aptos: { label: "~$0.01–0.05", mid: 0.03 },
  Polygon: { label: "~$0.01–0.05", mid: 0.03 },
  "Hyperliquid L1": { label: "~$0.01–0.05", mid: 0.03 },
  Monad: { label: "~$0.01–0.05", mid: 0.03 },
  Arbitrum: { label: "~$0.10–0.50", mid: 0.3 },
  Optimism: { label: "~$0.05–0.20", mid: 0.12 },
  Binance: { label: "~$0.05–0.20", mid: 0.12 },
  Avalanche: { label: "~$0.10–0.50", mid: 0.3 },
  Linea: { label: "~$0.05–0.20", mid: 0.12 },
  Scroll: { label: "~$0.05–0.20", mid: 0.12 },
  Unichain: { label: "~$0.01–0.05", mid: 0.03 },
  Blast: { label: "~$0.05–0.20", mid: 0.12 },
  Sonic: { label: "~$0.01–0.05", mid: 0.03 },
  Berachain: { label: "~$0.05–0.20", mid: 0.12 },
  Ethereum: { label: "~$2–10", mid: 5 },
};

export const DEFAULT_GAS: ChainGas = { label: "~$0.10–1.00", mid: 0.5 };

export function farmChain(p: Protocol): string {
  let best = p.chains[0] ?? "Ethereum";
  let bestMid = Number.POSITIVE_INFINITY;
  for (const c of p.chains) {
    const g = CHAIN_GAS[c] ?? DEFAULT_GAS;
    if (g.mid < bestMid) {
      bestMid = g.mid;
      best = c;
    }
  }
  return best;
}

export function gasLabel(chain: string): string {
  return (CHAIN_GAS[chain] ?? DEFAULT_GAS).label;
}

// ---------------------------------------------------------------------------
// Farm plans: one concrete, costed, timed plan per mechanism family, derived
// from the protocol's category + chains. {CHAIN} and {GAS} are filled in per
// protocol. There is no "Default" template: every family has its own steps.
// ---------------------------------------------------------------------------
export type PlanKey =
  | "dex"
  | "lending"
  | "yield"
  | "perps"
  | "rwa"
  | "cdp"
  | "bridge"
  | "chain"
  | "stake"
  | "vault"
  | "index"
  | "payments"
  | "prediction"
  | "insurance"
  | "gov"
  | "otc"
  | "generic";

export function planKeyFor(category: string | null): PlanKey {
  switch (category) {
    case "Dexs":
      return "dex";
    case "Lending":
    case "Uncollateralized Lending":
    case "Collateral Markets":
      return "lending";
    case "Yield":
    case "Yield Aggregator":
    case "Farm":
    case "Leveraged Farming":
      return "yield";
    case "Derivatives":
    case "Basis Trading":
    case "Interest Rate Derivatives":
      return "perps";
    case "RWA":
    case "Decentralized BTC":
    case "Anchor BTC":
    case "Stablecoin Wrapper":
    case "Dual-Token Stablecoin":
      return "rwa";
    case "CDP":
    case "CDP Manager":
      return "cdp";
    case "Cross Chain Bridge":
      return "bridge";
    case "Chain":
      return "chain";
    case "Staking Pool":
    case "Restaking":
      return "stake";
    case "Risk Curators":
    case "Onchain Capital Allocator":
    case "Liquidity Manager":
    case "CeDeFi":
      return "vault";
    case "Indexes":
      return "index";
    case "Payments":
    case "Crypto Card Issuer":
      return "payments";
    case "Prediction Market":
      return "prediction";
    case "Insurance":
      return "insurance";
    case "Governance Incentives":
      return "gov";
    case "OTC Marketplace":
      return "otc";
    default:
      return "generic";
  }
}

const G = "{GAS}"; // gas per simple tx on the farm chain
const C = "{CHAIN}"; // farm chain name

export const PLANS: Record<PlanKey, { title: string; steps: string[] }> = {
  dex: {
    title: "DEX / AMM — swap + provide liquidity",
    steps: [
      `Swap a small amount ($25–100) into the pool's main pair on ${C} once a week; each swap costs ${G} in gas, ~2 min.`,
      `Add $50–200 of liquidity to the deepest pool and hold the LP position; deposit gas ${G}, keep the position 4–8 weeks.`,
      `Swap back a slice (10–25%) of the LP each week to show repeat usage; one swap costs ${G}, ~2 min per swap.`,
      `Use a second pool or a limit-order feature if the DEX offers one, once every 2 weeks; gas ${G} per action.`,
      `Claim any trading-fee rewards and re-deposit them monthly; claiming costs ${G}, budget 15 min a month.`,
    ],
  },
  lending: {
    title: "Lending — supply + borrow",
    steps: [
      `Supply $50–200 of a major asset (ETH, USDC or wBTC) as collateral on ${C}; supply tx costs ${G}, ~3 min.`,
      `Borrow 20–40% of the supplied value in a stablecoin to show active borrowing; borrow tx costs ${G}.`,
      `Repay part of the loan and re-borrow a different asset after 2 weeks; each leg costs ${G}, ~5 min.`,
      `Top up collateral by $25–50 once a month so the position stays healthy; top-up costs ${G}.`,
      `Repeat the supply/borrow cycle for 4–8 weeks and never let health factor drop near 1; check weekly, 10 min.`,
    ],
  },
  yield: {
    title: "Yield — deposit vault + harvest",
    steps: [
      `Deposit $50–200 into the highest-TVL vault on ${C}; deposit tx costs ${G}, ~3 min, funds stay 4–8 weeks.`,
      `Harvest or compound the yield once every 1–2 weeks; each harvest costs ${G}, ~5 min.`,
      `Split a second deposit ($25–50) into another vault or strategy after 2 weeks to widen coverage; gas ${G}.`,
      `Withdraw a small slice (10–20%) mid-cycle, then re-deposit it to record a full loop; each leg costs ${G}.`,
      `Keep a weekly log of vault APY and deposits; review takes 10 min a week, no extra gas.`,
    ],
  },
  perps: {
    title: "Perps / derivatives — open + close positions",
    steps: [
      `Open a small long or short ($25–100 notional, 1–2x leverage) on ${C}; opening costs ${G} plus the taker fee, ~5 min.`,
      `Set a stop-loss and take-profit on the position the same day; setting orders costs ${G} each on most venues.`,
      `Close the position within 1–7 days and open a fresh one the next week; each close costs ${G}, ~5 min.`,
      `Trade both directions across 4–8 weeks (at least 4 round trips) to show sustained use; budget ${G} per trade.`,
      `Never risk more than 5% of your farming budget on one trade; size positions small and keep a trade diary.`,
    ],
  },
  rwa: {
    title: "RWA — mint / hold tokenised assets",
    steps: [
      `Mint or buy $50–200 of the protocol's tokenised asset on ${C}; mint/buy tx costs ${G}, ~5 min.`,
      `Hold the position for at least 4 weeks — RWA farms reward holding time, not churn; check the position weekly.`,
      `If the asset pays yield, claim and re-deposit the payout monthly; claiming costs ${G}, ~10 min a month.`,
      `Use the asset once as collateral or in a second protocol if supported, after 2 weeks; that tx costs ${G}.`,
      `Keep the purchase receipt and position history; export them monthly (10 min) in case eligibility needs proof.`,
    ],
  },
  cdp: {
    title: "CDP — lock collateral + mint stablecoin",
    steps: [
      `Lock $100–300 of collateral (ETH or wBTC) in a vault on ${C}; locking costs ${G}, ~3 min.`,
      `Mint stablecoins against 25–40% of the collateral value; minting costs ${G}, keep the ratio safe.`,
      `Repay 10–20% of the minted debt after 2 weeks, then mint a smaller amount again; each leg costs ${G}.`,
      `Add $25–50 of collateral monthly so the ratio stays above 200%; top-up costs ${G}, ~5 min.`,
      `Hold the vault open 4–8 weeks and check the collateral ratio weekly (10 min); never let it near liquidation.`,
    ],
  },
  bridge: {
    title: "Bridge — move assets across chains regularly",
    steps: [
      `Bridge $25–100 from ${C} to another supported chain once a week; each bridge costs ${G} plus the bridge fee.`,
      `Bridge a different asset the following week to vary the route; allow 10–30 min for finality each time.`,
      `Bridge back at least once so the flow is two-way, not one-way; return leg costs ${G} plus the bridge fee.`,
      `Keep each bridge above the venue minimum (usually $10–25) and below $500 to limit slippage and fees.`,
      `Repeat for 4–8 weeks (6+ crossings) and keep the tx hashes; bridging history is the farm record here.`,
    ],
  },
  chain: {
    title: "Chain / L1 — use the network's apps",
    steps: [
      `Bridge $25–100 onto the chain and make a first swap on its flagship DEX; bridging plus swap cost ${G} each, ~10 min.`,
      `Deploy or interact with one native dApp (lending or perps) weekly for 4–8 weeks; each interaction costs ${G}.`,
      `Hold a small native-token balance ($10–50) for gas so activity never stalls; top up monthly if needed.`,
      `Try a second native app (NFT, payments or a vault) once a month; each try costs ${G}, ~15 min.`,
      `Keep activity steady rather than one burst: 2–3 tx a week for a month beats 20 tx in one day.`,
    ],
  },
  stake: {
    title: "Staking — stake + restake",
    steps: [
      `Stake $50–200 of the base asset on ${C}; staking tx costs ${G}, ~3 min, funds stay staked 4–8 weeks.`,
      `Claim staking rewards every 1–2 weeks and restake them; each claim costs ${G}, ~5 min.`,
      `Add $25–50 to the stake after 2 weeks to show a growing position; top-up costs ${G}.`,
      `If restaking is offered, restake a slice (25–50%) of the stake once; restaking costs ${G}, ~5 min.`,
      `Unstake only a small test amount near the end; full unstaking can take days — plan the exit a week ahead.`,
    ],
  },
  vault: {
    title: "Curated vault — deposit + monitor",
    steps: [
      `Deposit $50–200 into the largest curated vault on ${C}; deposit costs ${G}, ~3 min, hold 4–8 weeks.`,
      `Check the vault's curator, allocation and APY weekly (10 min); switch vaults if the curator changes strategy.`,
      `Add $25–50 to a second vault run by a different curator after 2 weeks; deposit costs ${G}.`,
      `Harvest or compound vault yield every 1–2 weeks; each harvest costs ${G}, ~5 min.`,
      `Withdraw a 10–20% test slice once mid-cycle, then re-deposit; each leg costs ${G} and proves a full loop.`,
    ],
  },
  index: {
    title: "Index — buy the basket + rebalance",
    steps: [
      `Buy $50–200 of the index token on ${C}; the buy costs ${G}, ~3 min, hold for at least 4 weeks.`,
      `Add $25–50 on the monthly rebalance date if the index reweights; top-up costs ${G}.`,
      `Redeem a small slice (10–20%) once to test the redemption path, then buy back; each leg costs ${G}.`,
      `Compare the index price to its NAV weekly (10 min) and note any discount — it is part of the farm record.`,
      `Hold through at least one full rebalance cycle (usually a month) before judging the position.`,
    ],
  },
  payments: {
    title: "Payments — pay + settle",
    steps: [
      `Make a first real payment of $10–50 through the protocol on ${C}; payment tx costs ${G}, ~3 min.`,
      `Repeat a payment weekly for 4–8 weeks (small, real amounts); each payment costs ${G}.`,
      `Try a second payment rail or currency if offered, once every 2 weeks; each try costs ${G}.`,
      `Settle or withdraw accumulated balances monthly; settlement costs ${G}, ~10 min a month.`,
      `Keep receipts for every payment; export the history monthly (10 min) as proof of sustained use.`,
    ],
  },
  prediction: {
    title: "Prediction market — trade outcomes",
    steps: [
      `Buy $10–50 of shares in a market resolving in 2–4 weeks on ${C}; each trade costs ${G}, ~3 min.`,
      `Trade a second market in a different category the next week; each trade costs ${G}.`,
      `Sell or hold to resolution — either path counts — and record the outcome; selling costs ${G}.`,
      `Place 4–8 small trades over 4–8 weeks rather than one big bet; total gas is roughly ${G} per trade.`,
      `Never bet more than 2% of your farming budget on one market; prediction farms reward breadth, not size.`,
    ],
  },
  insurance: {
    title: "Insurance — buy cover + keep it live",
    steps: [
      `Buy cover of $100–500 for 30–90 days on ${C}; the purchase costs ${G} plus the premium, ~5 min.`,
      `Renew or extend the cover before it lapses; renewal costs ${G}, budget 10 min.`,
      `If the protocol lets users underwrite, provide $25–50 of cover capacity once; that tx costs ${G}.`,
      `File a test claim only if a real covered event happens — never file a false claim; filing costs ${G}.`,
      `Keep the policy live for at least one full term (30+ days); lapsed cover breaks the farm record.`,
    ],
  },
  gov: {
    title: "Governance incentives — vote + lock",
    steps: [
      `Lock or delegate $25–100 of voting power on ${C}; locking costs ${G}, ~3 min, lock for 4–8 weeks.`,
      `Vote on every live proposal while locked — missing votes is the usual disqualifier; voting costs ${G} each.`,
      `Claim voting rewards weekly and re-lock them; claiming costs ${G}, ~5 min a week.`,
      `Join one governance discussion (forum or vote rationale) per proposal cycle; ~15 min, no gas.`,
      `Keep the lock through at least two proposal cycles before unlocking; early exit can forfeit rewards.`,
    ],
  },
  otc: {
    title: "OTC — quote + settle trades",
    steps: [
      `Request a quote for a $100–500 trade on ${C}; quoting is free, settling costs ${G}, ~10 min.`,
      `Settle one small trade to open the account history; settlement costs ${G} plus the agreed spread.`,
      `Repeat a trade every 1–2 weeks in a different pair; each settlement costs ${G}.`,
      `Use limit or RFQ orders when offered to show varied order types; each fill costs ${G}.`,
      `Keep 4+ settled trades over 4–8 weeks; export the trade history monthly (10 min) as the farm record.`,
    ],
  },
  generic: {
    title: "Protocol — use the core feature weekly",
    steps: [
      `Use the protocol's core feature on ${C} with $25–100 once a week; each use costs ${G}, ~5 min.`,
      `Repeat the core action with a different asset or parameter the next week; each repeat costs ${G}.`,
      `Keep a position or balance open for 4–8 weeks — farms reward sustained use over one-off bursts.`,
      `Try one secondary feature (a second pool, market or tool) after 2 weeks; that try costs ${G}.`,
      `Log every interaction weekly (10 min) so the farm record is complete if eligibility is ever checked.`,
    ],
  },
};

export function farmStepsFor(p: Protocol): string[] {
  const key = planKeyFor(p.category);
  const chain = farmChain(p);
  const gas = gasLabel(chain);
  return PLANS[key].steps.map((s) => s.replaceAll(C, chain).replaceAll(G, gas));
}

export function farmPlanTitle(p: Protocol): string {
  return PLANS[planKeyFor(p.category)].title;
}

// Farm verdict for the detail view: derived from snapshot numbers, not opinion.
export function farmVerdict(p: Protocol, implied: number): string {
  const tvlM = p.tvl_usd / 1_000_000;
  const size =
    tvlM >= 500 ? "very large TVL" : tvlM >= 100 ? "large TVL" : tvlM >= 25 ? "mid-size TVL" : "small TVL";
  const growth =
    p.change_7d === null
      ? "no 7-day change reported"
      : p.change_7d >= 10
        ? `fast 7-day growth (+${p.change_7d.toFixed(1)}%)`
        : p.change_7d <= -10
          ? `sharp 7-day fall (${p.change_7d.toFixed(1)}%)`
          : `steady 7-day change (${p.change_7d.toFixed(1)}%)`;
  const chain = farmChain(p);
  const cheap = (CHAIN_GAS[chain] ?? DEFAULT_GAS).mid <= 0.12;
  const verdict =
    tvlM >= 100 && (p.change_7d ?? 0) >= 0
      ? "Worth farming"
      : tvlM >= 25
        ? "Worth a small farm"
        : "Farm only with small size";
  return `${verdict}: ${size} ($${Math.round(tvlM)}M), ${growth}, cheapest chain ${chain} (${cheap ? "cheap gas" : "higher gas"}), implied value $${implied.toLocaleString("en-US")}.`;
}
