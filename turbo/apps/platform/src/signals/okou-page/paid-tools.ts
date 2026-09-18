import { command, computed, state } from "ccstate";
import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { generationTemplateKind } from "@okouai/core/generation-template-kind";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$, clerk$ } from "../auth.ts";
import type { ComposerCreateMode } from "./composer-create.ts";

const revision$ = state(0);

export const reloadDisabledPaidTools$ = command(({ set }) => {
  set(revision$, (revision) => {
    return revision + 1;
  });
});

/** One current session, never the last resolved preferences of another owner. */
const paidToolsClient$ = computed(async (get) => {
  const identity = get(authenticatedSessionKey$);
  const createClient = get(apiClient$);
  const clerk = await get(clerk$);
  const assertCurrent = () => {
    if (
      !identity ||
      !clerk.user ||
      !clerk.organization ||
      !clerk.session ||
      JSON.stringify([
        clerk.organization.id,
        clerk.user.id,
        clerk.session.id,
      ]) !== identity
    ) {
      throw new DOMException("Paid tools owner changed", "AbortError");
    }
  };
  assertCurrent();
  const client = createClient(paidToolsContract, {
    getTokenGuard: () => {
      assertCurrent();
      return assertCurrent;
    },
  });
  return { client, assertCurrent };
});

export const disabledPaidTools$ = computed(async (get) => {
  get(revision$);
  const { client, assertCurrent } = await get(paidToolsClient$);
  assertCurrent();
  const response = await accept(client.get(), [200]);
  assertCurrent();
  return response.body.disabledTools;
});

export function paidToolDisabledMessage(toolId: PaidToolId): string {
  return i18n.t(
    ($) => {
      return $.settings.paidTools.disabledForCreation;
    },
    {
      tool: i18n.t(($) => {
        return $.settings.paidTools.tools[toolId].name;
      }),
    },
  );
}

/** Explicit creation checks fresh preferences; ordinary chat does not depend on this read. */
export const checkPaidToolForCreation$ = command(
  async ({ get }, mode: ComposerCreateMode | null, signal: AbortSignal) => {
    if (mode !== "image" && mode !== "video") {
      return true;
    }
    const toolId = mode === "image" ? "image-generation" : "video-generation";
    const { client, assertCurrent } = await get(paidToolsClient$);
    signal.throwIfAborted();
    assertCurrent();
    const response = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    assertCurrent();
    if (response.body.disabledTools.includes(toolId)) {
      toast.error(paidToolDisabledMessage(toolId));
      return false;
    }
    return true;
  },
);

/** Template hints describe their default paid branch, not a promise that every message generates. */
export function templatePaidTool(
  template: GenerationTemplateRequest,
): PaidToolId | undefined {
  switch (generationTemplateKind(template)) {
    case "illustration": {
      return "image-generation";
    }
    case "video": {
      return "video-generation";
    }
    case "avatar": {
      return "avatar-video-generation";
    }
    case "intro-video": {
      return template.type === "intro-video" &&
        template.selection.options?.voice.kind === "none"
        ? "video-rendering"
        : "video-generation";
    }
    default: {
      return undefined;
    }
  }
}
