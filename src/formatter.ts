import type { CodeElement } from "./models.ts";

export function formatTable(elements: CodeElement[]): string {
  if (elements.length === 0) return "";

  const headers = ["File", "Element", "Kind", "Line", "Change"] as const;
  const rows = elements.map((e) => [
    e.filePath,
    e.name,
    e.kind,
    String(e.line),
    e.changeType,
  ]);

  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i]!, row[i]!.length);
    }
  }

  const fmtRow = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");

  const lines = [
    fmtRow(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(fmtRow),
  ];

  return lines.join("\n");
}
