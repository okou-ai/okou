import { command } from "ccstate";
import { and, eq, like } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { isCanonicalRunnerHostname } from "@okouai/api-contracts/contracts/runner-dispatch";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { runWssTicketSchema } from "@okouai/api-contracts/contracts/run-wss";
import { env } from "../../lib/env";
import { notFound, providerUnavailable } from "../../lib/error";
import { db$ } from "../external/db";
import { safeJsonParse, settleIncludingAbort } from "../utils";

const unavailable = notFound("Run WebSocket unavailable");
const ingressUnavailable = providerUnavailable("Runner ingress unavailable");

export const bootstrapRunWss$ = command(
  async (
    { get },
    input: {
      readonly runId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const [target] = await get(db$)
      .select({
        runnerId: agentRuns.runnerId,
        hostname: agentRuns.runnerHostname,
        heartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
      })
      .from(agentRuns)
      .innerJoin(activeAgentRuns, eq(activeAgentRuns.runId, agentRuns.id))
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.orgId, input.orgId),
          eq(agentRuns.userId, input.userId),
          eq(activeAgentRuns.orgId, input.orgId),
          eq(activeAgentRuns.userId, input.userId),
          eq(agentRuns.status, "running"),
          like(agentRuns.runnerGroup, "vm0/%"),
        ),
      );
    signal.throwIfAborted();
    if (
      !target?.runnerId ||
      !target.hostname ||
      !isCanonicalRunnerHostname(target.hostname) ||
      !target.heartbeatGeneration
    ) {
      return unavailable;
    }

    const runnerPath = `/runners/${target.runnerId}`;
    const issued = await settleIncludingAbort(async () => {
      const response = await fetch(
        `https://${target.hostname}${runnerPath}/control/runs/${input.runId}/wss-ticket`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
            "X-Okou-Runner-Heartbeat-Generation": String(
              target.heartbeatGeneration,
            ),
          },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel();
        return response.status === 404 ? unavailable : ingressUnavailable;
      }
      const ticket = runWssTicketSchema.safeParse(
        safeJsonParse(await response.text()),
      );
      if (!ticket.success) {
        return ingressUnavailable;
      }
      return {
        status: 200 as const,
        body: {
          ...ticket.data,
          wssUrl: `wss://${target.hostname}${runnerPath}/sandbox/runs/${input.runId}`,
        },
      };
    });
    signal.throwIfAborted();
    return issued.ok ? issued.value : ingressUnavailable;
  },
);
