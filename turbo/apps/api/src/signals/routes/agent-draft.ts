import { readStoredDraftMessage } from "@okouai/api-contracts/validators/chat-threads";
import {
  iosVoiceDraftTransforms,
  androidVoiceDraftTransforms,
} from "@okouai/api-contracts/client-transforms/voice-draft";
import type { ClientResponseTransform } from "@okouai/api-contracts/client-transforms/types";
import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { personalProjectAccess$ } from "./projects";
import { command, computed } from "ccstate";
import {
  agentDraftContract,
  composerDraftContract,
} from "@okouai/api-contracts/contracts/agent-draft";
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
import { canWriteProjectReferences } from "../services/project-reference.service";
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
  | typeof composerDraftContract
  | typeof agentDraftContract
  | {
      get: typeof projectChatContract.agentDraft;
      patch: typeof projectChatContract.saveAgentDraft;
    };
function createAgentDraftReader(
  contract: AgentDraftContract,
  projectEndpoint: boolean,
) {
  const getAgentDraftInner$ = computed(async (get) => {
    if (projectEndpoint && !get(personalProjectAccess$)) {
      return notFound("Projects unavailable");
    }
    const auth = get(organizationAuthContext$);
    if ("pathParams" in contract.get) {
      const { id } = get(pathParamsOf(contract.get));
      const [visibleAgent] = await get(db$)
        .select({ id: agents.id })
        .from(agents)
        .where(
          visibleAgentIdentityCondition({
            orgId: auth.orgId,
            userId: auth.userId,
            agentId: id,
          }),
        )
        .limit(1);
      if (!visibleAgent) {
        return agentNotFound(id);
      }
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
        ),
      )
      .limit(1);

    return {
      status: 200 as const,
      body: {
        draftUserMessage: readStoredDraftMessage(draft?.draftUserMessage),
        draftAttachments: draft?.draftAttachments ?? null,
      },
    };
  });

  return getAgentDraftInner$;
}
function createAgentDraftRoutes(
  contract: AgentDraftContract,
  projectEndpoint: boolean,
  responseTransforms: readonly ClientResponseTransform[] = [],
): readonly RouteEntry[] {
  const getAgentDraftInner$ = createAgentDraftReader(contract, projectEndpoint);
  const patchAgentDraftInner$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (projectEndpoint && !get(personalProjectAccess$)) {
        return notFound("Projects unavailable");
      }
      const auth = get(organizationAuthContext$);

      const bodyResult = await get(bodyResultOf(contract.patch));
      signal.throwIfAborted();
      if (!bodyResult.ok) {
        return bodyResult.response;
      }
      if (!canWriteProjectReferences(auth, bodyResult.data.draftUserMessage)) {
        return notFound("Projects unavailable");
      }
      signal.throwIfAborted();

      if ("pathParams" in contract.patch) {
        const { id } = get(pathParamsOf(contract.patch));
        const [visibleAgent] = await get(db$)
          .select({ id: agents.id })
          .from(agents)
          .where(
            visibleAgentIdentityCondition({
              orgId: auth.orgId,
              userId: auth.userId,
              agentId: id,
            }),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!visibleAgent) {
          return agentNotFound(id);
        }
      }

      const draftAttachments = bodyResult.data.draftAttachments ?? null;
      const draftUserMessage = bodyResult.data.draftUserMessage;
      const writeDb = set(writeDb$);
      const updatedAt = nowDate();
      const draft = {
        userId: auth.userId,
        orgId: auth.orgId,
        draftUserMessage,
        draftAttachments,
        updatedAt,
      };
      await (async () => {
        const keyPredicate = and(
          eq(agentDrafts.userId, draft.userId),
          eq(agentDrafts.orgId, draft.orgId),
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
            target: [agentDrafts.userId, agentDrafts.orgId],
            set: update,
          });
      })();
      signal.throwIfAborted();

      return { status: 204 as const, body: undefined };
    },
  );

  const auth =
    "pathParams" in contract.get
      ? agentReadAuth
      : ({
          requireOrganization: true,
          missingOrganizationStatus: 401,
          accept: ["session"],
        } as const);
  return [
    {
      route: contract.get,
      responseTransforms,
      handler: authRoute(auth, getAgentDraftInner$),
    },
    {
      route: contract.patch,
      handler: authRoute(auth, patchAgentDraftInner$),
    },
  ];
}
export const agentDraftRoutes = createAgentDraftRoutes(
  agentDraftContract,
  false,
  [iosVoiceDraftTransforms.agent, androidVoiceDraftTransforms.agent],
);
export const projectAgentDraftRoutes = createAgentDraftRoutes(
  {
    get: projectChatContract.agentDraft,
    patch: projectChatContract.saveAgentDraft,
  },
  true,
);

export const composerDraftRoutes = createAgentDraftRoutes(
  composerDraftContract,
  false,
  [iosVoiceDraftTransforms.composer, androidVoiceDraftTransforms.composer],
);
