import { command, computed } from "ccstate";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { agents } from "@okouai/db/schema/agent";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { visibleAgentIdentityCondition } from "../services/agent-data.service";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import type { RouteEntry } from "../route-entry";

const MAX_AGENT_DRAFT_WRITE_ATTEMPTS = 2;

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

const getAgentDraftInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentDraftContract.get));

  const agentScope = {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.id,
  };
  const [visibleAgent] = await get(db$)
    .select({ id: agents.id })
    .from(agents)
    .where(visibleAgentIdentityCondition(agentScope))
    .limit(1);
  const exists = Boolean(visibleAgent);
  if (!exists) {
    return agentNotFound(params.id);
  }

  const [draft] = await get(db$)
    .select({
      draftUserMessage: agentDrafts.draftUserMessage,
      draftAttachments: agentDrafts.draftAttachments,
    })
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.userId, auth.userId),
        eq(agentDrafts.orgId, auth.orgId),
        eq(agentDrafts.agentId, params.id),
      ),
    )
    .limit(1);

  return {
    status: 200 as const,
    body: {
      draftUserMessage: draft?.draftUserMessage ?? null,
      draftAttachments: draft?.draftAttachments ?? null,
    },
  };
});

const patchAgentDraftInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(agentDraftContract.patch));

    const bodyResult = await get(bodyResultOf(agentDraftContract.patch));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const agentScope = {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    };
    const [visibleAgent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgentIdentityCondition(agentScope))
      .limit(1);
    signal.throwIfAborted();
    const exists = Boolean(visibleAgent);
    if (!exists) {
      return agentNotFound(params.id);
    }

    const draftAttachments = bodyResult.data.draftAttachments ?? null;
    const draftUserMessage = bodyResult.data.draftUserMessage;
    const writeDb = set(writeDb$);
    const updatedAt = nowDate();
    const draft = {
      userId: auth.userId,
      orgId: auth.orgId,
      agentId: params.id,
      draftUserMessage,
      draftAttachments,
      updatedAt,
    };
    await (async () => {
      const keyPredicate = and(
        eq(agentDrafts.userId, draft.userId),
        eq(agentDrafts.orgId, draft.orgId),
        eq(agentDrafts.agentId, draft.agentId),
      );
      if (
        !draft.draftUserMessage &&
        !(draft.draftAttachments && draft.draftAttachments.length > 0)
      ) {
        await writeDb.delete(agentDrafts).where(keyPredicate);
        return;
      }

      const update = {
        draftUserMessage: draft.draftUserMessage,
        draftAttachments: draft.draftAttachments,
        updatedAt: draft.updatedAt,
      };

      for (
        let attempt = 0;
        attempt < MAX_AGENT_DRAFT_WRITE_ATTEMPTS;
        attempt += 1
      ) {
        const updated = await writeDb
          .update(agentDrafts)
          .set(update)
          .where(keyPredicate)
          .returning({ agentId: agentDrafts.agentId });
        if (updated.length > 0) {
          return;
        }

        const inserted = await settle(
          writeDb.insert(agentDrafts).values({
            userId: draft.userId,
            orgId: draft.orgId,
            agentId: draft.agentId,
            ...update,
          }),
        );
        if (inserted.ok) {
          return;
        }
        if (
          !isUniqueViolation(inserted.error) ||
          attempt === MAX_AGENT_DRAFT_WRITE_ATTEMPTS - 1
        ) {
          throw inserted.error;
        }
        // Retry the full cycle in case the competing row is deleted first.
      }
    })();
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const agentDraftRoutes: readonly RouteEntry[] = [
  {
    route: agentDraftContract.get,
    handler: authRoute(agentReadAuth, getAgentDraftInner$),
  },
  {
    route: agentDraftContract.patch,
    handler: authRoute(agentReadAuth, patchAgentDraftInner$),
  },
];
