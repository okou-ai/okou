import { bigint, index, integer, jsonb, pgTable } from "drizzle-orm/pg-core";
import { runnerStateColumns } from "../columns/runner-state";
import type { RunnerHeldWorkspaceStates } from "../jsonb-contracts/runner-state";

// Physical migration ownership only. Applications use runtime/runner-state;
// PR6 drops these retained columns after the canonical application deploy/drain.
export const runnerState = pgTable(
  "runner_state",
  {
    ...runnerStateColumns(),
    heldWorkspaceStates: jsonb("held_workspace_states")
      .$type<RunnerHeldWorkspaceStates>()
      .default([])
      .notNull(),
    homeAffinityVersion: integer("home_affinity_version"),
    homeAffinityGeneration: bigint("home_affinity_generation", {
      mode: "number",
    }),
    homeAffinitySequence: bigint("home_affinity_sequence", { mode: "number" }),
  },
  (table) => {
    return [index("runner_state_group_idx").on(table.runnerGroup)];
  },
);
