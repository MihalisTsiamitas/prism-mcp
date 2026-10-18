/**
 * Read and write Prism .pzfx (XML) data tables.
 *
 * Reading: data tables only. Analysis results in .pzfx are encoded, so they are
 * listed by name but their values are not returned.
 * Writing: a Column table (TableType="OneWay"), the same structure the R `pzfx`
 * package writes and Prism opens.
 */
import fs from "node:fs";
import { XMLParser } from "fast-xml-parser";

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Text of a <d> cell, which may hold nested formatting tags. */
function cellText(d) {
  if (d === null || d === undefined) return "";
  if (typeof d === "string" || typeof d === "number") return String(d);
  if (typeof d === "object") {
    if ("#text" in d) return String(d["#text"]);
    return Object.values(d).map(cellText).join("");
  }
  return "";
}

function columnValues(col) {
  // A column has one <Subcolumn> per replicate; each holds <d> cells
  return asArray(col?.Subcolumn).map((sub) => asArray(sub?.d).map(cellText));
}

function titleOf(node) {
  return cellText(node?.Title).trim();
}

export function readPzfx(file) {
  const xml = fs.readFileSync(file, "utf8");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name) => ["Table", "YColumn", "Subcolumn", "d", "Ref"].includes(name),
  });
  const root = parser.parse(xml)?.GraphPadPrismFile;
  if (!root) throw new Error(`${file} is not a Prism XML file (no <GraphPadPrismFile> root)`);

  const tables = asArray(root.Table).map((t) => {
    const ys = asArray(t.YColumn).map((c) => ({
      title: titleOf(c),
      subcolumns: columnValues(c),
    }));
    return {
      id: t["@ID"],
      title: titleOf(t),
      table_type: t["@TableType"] ?? null,
      x_format: t["@XFormat"] ?? null,
      y_format: t["@YFormat"] ?? null,
      row_titles: t.RowTitlesColumn ? columnValues(t.RowTitlesColumn)[0] ?? [] : [],
      x_column: t.XColumn ? columnValues(t.XColumn)[0] ?? [] : [],
      y_columns: ys,
    };
  });

  const analyses = asArray(root.HugeTable ?? root.HugeResults).map((h) => ({
    id: h["@ID"],
    title: titleOf(h),
  }));

  return {
    created_by: root.Created?.OriginalVersion?.["@CreatedByVersion"] ?? null,
    tables,
    analyses_listed_only: analyses,
  };
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Build a Column-table .pzfx. columns = [{ title, values: number[] }].
 */
export function buildColumnPzfx(tableTitle, columns) {
  const now = new Date().toISOString().slice(0, 19);
  const cols = columns
    .map(
      (c) => `<YColumn Width="120" Decimals="2" Subcolumns="1">
<Title>${esc(c.title)}</Title>
<Subcolumn>
${c.values.map((v) => (v === null || v === "" ? "<d/>" : `<d>${esc(v)}</d>`)).join("\n")}
</Subcolumn>
</YColumn>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<GraphPadPrismFile xmlns="http://graphpad.com/prism/Prism.htm" PrismXMLVersion="5.00">
<Created>
<OriginalVersion CreatedByProgram="GraphPad Prism" CreatedByVersion="10.6.1.892" Login="prism-mcp" DateTime="${now}"/>
</Created>
<InfoSequence>
</InfoSequence>
<TableSequence>
<Ref ID="Table0" Selected="1"/>
</TableSequence>
<Table ID="Table0" XFormat="none" TableType="OneWay" EVFormat="AsteriskAfterNumber">
<Title>${esc(tableTitle)}</Title>
${cols}
</Table>
</GraphPadPrismFile>
`;
}
