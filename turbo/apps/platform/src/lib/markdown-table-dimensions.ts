import type { Element, ElementContent } from "hast";

function isTableRow(node: ElementContent): node is Element {
  return node.type === "element" && node.tagName === "tr";
}

export function getMarkdownTableDimensions(table: Element) {
  const groups = [{ header: false, rows: table.children.filter(isTableRow) }];
  for (const section of table.children) {
    if (
      section.type === "element" &&
      ["thead", "tbody", "tfoot"].includes(section.tagName)
    ) {
      groups.push({
        header: section.tagName === "thead",
        rows: section.children.filter(isTableRow),
      });
    }
  }

  let rowCount = 0;
  let columnCount = 0;
  for (const group of groups) {
    // Row spans are bounded by their section, including rowspan="0".
    let rowSpans: number[] = [];
    for (const [rowIndex, row] of group.rows.entries()) {
      const cells = row.children.filter((child): child is Element => {
        return (
          child.type === "element" &&
          (child.tagName === "th" || child.tagName === "td")
        );
      });
      const header =
        group.header ||
        cells.every((cell) => {
          return (
            cell.tagName === "th" &&
            cell.properties.scope !== "row" &&
            cell.properties.scope !== "rowgroup"
          );
        });
      if (!header) {
        rowCount++;
      }

      let column = 0;
      for (const cell of cells) {
        while ((rowSpans[column] ?? 0) > 0) {
          column++;
        }
        const colSpan = Math.min(
          1000,
          Math.max(1, Math.trunc(Number(cell.properties.colSpan)) || 1),
        );
        const rawRowSpan = Number(cell.properties.rowSpan ?? 1);
        const rowSpan =
          rawRowSpan === 0
            ? group.rows.length - rowIndex
            : Math.min(65_534, Math.max(1, Math.trunc(rawRowSpan) || 1));
        for (let offset = 0; offset < colSpan; offset++) {
          rowSpans[column + offset] = Math.max(
            rowSpans[column + offset] ?? 0,
            rowSpan,
          );
        }
        column += colSpan;
      }
      columnCount = Math.max(columnCount, rowSpans.length);
      rowSpans = rowSpans.map((remaining) => {
        return Math.max(0, remaining - 1);
      });
    }
  }
  return { rows: rowCount, columns: columnCount };
}
