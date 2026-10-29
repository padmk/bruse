# Benchmark

Compares Bruse with Claude in Chrome on the same tasks: Claude Code in print mode (`claude -p`), the same
model, effort and prompts, and only the browser tool differs. Bash, WebFetch, Read and the other file
tools are denied, so the browser is the only way to the answer; the download task allows Read and Glob,
which Claude Code normally has, to open the downloaded file.

- `server.mjs`: deterministic task pages on two origins (`127.0.0.1:47901` and, for the cross-origin
  payment frame, `localhost:47902`). Form submissions, payments and page sessions are kept in memory and
  read back through `/api/log`.
- `tasks.mjs`: prompts and graders. A grader checks the final answer and, where a task submits data,
  the server log. `timed` tasks are repeated for timing; `capability` tasks test whether a tool can do
  something at all.
- `run.mjs`: runs every task with each tool, alternating which tool goes first. It records wall time,
  turns, cost, the answer, whether it passed, and which URLs became the active tab of the front browser
  window during the run. It stops when the account reaches its usage limit.
- `report.mjs`: per task and tool, the pass count, median time, turns and cost of passed runs, and how
  often a benchmark page took over the user's active tab.

```sh
node bench/run.mjs --reps 5 --capability-reps 3     # all tasks, both tools
node bench/run.mjs --tasks table,form --reps 3       # a subset
node bench/report.mjs bench/results/<timestamp>     # summary; pass several directories to combine runs
```

## Published results

`results/2026-10-24-published` (sources in `NOTES.md`): claude-opus-5-5, effort medium, median of the
passed runs out of 5 per timed task, 3 per capability task.

| Task | Bruse | Claude in Chrome | Bruse faster | Bruse cheaper |
| --- | --- | --- | --- | --- |
| Header of a large page | 7.9 s, 5/5 | 23.2 s, 5/5 | 66% | 26% |
| Sum from a 250-row table | 14.6 s, 5/5 | 32.9 s, 5/5 | 56% | 44% |
| Three-step form | 17.7 s, 5/5 | 59.3 s, 5/5 | 70% | 72% |
| Catalog search with pagination | 18.7 s, 5/5 | 54.2 s, 5/5 | 66% | 63% |
| QA with the console | 32.5 s, 5/5 | 113.0 s, 5/5 | 71% | 81% |
| Form in a cross-origin frame | 10.7 s, 5/5 | 80.8 s, 4/5 | 87% | 88% |
| Download and read a file | 12.1 s, 5/5 | 37.0 s, 5/5 | 67% | 77% |
| Read a tab the user opened earlier | 3/3 | 0/3 | | |

Neither tool brought a benchmark page into the user's active tab.

Requirements: the Bruse extension and Claude in Chrome in the same Brave profile, and Claude Code signed
in with an account that allows `--chrome` (an API-key or inference-only token does not). The runner opens
and closes tabs in the front Brave window and moves downloaded `raport-q3*.csv` files to the Trash, so do
not use Brave while it runs.

## Codex

`node bench/run.mjs --agent codex --model <model> --effort <effort>` runs the same tasks in `codex exec`
with Bruse against the browser use bundled with the ChatGPT app (`--tools bruse,openai`). Codex's own
browser plugin needs the app as its host, so the runner points it at a bridge to that runtime
(`OPENAI_CUA_BRIDGE`, by default `~/dev/brave-cua-mcp/src/server.mjs`); both tools drive the same Brave.
Apps, web search and the other REPLs are disabled and the sandbox is read-only. Codex reports tokens, not
cost; input tokens include cached ones.

Median of the passed runs out of 3, `2026-10-28T23-33-32-618Z` (gpt-6.1-sol, effort low) and
`2026-10-28T23-49-24-770Z` (gpt-6.1-terra, effort medium):

| Task | Sol: Bruse | Sol: OpenAI | Terra: Bruse | Terra: OpenAI |
| --- | --- | --- | --- | --- |
| Header of a large page | 11.4 s, 104k, 3/3 | 17.0 s, 149k, 3/3 | 8.3 s, 103k, 3/3 | 9.4 s, 113k, 3/3 |
| Sum from a 250-row table | 17.7 s, 152k, 3/3 | 17.7 s, 120k, 3/3 | 12.4 s, 152k, 3/3 | 12.1 s, 115k, 3/3 |
| Three-step form | 19.8 s, 177k, 3/3 | 32.5 s, 347k, 1/3 | 26.5 s, 347k, 3/3 | 0/3 |
| Catalog search with pagination | 31.2 s, 323k, 3/3 | 28.9 s, 261k, 3/3 | 17.8 s, 238k, 3/3 | 18.7 s, 215k, 3/3 |
| QA with the console | 22.0 s, 177k, 3/3 | 34.1 s, 358k, 3/3 | 23.0 s, 316k, 3/3 | 25.0 s, 385k, 3/3 |
| Form in a cross-origin frame | 16.7 s, 113k, 3/3 | 18.1 s, 143k, 3/3 | 10.0 s, 122k, 3/3 | 13.1 s, 142k, 3/3 |
| Download and read a file | 19.1 s, 156k, 3/3 | 0/3 | 12.6 s, 149k, 2/3 | 0/3 |

The OpenAI tool's failures are its policies, not errors: it stops before accepting the form's terms to
ask the user again although the prompt gave consent, and its permission check refuses the download. In
an interactive session the user would answer those prompts. The failed Bruse download run is the model
answering without calling a tool.
