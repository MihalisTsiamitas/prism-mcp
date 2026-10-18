#!/usr/bin/env node
/**
 * prism-mcp — MCP server for GraphPad Prism on Windows.
 *
 * Prism has no API. What exists: the .pzc script language (run via
 * `prism.exe @script.pzc`) and the .pzfx XML file format. This server wraps both,
 * and adds JS descriptive statistics as an independent cross-check.
 *
 * Hard limits inherited from Prism: a script cannot create an analysis. The
 * analysis must already exist in a template file made once in the Prism GUI.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { describe, closeEnough } from "./lib/stats.js";
import { readPzfx, buildColumnPzfx } from "./lib/pzfx.js";
import {
  PRISM_EXE,
  WORK_ROOT,
  winPath,
  newRunDir,
  runPrismScript,
  collectOutputs,
} from "./lib/runner.js";

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true });

const columnSchema = z.object({
  title: z.string().describe("Column title, e.g. 'Control'"),
  values: z.array(z.union([z.number(), z.null()])).describe("Replicate values; null = missing"),
});

const server = new McpServer({ name: "prism-mcp", version: "1.0.0" });

/* ---------------------------------------------------------------- status */

server.tool(
  "prism_status",
  "Check that prism.exe exists and where run folders are written. Does not start Prism.",
  {},
  async () => {
    const exists = fs.existsSync(PRISM_EXE);
    return ok({
      prism_exe: PRISM_EXE,
      prism_exe_exists: exists,
      work_root: WORK_ROOT,
      notes: [
        "Scripts run as `prism.exe @script.pzc`; completion is detected by a sentinel file.",
        "Prism must be licensed/activated, otherwise the licence dialog blocks every script.",
        "A script cannot create an analysis: keep analyses in a template .pzfx made in the GUI.",
      ],
    });
  }
);

/* ------------------------------------------------------------ describe */

server.tool(
  "stats_describe",
  "Descriptive statistics in JS (no Prism needed): n, mean, SD (sample, n-1), SEM, CV%, " +
    "variance, min, Q1, median, Q3, max, range, sum. Same definitions as Prism's Descriptive statistics.",
  { columns: z.array(columnSchema).min(1) },
  async ({ columns }) => ok(columns.map((c) => ({ title: c.title, ...describe(c.values) })))
);

/* ---------------------------------------------------------- pzfx read */

server.tool(
  "prism_read_pzfx",
  "Read the data tables of a .pzfx file (titles, columns, values). Analysis results inside " +
    ".pzfx are encoded by Prism, so they are only listed, not returned.",
  { file: z.string().describe("Path to a .pzfx file") },
  async ({ file }) => {
    if (!fs.existsSync(file)) return fail(`file not found: ${file}`);
    try {
      return ok(readPzfx(file));
    } catch (e) {
      return fail(e.message);
    }
  }
);

/* --------------------------------------------------------- pzfx write */

server.tool(
  "prism_write_column_table",
  "Write a new .pzfx with one Column data table (one Y column per group). Open it in Prism, " +
    "add Analyze > Descriptive statistics once, save, and it becomes a template for prism_descriptive_stats.",
  {
    file: z.string().describe("Output .pzfx path"),
    table_title: z.string().default("Data 1"),
    columns: z.array(columnSchema).min(1),
    overwrite: z.boolean().default(false),
  },
  async ({ file, table_title, columns, overwrite }) => {
    if (!file.toLowerCase().endsWith(".pzfx")) return fail("file must end with .pzfx");
    if (fs.existsSync(file) && !overwrite) return fail(`${file} exists (pass overwrite=true)`);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, buildColumnPzfx(table_title, columns), "utf8");
    return ok({ written: path.resolve(file), columns: columns.length });
  }
);

/* ------------------------------------------------------------- open */

