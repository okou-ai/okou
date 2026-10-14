import { computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runStartupContract } from "@okouai/api-contracts/contracts/run-routes";
import { sandboxStartupPathSchema } from "@okouai/api-contracts/contracts/runner-primitives";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import {
  getDatasetName,
  queryAxiomFor,
  type AxiomQueryRequest,
} from "../external/axiom";
import type { RouteEntry } from "../route-entry";

const CLOCK_SKEW_PADDING_MS = 60_000;
const observationSchema = z.object({
  runner_startup_path: sandboxStartupPathSchema,
});

const startupRun$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { id } = get(pathParamsOf(runStartupContract.getStartup));
  const [run] = await get(db$)
    .select({
      id: agentRuns.id,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, id),
        eq(agentRuns.userId, auth.userId),
        eq(agentRuns.orgId, auth.orgId),
      ),
    )
    .limit(1);
  return run ?? null;
});

const startupQuery$ = computed(
  async (get): Promise<AxiomQueryRequest | null> => {
    const run = await get(startupRun$);
    if (run === null || run.startedAt === null) {
      return null;
    }
    const startTime = new Date(
      run.startedAt.getTime() - CLOCK_SKEW_PADDING_MS,
    ).toISOString();
    const endTime = new Date(
      (run.completedAt ?? nowDate()).getTime() + CLOCK_SKEW_PADDING_MS,
    ).toISOString();
    const paths = sandboxStartupPathSchema.options
      .map((path) => {
        return JSON.stringify(path);
      })
      .join(", ");
    return {
      apl: `['${getDatasetName("sandbox-op-log")}']
| where _time >= datetime("${startTime}") and _time < datetime("${endTime}")
| where run_id == ${JSON.stringify(run.id)}
| where source == "sandbox" and sandbox_type == "runner"
| where op_type == "runner_agent_start_to_ready" and success == true
| where runner_startup_path in (${paths})
| order by _time desc
| project runner_startup_path
| limit 1`,
      options: { startTime, endTime, noCache: true, format: "tabular" },
    };
  },
);

const startupObservations$ = queryAxiomFor(startupQuery$);
const getRunStartupInner$ = computed(async (get) => {
  const run = await get(startupRun$);
  if (run === null) {
    return notFound("Agent run not found");
  }
  const observations = await get(startupObservations$);
  return {
    status: 200 as const,
    body: {
      sandboxStartupPath:
        observations[0] === undefined
          ? null
          : observationSchema.parse(observations[0]).runner_startup_path,
    },
  };
});

export const runStartupRoutes: readonly RouteEntry[] = [
  {
    route: runStartupContract.getStartup,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent-run:read",
      },
      getRunStartupInner$,
    ),
  },
];
