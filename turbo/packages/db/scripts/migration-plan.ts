import {
  array,
  number,
  object,
  record,
  string,
  tuple,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

// EXPLAIN expressions can contain bound values, SQL literals and function bodies.
// Publish only structural identity and numeric measurements, never expressions.
const nodeSchema = object({
  "Node Type": string(),
  "Parent Relationship": string().optional(),
  "Subplan Name": string().optional(),
  "Relation Name": string().optional(),
  "Index Name": string().optional(),
  "CTE Name": string().optional(),
  Operation: string().optional(),
  "Join Type": string().optional(),
  Strategy: string().optional(),
  "Startup Cost": number().optional(),
  "Total Cost": number().optional(),
  "Plan Rows": number().optional(),
  "Plan Width": number().optional(),
  "Actual Startup Time": number().optional(),
  "Actual Total Time": number().optional(),
  "Actual Rows": number().optional(),
  "Actual Loops": number().optional(),
  "Rows Removed by Filter": number().optional(),
  "Rows Removed by Join Filter": number().optional(),
  "Heap Fetches": number().optional(),
  "Shared Hit Blocks": number().optional(),
  "Shared Read Blocks": number().optional(),
  "Shared Dirtied Blocks": number().optional(),
  "Shared Written Blocks": number().optional(),
  "Temp Read Blocks": number().optional(),
  "Temp Written Blocks": number().optional(),
  "I/O Read Time": number().optional(),
  "I/O Write Time": number().optional(),
  "WAL Records": number().optional(),
  "WAL FPI": number().optional(),
  "WAL Bytes": number().optional(),
  Plans: array(zUnknown()).optional(),
});

const resultSchema = tuple([
  object({
    "QUERY PLAN": tuple([
      object({
        Plan: zUnknown(),
        "Planning Time": number(),
        "Execution Time": number(),
        JIT: object({
          Functions: number(),
          Timing: record(string(), number()).optional(),
        }).optional(),
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
    measurements: Omit<zInfer<typeof nodeSchema>, "Plans">;
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
