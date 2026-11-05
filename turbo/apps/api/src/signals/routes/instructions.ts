import { randomUUID } from "node:crypto";
import {
  instructionsContract,
  type InstructionsResponse,
} from "@okouai/api-contracts/contracts/instructions";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { instructions } from "@okouai/db/schema/instructions";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { conflict, resourceUnavailable } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { initializePersonalInstructions$ } from "../services/personal-instructions.service";
import { publishContentBundle$ } from "../services/content-bundle.service";

const personalModeAllowed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    set(setResHeader$, "Cache-Control", "private, no-store");
    if (auth.tokenType === "agent") {
      // A signed Run snapshot never changes mode with the live member override.
      if (auth.singleAgent !== true) {
        return false;
      }
      const [run] = await get(db$)
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, auth.runId),
            eq(agentRuns.orgId, auth.orgId),
            eq(agentRuns.userId, auth.userId),
            inArray(agentRuns.status, ["pending", "running"]),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      return run !== undefined;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.SingleAgent, features);
  },
);

function response(row: typeof instructions.$inferSelect): InstructionsResponse {
  return {
    orgId: row.orgId,
    userId: row.userId,
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

const readInstructions$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(personalModeAllowed$, signal))) {
    return resourceUnavailable(
      "Personal Instructions are not available for this context",
    );
  }
  const auth = get(organizationAuthContext$);
  const row = await set(
    initializePersonalInstructions$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  return { status: 200 as const, body: response(row) };
});

const updateBody$ = bodyResultOf(instructionsContract.update);
const updateInstructions$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!(await set(personalModeAllowed$, signal))) {
      return resourceUnavailable(
        "Personal Instructions are not available for this context",
      );
    }
    const auth = get(organizationAuthContext$);
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const scope = { orgId: auth.orgId, userId: auth.userId };
    const current = await set(initializePersonalInstructions$, scope, signal);
    if (
      body.data.ifVersion !== undefined &&
      body.data.ifVersion !== current.version
    ) {
      return conflict(
        "Instructions changed; reload the saved version before saving",
      );
    }
    const bundle = await set(
      publishContentBundle$,
      [
        {
          path: "instructions.md",
          content: Buffer.from(body.data.content, "utf8"),
        },
      ],
      signal,
    );
    // Omitted ifVersion explicitly means unconditional replacement.
    const [updated] = await set(writeDb$)
      .update(instructions)
      .set({
        content: body.data.content,
        bundle,
        version: randomUUID(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(instructions.orgId, scope.orgId),
          eq(instructions.userId, scope.userId),
          body.data.ifVersion === undefined
            ? undefined
            : eq(instructions.version, body.data.ifVersion),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!updated) {
      return conflict(
        "Instructions changed; reload the saved version before saving",
      );
    }
    return { status: 200 as const, body: response(updated) };
  },
);

export const instructionsRoutes: readonly RouteEntry[] = [
  {
    route: instructionsContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "instructions:read",
        accept: ["session", "pat", "agent"],
      },
      readInstructions$,
    ),
  },
  {
    route: instructionsContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "instructions:write",
        accept: ["session", "pat", "agent"],
      },
      updateInstructions$,
    ),
  },
];
