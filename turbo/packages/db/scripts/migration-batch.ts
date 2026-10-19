import { parse } from "libpg-query";
import { z } from "zod";

const parsedSelectSchema = z.object({
  stmts: z.tuple([
    z.object({
      stmt: z.object({
        SelectStmt: z.object({
          withClause: z.object({
            ctes: z.array(
              z.object({
                CommonTableExpr: z.object({
                  ctename: z.string(),
                  ctequery: z.unknown(),
                }),
              }),
            ),
          }),
        }),
      }),
    }),
  ]),
});

const batchQuerySchema = z.object({
  SelectStmt: z.object({
    limitCount: z.object({
      A_Const: z.object({
        ival: z.object({ ival: z.number().int().positive() }),
        location: z.number().int().nonnegative(),
      }),
    }),
  }),
});

/** Lower the physical work unit without changing immutable migration sources. */
export async function boundedMigrationBatch(
  statement: string,
): Promise<string> {
  const parsed: unknown = await parse(statement);
  const [{ stmt }] = parsedSelectSchema.parse(parsed).stmts;
  const ctes = stmt.SelectStmt.withClause.ctes;
  const batch = ctes.find(({ CommonTableExpr }) => {
    return CommonTableExpr.ctename === "batch";
  });
  if (!batch) {
    throw new Error("UUID migration requires a batch CTE");
  }
  const { A_Const: limit } = batchQuerySchema.parse(
    batch.CommonTableExpr.ctequery,
  ).SelectStmt.limitCount;
  if (limit.ival.ival <= 100) {
    return statement;
  }
  // PostgreSQL locations are UTF-8 byte offsets, including preceding comments.
  const source = Buffer.from(statement);
  const literal = /^[0-9][0-9_]*/.exec(
    source.subarray(limit.location).toString("utf8"),
  )?.[0];
  if (!literal || Number(literal.replaceAll("_", "")) !== limit.ival.ival) {
    throw new Error("UUID migration batch LIMIT location is invalid");
  }
  return Buffer.concat([
    source.subarray(0, limit.location),
    Buffer.from("100"),
    source.subarray(limit.location + literal.length),
  ]).toString("utf8");
}
