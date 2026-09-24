import { command } from "ccstate";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { findWebsiteTemplateItem } from "@okouai/core/website-template-items";
import { i18n } from "../../i18n/index.ts";
import { sendNewThread$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { defaultAgentId$ } from "../agent.ts";
import { rootSignal$ } from "../root-signal.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { showAppSkeleton$ } from "../app-skeleton.ts";
import { redirectToConfiguredOnboarding$ } from "../okou-page/onboard-guard.ts";
import {
  resetChatPageModelSelection$,
  setChatPageModelSelection$,
} from "../okou-page/chat-page.ts";
import { withCleanup } from "../utils.ts";

interface ResolvedGenerationTemplate {
  readonly template: GenerationTemplateRequest;
  readonly titleSnapshot: string;
}

function templateIdFromSearchParam(
  template: string | null,
): string | undefined {
  const id = template?.trim();
  if (!id) {
    return undefined;
  }
  return id;
}

function websiteGenerationTemplateFromId(
  id: string,
): ResolvedGenerationTemplate | undefined {
  const websiteTemplate = findWebsiteTemplateItem(id);
  if (!websiteTemplate) {
    return undefined;
  }
  return {
    titleSnapshot: websiteTemplate.title,
    template: {
      type: "website",
      selection: {
        websiteTemplateId: websiteTemplate.id,
      },
    },
  };
}

function presentationGenerationTemplateFromId(
  id: string,
): ResolvedGenerationTemplate | undefined {
  const presentationTemplateId = id.replace(/^presentation-template:/, "");
  const presentationTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS.find(
    (item) => {
      return (
        item.slug === presentationTemplateId ||
        item.templateId === id ||
        item.templateId === presentationTemplateId
      );
    },
  );
  if (!presentationTemplate) {
    return undefined;
  }
  return {
    titleSnapshot: presentationTemplate.title,
    template: {
      type: "presentation",
      selection: {
        templateId: presentationTemplate.templateId,
        colorSystemId:
          presentationTemplate.colorSystemId ?? "color-system:warm-sand",
        previewUrl: presentationTemplate.embedUrl,
      },
    },
  };
}

function illustrationGenerationTemplateFromId(
  id: string,
): ResolvedGenerationTemplate | undefined {
  const illustrationTemplateId = id
    .replace(/^illustration-template:/, "")
    .replace(/^image-template:/, "");
  const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
    return (
      item.slug === illustrationTemplateId ||
      item.illustrationStyleId === id ||
      item.illustrationStyleId === illustrationTemplateId
    );
  });
  if (!illustrationTemplate) {
    return undefined;
  }
  return {
    titleSnapshot: illustrationTemplate.title,
    template: {
      type: "illustration",
      selection: {
        illustrationStyleId: illustrationTemplate.illustrationStyleId,
      },
    },
  };
}

const generationTemplateParsers = [
  websiteGenerationTemplateFromId,
  presentationGenerationTemplateFromId,
  illustrationGenerationTemplateFromId,
] as const;

function generationTemplateFromSearchParam(
  template: string | null,
): ResolvedGenerationTemplate | undefined {
  const id = templateIdFromSearchParam(template);
  if (!id) {
    return undefined;
  }
  for (const parse of generationTemplateParsers) {
    const resolved = parse(id);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

/**
 * Lightweight prompt deep-link endpoint.
 *
 * This replaces the use-case-only `/onboarding?prompt=...` path once the
 * workspace/default agent already exists: consume the prompt exactly like the
 * onboarding "Try It" action and route into the new optimistic chat thread.
 */
export const setupPromptPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.promptDocumentTitle;
      }),
    );
    set(showAppSkeleton$);

    const params = get(searchParams$);
    const prompt = params.get("prompt")?.trim();
    const requestedModel = params.get("model")?.trim();
    const template = params.get("template")?.trim() ?? null;
    const resolvedGenerationTemplate =
      generationTemplateFromSearchParam(template);
    const unresolvedTemplate =
      Boolean(template) && resolvedGenerationTemplate === undefined;
    if (!prompt || unresolvedTemplate) {
      set(detachedNavigateTo$, "/", {
        replace: true,
        searchParams: new URLSearchParams(prompt ? { prompt } : {}),
      });
      return;
    }

    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      await set(redirectToConfiguredOnboarding$, params, signal);
      return;
    }

    if (isSupportedRunModel(requestedModel)) {
      set(setChatPageModelSelection$, { selectedModel: requestedModel });
    } else {
      set(resetChatPageModelSelection$);
    }

    const cleaned = new URLSearchParams(params);
    cleaned.delete("prompt");
    cleaned.delete("model");
    cleaned.delete("template");
    cleaned.delete("connector");
    const rootSignal = get(rootSignal$);
    await withCleanup(
      set(
        sendNewThread$,
        {
          agentId,
          prompt,
          generationTemplate: resolvedGenerationTemplate?.template,
          generationTemplateTitleSnapshot:
            resolvedGenerationTemplate?.titleSnapshot,
          computerUseHostId: null,
          routeSearchParams: cleaned,
        },
        rootSignal,
      ),
      () => {
        set(resetChatPageModelSelection$);
      },
    );
  },
);
