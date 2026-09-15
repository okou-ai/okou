import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { CLIENT_VERSION_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { agentDraftRoutes } from "../agent-draft";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

test.each(["agent", "thread"])(
  "gates new Brand motion selections in %s drafts while preserving edits after disabling",
  async (kind) => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "Brand motion drafts",
    });
    if (!actor.orgId) {
      throw new Error("Expected an organization for the draft owner");
    }
    const scopedActor = { ...actor, orgId: actor.orgId };
    const thread =
      kind === "thread"
        ? await chat.createThread(actor, { agentId: agent.agentId })
        : null;
    const drafts = setupApp({ context, routes: agentDraftRoutes })(
      agentDraftContract,
    );
    const headers = {
      authorization: "Bearer clerk-session",
      [CLIENT_VERSION_HEADER]: "0.734.0",
    };
    async function patch(
      document: UserMessageInputDocument | null,
      status: 204 | 400,
    ) {
      if (thread) {
        const result = await chat.requestPatchThread(
          actor,
          thread.id,
          {
            draftUserMessage: document,
          },
          [status],
        );
        return result.body;
      }
      mocks.clerk.session(scopedActor.userId, scopedActor.orgId);
      const result = await accept(
        drafts.patch({
          params: { id: agent.agentId },
          headers,
          body: { draftUserMessage: document, draftAttachments: null },
        }),
        [status],
      );
      return result.body;
    }
    async function read() {
      if (thread) {
        return (await chat.readThreadDraft(actor, thread.id)).draftUserMessage;
      }
      mocks.clerk.session(scopedActor.userId, scopedActor.orgId);
      const result = await accept(
        drafts.get({
          params: { id: agent.agentId },
          headers,
        }),
        [200],
      );
      return result.body.draftUserMessage;
    }
    const templatePart = {
      type: "template",
      titleSnapshot: "Mask Sweep",
      template: {
        type: "brand-motion",
        selection: { templateId: "brand-motion:brand-mask-sweep-lockup" },
      },
    } as const;
    const draft: UserMessageInputDocument = {
      version: 1,
      parts: [templatePart, { type: "text", text: "Animate my brand" }],
    };
    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.BrandMotion]: false,
    });
    const rejected = await patch(draft, 400);
    expect(rejected).toMatchObject({
      error: { message: "Brand motion is not available" },
    });
    const empty = await read();
    expect(empty).toBeNull();

    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.BrandMotion]: true,
    });
    await patch(draft, 204);
    const enabledDraft = await read();
    expect(enabledDraft).toStrictEqual(draft);

    await updateFeatureSwitchesForUser(context, scopedActor, {
      [FeatureSwitchKey.BrandMotion]: false,
    });
    const edited: UserMessageInputDocument = {
      version: 1,
      parts: [
        templatePart,
        { type: "text", text: "Animate my brand for launch" },
      ],
    };
    await patch(edited, 204);
    const savedEdit = await read();
    expect(savedEdit).toStrictEqual(edited);

    const replaced: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          ...templatePart,
          template: {
            type: "brand-motion",
            selection: { templateId: "brand-motion:brand-stroke-draw-lockup" },
          },
        },
      ],
    };
    await patch(replaced, 400);
    await patch({ version: 1, parts: [templatePart, templatePart] }, 400);
    const unchanged = await read();
    expect(unchanged).toStrictEqual(edited);

    const removed: UserMessageInputDocument = {
      version: 1,
      parts: [{ type: "text", text: "Keep working on the launch" }],
    };
    await patch(removed, 204);
    const savedRemoval = await read();
    expect(savedRemoval).toStrictEqual(removed);
    await patch(draft, 400);
    await patch(null, 204);
    const cleared = await read();
    expect(cleared).toBeNull();
  },
);
