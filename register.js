/**
 * Register prism-mcp in both config files, the same way hellas-gov was registered.
 * Forward slashes everywhere: Windows accepts them and they survive shell quoting.
 */
import fs from "node:fs";
import path from "node:path";

const NAME = "prism";
const entry = {
  command: "C:/Program Files/nodejs/node.exe",
  args: ["C:/Users/mtsiamitas/Documents/prism-mcp/index.js"],
};

const targets = [
  path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json"),
  "C:/Users/mtsiamitas/.claude.json",
];

for (const file of targets) {
  if (!fs.existsSync(file)) {
    console.log("SKIP (missing):", file);
    continue;
  }
  const raw = fs.readFileSync(file, "utf8");
  const cfg = JSON.parse(raw);
  fs.writeFileSync(file + ".bak-prism", raw, "utf8");
  cfg.mcpServers = cfg.mcpServers || {};
  const existed = Boolean(cfg.mcpServers[NAME]);
  cfg.mcpServers[NAME] = entry;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`${existed ? "UPDATED" : "ADDED"}: ${NAME} in ${file}`);
}
