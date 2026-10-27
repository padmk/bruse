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
