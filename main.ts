// token-radar-01 v2 — entrypoint. Node 22 stdlib only.
// Reads /input/snapshot.json, writes /output/board.json, the dashboard data,
// copies dashboard/ + screenshots/ into /output, and writes /output/dossier.json
// with buildDossier from vendor/makefun-board.ts.
// Repo root is resolved from import.meta.url — never process.cwd().
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";
import {
  curveFor,
  farmChain,
  farmStepsFor,
  fitAllCurves,
  impliedValue,
  isBoardEligible,
  leaveOneOut,
  loadSnapshot,
  planKeyFor,
  PLANS,
  recordsNoToken,
  timeSplitTest,
  type Protocol,
} from "./lib/model.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputPath = argValue(argv, "--input") ?? "/input/snapshot.json";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const snap = loadSnapshot(inputPath);
  const asOf = snap.as_of;

  const comps = snap.protocols.filter(
    (p: Protocol) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const curves = fitAllCurves(comps);
  const loo = leaveOneOut(comps);
  const split = timeSplitTest(comps);

  // Board: every pre-token protocol that passes the watchlist rules (~198),
  // ranked by fitted implied value. No name is hardcoded; no extra TVL floor.
  const eligible = snap.protocols.filter(isBoardEligible);
  const scored = eligible.map((p) => {
    const { value, breakdown } = impliedValue(p, curves, asOf);
    return { p, value, breakdown };
  });
  scored.sort((a, b) => (b.value - a.value !== 0 ? b.value - a.value : a.p.slug < b.p.slug ? -1 : 1));

  const watchSet = new Set(snap.watchlist);
  for (const w of snap.watchlist) {
    if (!eligible.some((p) => p.slug === w)) {
      throw new Error(`watchlist slug missing from board: ${w}`);
    }
  }

  const rows = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.value,
    farm_steps: farmStepsFor(s.p),
  }));
  const board = { as_of: asOf, rows };

  // Dashboard data (compact arrays; the page re-derives the model breakdown
  // from the shipped fits, so rows stay small and the dossier stays < 64 KB).
  const chainIndex = new Map<string, number>();
  const chainList: string[] = [];
  const chainIdx = (c: string): number => {
    if (!chainIndex.has(c)) {
      chainIndex.set(c, chainList.length);
      chainList.push(c);
    }
    return chainIndex.get(c) as number;
  };

  const fitJson = (f: { slope: number; intercept: number; n: number; medianRatio: number; method: string }) => ({
    a: +f.intercept.toFixed(6),
    b: +f.slope.toFixed(6),
    n: f.n,
    r: +f.medianRatio.toFixed(6),
    m: f.method === "category" ? "cat" : "glo",
  });
  const fits: Record<string, unknown> = { "*": fitJson(curves.global) };
  for (const [cat, f] of [...curves.byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    fits[cat] = fitJson(f);
  }
  // Median ratio for categories without their own fit (display only).
  const catRatios: Record<string, number> = {};
  for (const p of comps) {
    const c = p.category ?? "Uncategorised";
    if (!(c in catRatios)) {
      const rs = comps
        .filter((q) => (q.category ?? "Uncategorised") === c && q.tvl_usd > 0)
        .map((q) => (q.mcap_usd as number) / q.tvl_usd)
        .sort((a, b) => a - b);
      catRatios[c] = +(rs.length % 2 === 1
        ? rs[Math.floor(rs.length / 2)]
        : (rs[Math.floor(rs.length / 2) - 1] + rs[Math.floor(rs.length / 2)]) / 2).toFixed(6);
    }
  }

  const dataRows = scored.map((s) => [
    s.p.slug,
    s.p.name,
    s.p.category,
    s.p.tvl_usd,
    s.p.change_7d,
    s.p.listed_at,
    s.value,
    planKeyFor(s.p.category),
    chainIdx(farmChain(s.p)),
    watchSet.has(s.p.slug) ? 1 : 0,
  ]);
  const liveRows = [...comps]
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .map((p) => [p.slug, p.name, p.category, p.tvl_usd, p.mcap_usd]);

  const radar = {
    asOf,
    floor: snap.floor_usd,
    nBoard: rows.length,
    nWatch: snap.watchlist.length,
    nComps: comps.length,
    model: {
      fits,
      ratios: catRatios,
      loo: { n: loo.n, medErr: +loo.medianAbsPctError.toFixed(4), in2x: +loo.within2xShare.toFixed(4) },
      split: {
        cutoff: split.cutoff,
        nTrain: split.nTrain,
        nTest: split.nTest,
        medErr: +split.medianAbsPctError.toFixed(4),
        in2x: +split.within2xShare.toFixed(4),
      },
    },
    chains: chainList,
    plans: PLANS,
    rows: dataRows,
    live: liveRows,
  };

  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n", "utf8");
  writeFileSync(
    join(outDir, "dashboard", "data.js"),
    "window.RADAR=" + JSON.stringify(radar) + ";\n",
    "utf8",
  );

  // Copy the dashboard sources (the page, its CSS and JS) into /output.
  const dashSrc = join(ROOT, "dashboard");
  for (const f of readdirSync(dashSrc).sort()) {
    if (f === "data.js") continue;
    copyFileSync(join(dashSrc, f), join(outDir, "dashboard", f));
  }
  // Copy the screenshots into /output (buildDossier refuses an empty set).
  const shotsSrc = join(ROOT, "screenshots");
  const shots = existsSync(shotsSrc) ? readdirSync(shotsSrc).sort() : [];
  for (const f of shots) {
    if (f.startsWith(".")) continue;
    copyFileSync(join(shotsSrc, f), join(outDir, "screenshots", f));
  }

  // Dossier: buildDossier returns the dossier bytes (a Uint8Array); the
  // entry writes them to /output/dossier.json byte for byte.
  const result = await buildDossier(outDir, { text_max_bytes: 65536 });
  if (!existsSync(join(outDir, "dossier.json"))) {
    if (result instanceof Uint8Array) {
      writeFileSync(join(outDir, "dossier.json"), result);
    } else if (typeof result === "string") {
      writeFileSync(join(outDir, "dossier.json"), result, "utf8");
    } else if (result !== null && typeof result === "object") {
      throw new Error("buildDossier returned an unexpected object instead of bytes");
    } else {
      throw new Error("buildDossier wrote no dossier.json and returned nothing usable");
    }
  }

  const liveCount = snap.protocols.filter((p) => !recordsNoToken(p)).length;
  console.log(
    `token-radar-01 v2: ${rows.length} board rows (${snap.watchlist.length} watchlist), ` +
      `${comps.length} comps, ${liveCount} live-token protocols, ` +
      `LOO median err ${(loo.medianAbsPctError * 100).toFixed(1)}%, ` +
      `time-split (${split.cutoff}) median err ${(split.medianAbsPctError * 100).toFixed(1)}%`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
