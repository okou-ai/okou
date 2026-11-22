import { readStoredDraftMessage } from "@okouai/api-contracts/validators/chat-threads";
import {
  iosVoiceDraftTransforms,
  androidVoiceDraftTransforms,
} from "@okouai/api-contracts/client-transforms/voice-draft";
import { command, computed } from "ccstate";
import { composerDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { canWriteProjectReferences } from "../services/project-reference.service";
import type { RouteEntry } from "../route-entry";

const getComposerDraft$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
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

const patchComposerDraft$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);

    const bodyResult = await get(bodyResultOf(composerDraftContract.patch));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (!canWriteProjectReferences(auth, bodyResult.data.draftUserMessage)) {
      return notFound("Projects unavailable");
    }
    signal.throwIfAborted();

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

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

export const composerDraftRoutes: readonly RouteEntry[] = [
  {
    route: composerDraftContract.get,
    responseTransforms: [
      iosVoiceDraftTransforms.composer,
      androidVoiceDraftTransforms.composer,
    ],
    handler: authRoute(auth, getComposerDraft$),
  },
  {
    route: composerDraftContract.patch,
    handler: authRoute(auth, patchComposerDraft$),
  },
];
