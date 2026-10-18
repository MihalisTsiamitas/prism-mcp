# prism-mcp

MCP server for GraphPad Prism on Windows. Prism has no API; this wraps what exists:
the `.pzc` script language (`prism.exe @script.pzc`) and the `.pzfx` XML file format,
plus JS descriptive statistics as an independent cross-check.

## Tools

| Tool | What it does |
|---|---|
| `prism_status` | Where `prism.exe` is, where run folders go |
| `stats_describe` | n, mean, SD (n-1), SEM, CV%, variance, min, Q1, median, Q3, max, range, sum, all in JS |
| `prism_read_pzfx` | Data tables of a `.pzfx` (analysis results are encoded by Prism, listed only) |
| `prism_write_column_table` | New `.pzfx` with a Column table |
| `prism_open` | Open a file in the Prism GUI |
| `prism_run_script` | Run a `.pzc` script, return the text files it wrote |
| `prism_descriptive_stats` | SD & co. in JS; with a template, also via Prism with a cross-check |

## Setup

```bash
npm install
node smoke.js            # tests without Prism
SMOKE_RUN_PRISM=1 node smoke.js   # also runs Prism (needs a licence)
node register.js         # adds "prism" to Claude Desktop + Claude Code configs
```

Environment overrides: `PRISM_EXE`, `PRISM_MCP_WORKDIR`.

## Prism behaviours this works around

- **Scripts can't create analyses.** Make a template once in the GUI (Column table +
  Analyze > Descriptive statistics, save as `.pzfx`) and pass it as `template`.
- **Single instance.** With Prism already open, `@script` runs inside that window, so
  the server then never sends `Exit` and never kills Prism.
- **Version hand-off.** Launching an older Prism hands off to the newest installed one
  and drops the `@script` argument, so the newest exe is used first.
- **Unlicensed = viewer mode**, which can't run scripts. It shows in the log the first
  time and afterwards only in the window title; the runner checks both and fails fast.
