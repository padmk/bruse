// Summarizes a benchmark run: per task and tool, the success rate, median time, turns, tokens and cost
// with 95% bootstrap confidence intervals, the wall time outside the model's API calls (the browser tool,
// the client and the network), and how often the run took over the user's active tab. Time and cost
// medians are given for passed runs and, separately, for all runs including failed and interrupted ones.
// The interval of the time ratio between tools resamples repetitions as pairs: the runs of both tools
// with the same repetition number ran back to back, in alternating order.
//
//   node bench/report.mjs bench/results/<timestamp> [more result dirs…] [--json]
import fs from "node:fs";
import path from "node:path";
import { tasks as localTasks } from "./tasks.mjs";
import { tasks as realTasks } from "./tasks-real.mjs";

const tasks = [...localTasks, ...realTasks];

const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// Each run remembers its directory: repetition numbers start again in every run of the benchmark.
const runs = dirs.flatMap((dir) => fs.readFileSync(path.join(dir, "runs.jsonl"), "utf8").trim().split("\n").map((l) => ({ ...JSON.parse(l), dir })));
// The runner records whether a page of the task's sites came to the front (activeTabChanged); records
// from before it knew the public sites are checked against the local pages' ports.
const tookTab = (r) => (typeof r.activeTabChanged === "boolean" ? r.activeTabChanged : (r.activeTabs ?? []).some((url) => /:4790[12]\//.test(url)));
const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// A fixed seed makes the intervals reproducible from the same runs.
let seed = 0x9e3779b9;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const resample = (xs) => xs.map(() => xs[Math.floor(random() * xs.length)]);
const BOOTSTRAP_ROUNDS = 5000;
// 95% percentile interval of a statistic over resamples of one or two samples.
function interval(statistic, ...samples) {
  if (samples.some((xs) => xs.length < 2)) return null;
  const values = [];
  for (let i = 0; i < BOOTSTRAP_ROUNDS; i++) {
    const value = statistic(...samples.map(resample));
    if (Number.isFinite(value)) values.push(value);
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)], values[Math.ceil(values.length * 0.975) - 1]];
}
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
      secondsInterval: interval(median, ok.map((r) => r.wallMs / 1000)),
      medianSecondsAllRuns: median(rs.map((r) => r.wallMs / 1000)),
      interrupted: rs.filter((r) => r.interrupted).length,
      allSeconds: rs.map((r) => Math.round(r.wallMs / 100) / 10),
      // Claude Code reports the time of its API calls; the rest of its duration is spent elsewhere.
      medianSecondsOutsideApi: median(ok.filter((r) => r.durationMs && r.apiMs).map((r) => Math.max(0, r.durationMs - r.apiMs) / 1000)),
      costInterval: interval(median, ok.map((r) => r.costUsd).filter((c) => typeof c === "number")),
      medianTurns: median(ok.map((r) => r.turns)),
      medianCostUsd: median(ok.map((r) => r.costUsd)),
      medianInputTokens: median(ok.map((r) => r.inputTokens)),
      medianOutputTokens: median(ok.map((r) => r.outputTokens)),
      tabTaken: rs.filter(tookTab).length,
      browserCameForward: rs.filter((r) => r.browserCameForward).length,
    }];
  }));
  // Ratio of the Bruse median time to another tool's over repetitions in which both passed, with an
  // interval from resampling those pairs.
  const ratios = Object.fromEntries(tools.filter((tool) => tool !== "bruse").map((tool) => {
    const byRep = (name) => new Map(runs.filter((r) => r.task === t.id && r.tool === name && r.ok).map((r) => [`${r.dir}#${r.rep}`, r.wallMs]));
    const own = byRep("bruse");
    const other = byRep(tool);
    const pairs = [...own.keys()].filter((rep) => other.has(rep)).map((rep) => [own.get(rep), other.get(rep)]);
    const ratio = (sample) => median(sample.map(([a]) => a)) / median(sample.map(([, b]) => b));
    return [tool, interval(ratio, pairs)];
  }));
  return { task: t.id, title: t.title, kind: t.kind, ...byTool, timeRatioInterval: ratios };
});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (a, b) => (a && b ? `${Math.round((1 - a / b) * 100)}%` : "–");
  for (const s of summary) {
    console.log(`\n${s.title} [${s.kind}]`);
    for (const tool of tools) {
      const v = s[tool];
      const range = (r, digits) => (r ? ` [${r[0].toFixed(digits)}–${r[1].toFixed(digits)}]` : "");
      console.log(`  ${tool.padEnd(7)} ${v.passed}/${v.runs} ok${v.interrupted ? ` (${v.interrupted} interrupted)` : ""}  median ${v.medianSeconds?.toFixed(1) ?? "–"} s${range(v.secondsInterval, 1)} (all runs ${v.medianSecondsAllRuns?.toFixed(1) ?? "–"} s)  outside API ${v.medianSecondsOutsideApi?.toFixed(1) ?? "–"} s  cost${range(v.costInterval, 3)}  turns ${v.medianTurns ?? "–"}  in ${v.medianInputTokens ?? "–"}  out ${v.medianOutputTokens ?? "–"}  $${v.medianCostUsd?.toFixed(3) ?? "–"}  tab taken ${v.tabTaken}/${v.runs}`);
    }
    for (const other of tools.filter((tool) => tool !== "bruse")) {
      if (!s.bruse || !s[other]) continue;
      const ratio = s.timeRatioInterval[other];
      const ratioText = ratio ? ` (95% interval of the time ratio ${ratio[0].toFixed(2)}–${ratio[1].toFixed(2)}${ratio[1] < 1 ? ", Bruse faster" : ratio[0] > 1 ? ", Bruse slower" : ", no clear difference"})` : "";
      console.log(`  bruse vs ${other}: faster by ${pct(s.bruse.medianSeconds, s[other].medianSeconds)}${ratioText}, cheaper by ${pct(s.bruse.medianCostUsd, s[other].medianCostUsd)}, input tokens lower by ${pct(s.bruse.medianInputTokens, s[other].medianInputTokens)}`);
      console.log(`  all times, s: bruse ${s.bruse.allSeconds.join(", ")} | ${other} ${s[other].allSeconds.join(", ")}`);
    }
  }
}
