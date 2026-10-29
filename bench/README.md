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
- `transcript.mjs`: reads a run's conversation. A Claude Code run passes only when the grader accepts
  the answer and the conversation shows that the browser produced it: at least one call of the browser
  tool, a connected extension, and no Bruse code that reached files, the network or processes from
  Node.js (`fetch`, imports, `child_process`), which could get a page without the browser. Such a run is
  recorded with `failure` set to `left-browser`, `extension-missing` or `no-browser-call`. The page
  function passed to `evaluate()` runs in the page and is left out of that check; the transcript stays
  the evidence to read. The time spent inside tool calls is recorded too.
- `grading.mjs`: the number rule both suites grade with: every number in the answer, apart from the ones
  the question names, must be the expected value.
- `report.mjs`: per task and tool, the pass count, median time, turns and cost of passed runs, the time
  inside tool calls, the runs whose right answer did not come from the browser, and how often a
  benchmark page took over the user's active tab.

Before the runs, the runner asks the browser for its extension's code fingerprint, reloads the
extension once if it is not this checkout's code, and stops if it still is not; `meta.json` records the
commit, the agent's and Node's versions, the browser and the fingerprint. A dirty working tree runs only
with `--allow-dirty`.

```sh
node bench/run.mjs --reps 5 --capability-reps 3     # all tasks, both tools
node bench/run.mjs --tasks table,form --reps 3       # a subset
node bench/run.mjs --suite real --reps 8            # tasks on public websites (tasks-real.mjs)
node bench/report.mjs bench/results/<timestamp>     # summary; pass several directories to combine runs
```

The local pages include a three-step form, an order form whose rules only the server knows (it
rejects the postal code's format and then the quantity until the agent corrects them from its
messages) and a bar chart drawn on a canvas, whose values are not in the page's text.

`tasks-real.mjs` holds tasks on public websites: Wikipedia's site search, a GitHub directory listing and
releases page, the Python documentation's search, a paginated shop (books.toscrape.com) and a
single-page app (TodoMVC). None needs a password, because Claude in Chrome declines to type one on
public sites. Every run's conversation goes to `transcripts/` next to `runs.jsonl`.

## What the numbers cover

Results describe the tasks and setup measured, not typical work in general. Every run starts a new
agent process (`claude -p` or `codex exec`), so it includes starting the MCP server and connecting it to
the browser, which takes under a second; a long interactive session does not pay that per task, and
the runner does not measure it separately. No task asks to solve a CAPTCHA or to type a password; a
step that needs the user is reported as a failure of that run. Both tools run in the same Brave profile.

## Results on public websites (2026-10-29)

`results/2026-10-29T17-28-51-255Z`: commit `c6f4daa`, whose code is this history's before the element-number
fix described below (the history was squashed afterwards), the extension's code fingerprint confirmed
equal to the checkout's, claude-opus-5-5, effort medium, 8 runs per task and tool, alternating which tool went
first, Brave 156 on one Mac. Median time and pass count, how much less time and money the median Bruse
run took, and the 95 % bootstrap interval of the Bruse/Claude in Chrome time ratio over paired runs:

| Task | Bruse | Claude in Chrome | Less time (ratio interval) | Less money |
| --- | --- | --- | --- | --- |
| Wikipedia: site search and infobox | 15.1 s, 8/8 | 37.7 s, 8/8 | 60 % (0.27 to 0.49) | 47 % |
| GitHub: .js files in a folder | 10.4 s, 8/8 | 20.2 s, 8/8 | 48 % (0.31 to 0.85) | 56 % |
| GitHub: a release's date | 10.3 s, 8/8 | 20.8 s, 8/8 | 51 % (0.34 to 0.79) | 61 % |
| Python documentation search | 18.6 s, 8/8 | 58.7 s, 8/8 | 68 % (0.26 to 0.39) | 68 % |
| Paginated shop, counting by rating | 8.9 s, 8/8 | 17.3 s, 8/8 | 48 % (0.30 to 0.63) | 38 % |
| Single-page app (TodoMVC) | 13.0 s, 8/8 | 37.9 s, 8/8 | 66 % (0.27 to 0.50) | 74 % |

All 96 runs together took 633 s and $6.03 with Bruse and 1,534 s and $13.63 with Claude in Chrome. Every
transcript was read for the checks: each Bruse run used only its `js` tool (21 calls ran page code
through `evaluate()`, none reached a page from Node.js) and each Claude in Chrome run used its browser
tools. Starting the agent and connecting took a median 0.9 s (Bruse) and 0.7 s; the three runs slower
than twice their median spent the extra time in the model's API, not in tool calls.

Four Bruse Wikipedia runs lost a turn: the agent read the page twice, Wikipedia replaced its search field
in between, and the agent typed into the field's number from the first read. An element number from an
earlier read of the same page now leads to the element that replaced it; four runs on the fixed code
(`results/2026-10-29T18-17-28-608Z`) took 7.4, 7.9, 9.3 and 20.0 s, all in 3 turns, the 20 s run waiting
on the API.

The local tasks added for the review, 3 runs each (`results/2026-10-29T18-08-41-139Z`): the order the
server rejects took a median 17.3 s with Bruse and 32.5 s with Claude in Chrome (ratio interval 0.45 to
0.58), the canvas chart 8.3 s and 17.0 s (0.37 to 0.70), all passing; Bruse read the chart from a
screenshot. In the existing-tab task both tools answered that they have no access to the tab the user
did not share; the first two Claude in Chrome runs were graded against the earlier expectation that it
reads the tab and were run again with the corrected grader (`results/2026-10-29T18-14-25-331Z`, from a
working tree with that one change).

What this does not show: other computers, browsers or memory pressure (the review's 90 to 99 % RAM was
not reproduced), other models, signed-in work, or the cause of the review's 24 to 162 s runs, whose
conversations were not recorded. Transcripts stay out of the repository because they list the local
agent setup and paths; `runs.jsonl` and `meta.json` are complete.

## Earlier results on the benchmark's pages

`results/2026-10-24-published` (sources in `NOTES.md`): Bruse 0.17.0, claude-opus-5-5, effort medium,
median of the passed runs out of 5 per timed task, 3 per capability task. These are the benchmark's own
pages, which favor short scripted tasks, and the set combines sessions: the Bruse runs are the ones
measured after the fixes in `cc77dc1` (earlier Bruse runs are in other folders under `results/`), and
Claude in Chrome's runs for four tasks are from the day before. They were graded with the earlier, more
lenient number rule; regrading them with `grading.mjs` changes none.

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

These results come from Bruse 0.17.0, which let agents use every tab. Since then Bruse keeps a tab the
user did not share out of agents' reach by default, and Claude in Chrome sees only its own tab group, so
the `existing-tab` task now expects both tools to answer "brak dostępu" (no access) without loading the
page again; reading the tab takes the user's **Share this tab** in Bruse's popup, which the runner does
not click.

Requirements: the Bruse extension and Claude in Chrome in the same Brave profile, and Claude Code signed
in with an account that allows `--chrome` (an API-key or inference-only token does not). The runner opens
and closes tabs in the front Brave window and moves downloaded `raport-q3*.csv` files to the Trash, so do
not use Brave while it runs.

## Codex

`node bench/run.mjs --agent codex --model <model> --effort <effort>` runs the same tasks in `codex exec`
with Bruse against the browser use bundled with the ChatGPT app (`--tools bruse,openai`). Codex's own
browser plugin needs the app as its host, so the runner points it at a bridge to that runtime
(`--openai-bridge`, by default `~/dev/brave-cua-mcp/src/server.mjs`); both tools drive the same Brave.
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