server.tool(
  "prism_open",
  "Open a file in the Prism GUI (for the user to look at, or to build a template). Returns immediately.",
  { file: z.string().optional().describe("File to open; omit to just start Prism") },
  async ({ file }) => {
    if (!fs.existsSync(PRISM_EXE)) return fail(`prism.exe not found at ${PRISM_EXE}`);
    if (file && !fs.existsSync(file)) return fail(`file not found: ${file}`);
    const child = spawn(PRISM_EXE, file ? [winPath(file)] : [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return ok({ started: true, file: file ? winPath(file) : null });
  }
);

/* ------------------------------------------------------- run script */

server.tool(
  "prism_run_script",
  "Run a Prism .pzc script. The server prepends SetPath <run folder> and appends a done-sentinel " +
    "(+ Exit), so relative file names in OpenOutput/Export/Save land in the run folder. Returns " +
    "the text files the script wrote. Script syntax: GoTo D|R|G|L, n · Open/Save · Import · " +
    "InsertData r,c + <DATA>..</DATA> · OpenOutput/WCell/WBlock/WTable/CloseOutput · ExportPDF/PNG ...",
  {
    script: z.string().describe("Prism script body (no SetPath/Exit needed)"),
    timeout_sec: z.number().int().min(5).max(1800).default(120),
    exit_when_done: z
      .boolean()
      .default(true)
      .describe("Close Prism at the end. Set false to inspect the window after a failure."),
  },
  async ({ script, timeout_sec, exit_when_done }) => {
    try {
      const runDir = newRunDir();
      const run = await runPrismScript({
        script,
        runDir,
        timeoutSec: timeout_sec,
        exitWhenDone: exit_when_done,
      });
      return ok({ ...run, outputs: collectOutputs(runDir) });
    } catch (e) {
      return fail(e.message);
    }
  }
);

/* ------------------------------------------------ descriptive stats */

/** Tab-delimited rows for <DATA>; ragged columns padded with empty cells. */
function dataBlock(columns) {
  const rows = Math.max(...columns.map((c) => c.values.length));
  const lines = [];
  for (let r = 0; r < rows; r++) {
    lines.push(columns.map((c) => c.values[r] ?? "").join("\t"));
  }
  return lines.join("\r\n");
}

/** Parse WBlock output: every line -> label (if any non-numeric cell) + numbers. */
function parseBlock(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.split("\t"))
    .filter((cells) => cells.some((c) => c.trim() !== ""))
    .map((cells) => {
      const nums = [];
      const labels = [];
      for (const c of cells) {
        const v = Number(c.trim().replace(",", "."));
        if (c.trim() !== "" && Number.isFinite(v)) nums.push(v);
        else if (c.trim() !== "") labels.push(c.trim());
      }
      return { label: labels.join(" ") || null, values: nums, raw: cells.join("\t") };
    });
}

/** Find the Prism output row that matches a JS statistic for every column. */
function matchRow(rows, jsValues) {
  return rows.find(
    (r) => r.values.length >= jsValues.length && jsValues.every((v, i) => closeEnough(r.values[i], v))
  );
}

server.tool(
  "prism_descriptive_stats",
  "Standard deviation & descriptive statistics. Always computes them in JS. If `template` is given " +
    "(a .pzfx/.pzm whose data table 1 is a Column table and whose results sheet 1 is Descriptive " +
    "statistics), it also runs Prism on the data and cross-checks Prism's SD/mean against JS.",
  {
    columns: z.array(columnSchema).min(1).max(100),
    template: z.string().optional().describe("Template file with the Descriptive statistics analysis"),
    results_sheet: z.number().int().min(1).default(1),
    save_project_as: z.string().optional().describe("Optional .pzfx path to save the filled project"),
    timeout_sec: z.number().int().min(5).max(1800).default(120),
  },
  async ({ columns, template, results_sheet, save_project_as, timeout_sec }) => {
    const js = columns.map((c) => ({ title: c.title, ...describe(c.values) }));
    if (!template) {
      return ok({
        source: "js_only",
        stats: js,
        note: "No template given, so Prism was not run. Make one with prism_write_column_table + Prism GUI.",
      });
    }
    if (!fs.existsSync(template)) return fail(`template not found: ${template}`);

    const runDir = newRunDir();
    const saveAs = save_project_as ? winPath(save_project_as) : "project.pzfx";
    const colList = columns.map((_, i) => i + 1).join(",");
    const script = [
      `Open "${winPath(template)}"`,
      `GoTo D, 1`,
      `ClearTable`,
      `InsertData 1, 1`,
      `<DATA>`,
      dataBlock(columns),
      `</DATA>`,
      `GoTo R, ${results_sheet}`,
      `OpenOutput "prism_results.txt", CLEAR`,
      `WBlock "1-", "${colList}"`,
      `CloseOutput`,
      `Save "${saveAs}"`,
    ].join("\r\n");

    try {
      const run = await runPrismScript({ script, runDir, timeoutSec: timeout_sec, exitWhenDone: true });
      const outFile = path.join(runDir, "prism_results.txt");
      if (!run.completed || !fs.existsSync(outFile)) {
        return ok({ source: "js_only", prism_run: run, stats: js });
      }
      const rows = parseBlock(fs.readFileSync(outFile, "utf8"));
      const sdRow = matchRow(rows, js.map((s) => s.sd));
      const meanRow = matchRow(rows, js.map((s) => s.mean));
      return ok({
        source: "prism+js",
        sd_check: sdRow ? "MATCH: Prism SD equals JS sample SD" : "NO MATCH: no Prism row equals JS SD",
        mean_check: meanRow ? "MATCH" : "NO MATCH",
        stats: js.map((s, i) => ({
          ...s,
          prism_sd: sdRow ? sdRow.values[i] : null,
          prism_mean: meanRow ? meanRow.values[i] : null,
        })),
        prism_rows: rows,
        prism_run: run,
      });
    } catch (e) {
      return ok({ source: "js_only", prism_error: e.message, stats: js });
    }
  }
);

/* ---------------------------------------------------------------- main */

await server.connect(new StdioServerTransport());
