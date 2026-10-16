import { z } from "zod";

// EXPLAIN expressions can contain bound values, SQL literals and function bodies.
// Publish only structural identity and numeric measurements, never expressions.
const nodeSchema = z.object({
  "Node Type": z.string(),
  "Parent Relationship": z.string().optional(),
  "Subplan Name": z.string().optional(),
  "Relation Name": z.string().optional(),
  "Index Name": z.string().optional(),
  "CTE Name": z.string().optional(),
  Operation: z.string().optional(),
  "Join Type": z.string().optional(),
  Strategy: z.string().optional(),
  "Startup Cost": z.number().optional(),
  "Total Cost": z.number().optional(),
  "Plan Rows": z.number().optional(),
  "Plan Width": z.number().optional(),
  "Actual Startup Time": z.number().optional(),
  "Actual Total Time": z.number().optional(),
  "Actual Rows": z.number().optional(),
  "Actual Loops": z.number().optional(),
  "Rows Removed by Filter": z.number().optional(),
  "Rows Removed by Join Filter": z.number().optional(),
  "Heap Fetches": z.number().optional(),
  "Shared Hit Blocks": z.number().optional(),
  "Shared Read Blocks": z.number().optional(),
  "Shared Dirtied Blocks": z.number().optional(),
  "Shared Written Blocks": z.number().optional(),
  "Temp Read Blocks": z.number().optional(),
  "Temp Written Blocks": z.number().optional(),
  "I/O Read Time": z.number().optional(),
  "I/O Write Time": z.number().optional(),
  "WAL Records": z.number().optional(),
  "WAL FPI": z.number().optional(),
  "WAL Bytes": z.number().optional(),
  Plans: z.array(z.unknown()).optional(),
});

const resultSchema = z.tuple([
  z.object({
    "QUERY PLAN": z.tuple([
      z.object({
        Plan: z.unknown(),
        "Planning Time": z.number(),
        "Execution Time": z.number(),
        JIT: z
          .object({
            Functions: z.number(),
            Timing: z.record(z.string(), z.number()).optional(),
          })
          .optional(),
      }),
    ]),
  }),
]);

export function summarizeMigrationPlan(rows: unknown) {
  const [
    {
      "QUERY PLAN": [result],
    },
  ] = resultSchema.parse(rows);
  const nodes: {
    parent: number | null;
    measurements: Omit<z.infer<typeof nodeSchema>, "Plans">;
  }[] = [];
  const pending: { parent: number | null; value: unknown }[] = [
    { parent: null, value: result.Plan },
  ];
  for (const next of pending) {
    const { Plans: children, ...measurements } = nodeSchema.parse(next.value);
    const parent = nodes.length;
    nodes.push({ parent: next.parent, measurements });
    for (const value of children ?? []) {
      pending.push({ parent, value });
    }
  }
  return {
    planningMs: result["Planning Time"],
    executionMs: result["Execution Time"],
    jit: result.JIT,
    nodes,
  };
}
