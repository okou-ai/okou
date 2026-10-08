// Source-text SQL rules do not need a JavaScript AST. Keep the original source
// and locations without pretending to validate PostgreSQL syntax.
export const sqlSourceParser = {
  meta: { name: "okou-sql-source", version: "1.0.0" },
  parseForESLint(source: string) {
    const lines = source.split(/\r\n|\r|\n/u);
    return {
      ast: {
        type: "Program" as const,
        body: [],
        sourceType: "module" as const,
        range: [0, source.length] as [number, number],
        loc: {
          start: { line: 1, column: 0 },
          end: { line: lines.length, column: lines[lines.length - 1].length },
        },
        tokens: [],
        comments: [],
      },
    };
  },
};
