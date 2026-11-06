import { randomUUID } from "node:crypto";
import {
  instructionsContract,
  type InstructionsResponse,
} from "@okouai/api-contracts/contracts/instructions";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  SINGLE_AGENT_SEED_INSTRUCTIONS,
  SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE,
} from "@okouai/core/seed-instructions";
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

// Members follow the default until their first save. A changed default is a
// new version, so drafts based on the previous default become stale.
const DEFAULT_VERSION = `default-${SINGLE_AGENT_SEED_INSTRUCTIONS_BUNDLE.sha256}`;
const STALE_VERSION =
  "Instructions changed; reload the saved version before saving";

interface PersonalScope {
  readonly orgId: string;
  readonly userId: string;
}

function response(row: typeof instructions.$inferSelect): InstructionsResponse {
  return {
    orgId: row.orgId,
    userId: row.userId,
    content: row.content,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

function defaultResponse(scope: PersonalScope): InstructionsResponse {
  return {
    ...scope,
    content: SINGLE_AGENT_SEED_INSTRUCTIONS,
    // Never saved; the epoch keeps the existing response contract.
    updatedAt: new Date(0).toISOString(),
    version: DEFAULT_VERSION,
  };
}

const readSavedInstructions$ = command(
  async ({ get }, scope: PersonalScope, signal: AbortSignal) => {
    const [row] = await get(db$)
      .select()
      .from(instructions)
      .where(
        and(
          eq(instructions.orgId, scope.orgId),
          eq(instructions.userId, scope.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row;
  },
);

const readInstructions$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(personalModeAllowed$, signal))) {
    return resourceUnavailable(
      "Personal Instructions are not available for this context",
    );
  }
  const auth = get(organizationAuthContext$);
  const scope = { orgId: auth.orgId, userId: auth.userId };
  const row = await set(readSavedInstructions$, scope, signal);
  return {
    status: 200 as const,
    body: row ? response(row) : defaultResponse(scope),
  };
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
    const { ifVersion } = body.data;
    const saved = await set(readSavedInstructions$, scope, signal);
    if (
      ifVersion !== undefined &&
      ifVersion !== (saved?.version ?? DEFAULT_VERSION)
    ) {
      return conflict(STALE_VERSION);
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
    const values = {
      content: body.data.content,
      bundle,
      version: randomUUID(),
      updatedAt: nowDate(),
    };
    const database = set(writeDb$);
    const owner = [instructions.orgId, instructions.userId];
    let rows: (typeof instructions.$inferSelect)[];
    if (saved) {
      // Omitted ifVersion explicitly means unconditional replacement.
      rows = await database
        .update(instructions)
        .set(values)
        .where(
          and(
            eq(instructions.orgId, scope.orgId),
            eq(instructions.userId, scope.userId),
            ifVersion === undefined
              ? undefined
              : eq(instructions.version, ifVersion),
          ),
        )
        .returning();
    } else if (ifVersion === undefined) {
      rows = await database
        .insert(instructions)
        .values({ ...scope, ...values })
        .onConflictDoUpdate({ target: owner, set: values })
        .returning();
    } else {
      // The first save forks from the default; a concurrent first save wins.
      rows = await database
        .insert(instructions)
        .values({ ...scope, ...values })
        .onConflictDoNothing({ target: owner })
        .returning();
    }
    signal.throwIfAborted();
    const [updated] = rows;
    if (!updated) {
      return conflict(STALE_VERSION);
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
