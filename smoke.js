/**
 * Smoke test over real stdio: list tools, check JS SD against known values,
 * write a .pzfx and read it back. Prism itself is only touched if
 * SMOKE_RUN_PRISM=1 (it needs an activated licence).
 */
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const client = new Client({ name: "smoke", version: "1" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(here, "index.js")] })
);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const columns = [
  { title: "A", values: [2, 4, 4, 4, 5, 5, 7, 9] },
  { title: "B", values: [10, 11, 12, 13, 14, 15, 16, 17] },
  { title: "C", values: [3, 5, 7, 9, 11, 13, 15, null] },
];
const expectedSd = { A: 2.13809, B: 2.44949, C: 4.32049 };

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
check("7 tools listed", tools.length === 7);

const status = await call("prism_status");
check("prism.exe exists", status.prism_exe_exists);

const stats = await call("stats_describe", { columns });
for (const s of stats) {
  check(`SD ${s.title} = ${s.sd.toFixed(5)} (expected ${expectedSd[s.title]})`,
    Math.abs(s.sd - expectedSd[s.title]) < 1e-4);
}
check("missing value skipped (C n=7)", stats[2].n === 7);

const file = path.join(process.env.TEMP, "prism-mcp-smoke.pzfx");
await call("prism_write_column_table", { file, columns, overwrite: true });
const back = await call("prism_read_pzfx", { file });
const t = back.tables[0];
check("pzfx round trip: 3 Y columns", t.y_columns.length === 3);
check("pzfx round trip: titles", t.y_columns.map((c) => c.title).join() === "A,B,C");
check("pzfx round trip: A values", t.y_columns[0].subcolumns[0].join() === "2,4,4,4,5,5,7,9");
check("pzfx round trip: C missing cell kept", t.y_columns[2].subcolumns[0].length === 8);
check("table type OneWay", t.table_type === "OneWay");

const jsOnly = await call("prism_descriptive_stats", { columns });
check("descriptive_stats without template = js_only", jsOnly.source === "js_only");

if (process.env.SMOKE_RUN_PRISM === "1") {
  const run = await call("prism_run_script", {
    script: `Open "${file.replace(/\//g, "\\")}"\r\nGoTo D, 1\r\nOpenOutput "data.txt", CLEAR\r\nWBlock "1-", "1,2,3"\r\nCloseOutput`,
    timeout_sec: 90,
  });
  console.log(JSON.stringify(run, null, 2));
  check("Prism ran the script to the end", run.completed);
}

fs.unlinkSync(file);
await client.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
