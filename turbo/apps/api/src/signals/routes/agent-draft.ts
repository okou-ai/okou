import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { projectAccess$ } from "./projects";
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
import { conflict, notFound } from "../../lib/error";
import { visibleAgentIdentityCondition } from "../services/agent-data.service";
import { projectReferenceWritesEnabled } from "../services/project-reference.service";
import { replaceAgentDraft$ } from "../services/composer-draft-write.service";
import { conditionalComposerDraftsEnabled$ } from "../services/composer-draft-access";
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
      replace: typeof projectChatContract.replaceAgentDraft;
    };
function createAgentDraftReader(
  contract: AgentDraftContract,
  projectEndpoint: boolean,
) {
  const getAgentDraftInner$ = computed(async (get) => {
    if (projectEndpoint && !(await get(projectAccess$))) {
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
        draftUserMessage: draft?.draftUserMessage ?? null,
        draftAttachments: draft?.draftAttachments ?? null,
      },
    };
  });

  return getAgentDraftInner$;
}
function createAgentDraftReplacer(
  contract: AgentDraftContract,
  projectEndpoint: boolean,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const enabled = await get(conditionalComposerDraftsEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return notFound("Conditional composer drafts unavailable");
    }
    if (projectEndpoint) {
      const projects = await get(projectAccess$);
      signal.throwIfAborted();
      if (!projects) {
        return notFound("Projects unavailable");
      }
    }
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(contract.replace));
    const body = await get(bodyResultOf(contract.replace));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const references = await get(
      projectReferenceWritesEnabled(auth, body.data.draft.draftUserMessage),
    );
    signal.throwIfAborted();
    if (!references) {
      return notFound("Projects unavailable");
    }
    const scope = {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    };
    const [visibleAgent] = await get(db$)
      .select({ id: agents.id })
      .from(agents)
      .where(visibleAgentIdentityCondition(scope))
      .limit(1);
    signal.throwIfAborted();
    if (!visibleAgent) {
      return agentNotFound(params.id);
    }
    if (!(await set(replaceAgentDraft$, scope, body.data, signal))) {
      return conflict("Composer draft changed; reload before replacing it");
    }
    return { status: 204 as const, body: undefined };
  });
}
function createAgentDraftRoutes(
  contract: AgentDraftContract,
  projectEndpoint: boolean,
): readonly RouteEntry[] {
  const getAgentDraftInner$ = createAgentDraftReader(contract, projectEndpoint);
  const replaceAgentDraftInner$ = createAgentDraftReplacer(
    contract,
    projectEndpoint,
  );
  const patchAgentDraftInner$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      if (projectEndpoint && !(await get(projectAccess$))) {
        return notFound("Projects unavailable");
      }
      const auth = get(organizationAuthContext$);
      const params = get(pathParamsOf(contract.patch));

      const bodyResult = await get(bodyResultOf(contract.patch));
      signal.throwIfAborted();
      if (!bodyResult.ok) {
        return bodyResult.response;
      }
      if (
        !(await get(
          projectReferenceWritesEnabled(auth, bodyResult.data.draftUserMessage),
        ))
      ) {
        return notFound("Projects unavailable");
      }
      signal.throwIfAborted();

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
      route: contract.replace,
      handler: authRoute(agentReadAuth, replaceAgentDraftInner$),
    },
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
    replace: projectChatContract.replaceAgentDraft,
  },
  true,
);
