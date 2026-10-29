// Summarizes a benchmark run: per task and tool, the success rate, median time, turns, tokens and cost, and how
// often the run took over the user's active tab.
//
//   node bench/report.mjs bench/results/<timestamp> [more result dirs…] [--json]
import fs from "node:fs";
import path from "node:path";
import { tasks } from "./tasks.mjs";

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const runs = dirs.flatMap((dir) => fs.readFileSync(path.join(dir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
// The active-tab probe also sees the user's own tab switches; only a benchmark page coming to the front counts.
const tookTab = (r) => (r.activeTabs ?? []).some((url) => /:4790[12]\//.test(url));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const tools = [...new Set(runs.map((r) => r.tool))];
// Runs with different settings are not comparable; records from before the settings were recorded have none.
for (const key of ["model", "effort"]) {
  const values = [...new Set(runs.map((r) => r[key]).filter(Boolean))];
  if (values.length > 1) console.error(`warning: the runs mix ${key} values (${values.join(", ")}); report them separately`);
}

const summary = tasks.filter((t) => runs.some((r) => r.task === t.id)).map((t) => {
  const byTool = Object.fromEntries(tools.map((tool) => {
    const rs = runs.filter((r) => r.task === t.id && r.tool === tool);
    const ok = rs.filter((r) => r.ok);
    return [tool, {
      runs: rs.length,
      passed: ok.length,
      medianSeconds: median(ok.map((r) => r.wallMs / 1000)),
      medianTurns: median(ok.map((r) => r.turns)),
      medianCostUsd: median(ok.map((r) => r.costUsd)),
      medianInputTokens: median(ok.map((r) => r.inputTokens)),
      medianOutputTokens: median(ok.map((r) => r.outputTokens)),
      tabTaken: rs.filter(tookTab).length,
      browserCameForward: rs.filter((r) => r.browserCameForward).length,
    }];
  }));
  return { task: t.id, title: t.title, kind: t.kind, ...byTool };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (a, b) => (a && b ? `${Math.round((1 - a / b) * 100)}%` : "–");
  for (const s of summary) {
    console.log(`\n${s.title} [${s.kind}]`);
    for (const tool of tools) {
      const v = s[tool];
      console.log(`  ${tool.padEnd(7)} ${v.passed}/${v.runs} ok  median ${v.medianSeconds?.toFixed(1) ?? "–"} s  turns ${v.medianTurns ?? "–"}  in ${v.medianInputTokens ?? "–"}  out ${v.medianOutputTokens ?? "–"}  $${v.medianCostUsd?.toFixed(3) ?? "–"}  tab taken ${v.tabTaken}/${v.runs}`);
    }
    for (const other of tools.filter((tool) => tool !== "bruse")) {
      if (!s.bruse || !s[other]) continue;
      console.log(`  bruse vs ${other}: faster by ${pct(s.bruse.medianSeconds, s[other].medianSeconds)}, cheaper by ${pct(s.bruse.medianCostUsd, s[other].medianCostUsd)}, input tokens lower by ${pct(s.bruse.medianInputTokens, s[other].medianInputTokens)}`);
    }
  }
}
