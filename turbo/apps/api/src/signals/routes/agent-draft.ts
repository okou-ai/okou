import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { projectAccess$ } from "./projects";
import { projectAwareUserMessageDocumentSchema } from "@okouai/api-contracts/contracts/project-readers";
import { userMessageInputDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
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
import type { RouteEntry } from "../route-entry";

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

type AgentDraftContract =
  | typeof agentDraftContract
  | {
      get: typeof projectChatContract.agentDraft;
      patch: typeof projectChatContract.saveAgentDraft;
    };
function createAgentDraftReader(
  contract: AgentDraftContract,
  prepared: boolean,
) {
  const getAgentDraftInner$ = computed(async (get) => {
    if (prepared && !(await get(projectAccess$))) {
      return notFound("Projects unavailable");
    }
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(contract.get));

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
        draftUserMessage: draft?.draftUserMessage
          ? prepared
            ? draft.draftUserMessage
            : userMessageInputDocumentSchema.parse(
                projectAwareUserMessageDocumentSchema.parse(
                  draft.draftUserMessage,
                ),
              )
          : null,
        draftAttachments: draft?.draftAttachments ?? null,
      },
    };
  });

  return getAgentDraftInner$;
}
function createAgentDraftRoutes(
  contract: AgentDraftContract,
  prepared: boolean,
): readonly RouteEntry[] {
  const getAgentDraftInner$ = createAgentDraftReader(contract, prepared);
  const patchAgentDraftInner$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (prepared && !(await get(projectAccess$))) {
        return notFound("Projects unavailable");
      }
      const auth = get(organizationAuthContext$);
      const params = get(pathParamsOf(contract.patch));

      const bodyResult = await get(bodyResultOf(contract.patch));
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

        await writeDb
          .insert(agentDrafts)
          .values(draft)
          .onConflictDoUpdate({
            target: [
              agentDrafts.userId,
              agentDrafts.orgId,
              agentDrafts.agentId,
            ],
            set: update,
          });
      })();
      signal.throwIfAborted();

      return { status: 204 as const, body: undefined };
    },
  );

  return [
    {
      route: contract.get,
      handler: authRoute(agentReadAuth, getAgentDraftInner$),
    },
    {
      route: contract.patch,
      handler: authRoute(agentReadAuth, patchAgentDraftInner$),
    },
  ];
}
export const agentDraftRoutes = createAgentDraftRoutes(
  agentDraftContract,
  false,
);
export const projectAgentDraftRoutes = createAgentDraftRoutes(
  {
    get: projectChatContract.agentDraft,
    patch: projectChatContract.saveAgentDraft,
  },
  true,
);
