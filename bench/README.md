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

Requirements: the Bruse extension and Claude in Chrome in the same Brave profile, and Claude Code signed
in with an account that allows `--chrome` (an API-key or inference-only token does not). The runner opens
and closes tabs in the front Brave window and moves downloaded `raport-q3*.csv` files to the Trash, so do
not use Brave while it runs.
