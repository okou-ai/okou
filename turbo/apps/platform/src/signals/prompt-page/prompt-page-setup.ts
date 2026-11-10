import {
  loadMarketingHandoff$,
  createMarketingHandoffDraft$,
  finishMarketingHandoff$,
} from "./marketing-handoff.ts";
import { command } from "ccstate";
import { modelCatalog$ } from "../external/model-catalog.ts";
import type { MarketingHandoffManifest } from "@okouai/api-contracts/contracts/marketing-handoffs";
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
import { redirectToConfiguredOnboarding$ } from "../okou-page/onboard-guard.ts";

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
        colorSystemId: presentationTemplate.colorSystemId,
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

function promptRequestContent(
  params: URLSearchParams,
  manifest?: MarketingHandoffManifest,
) {
  if (manifest) {
    const prompt = manifest.prompt.trim();
    return {
      prompt,
      requestedModel: manifest.options.model,
      template: manifest.options.template ?? null,
      hasContent: Boolean(prompt) || manifest.files.length > 0,
    };
  }
  const prompt = params.get("prompt")?.trim();
  return {
    prompt,
    requestedModel: params.get("model")?.trim(),
    template: params.get("template")?.trim() ?? null,
    hasContent: Boolean(prompt),
  };
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

    const params = get(searchParams$);
    const handoff = await set(loadMarketingHandoff$, signal);
    signal.throwIfAborted();
    if (params.get("handoff") && !handoff) {
      set(detachedNavigateTo$, "/", {
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }
    const { prompt, requestedModel, template, hasContent } =
      promptRequestContent(params, handoff?.manifest);
    const resolvedGenerationTemplate =
      generationTemplateFromSearchParam(template);
    // A link naming a template the App no longer offers (for example a retired
    // video style) keeps its brief as an editable draft instead of running it.
    const unresolvedTemplate =
      Boolean(template) && resolvedGenerationTemplate === undefined;
    if (!hasContent || unresolvedTemplate) {
      set(detachedNavigateTo$, "/", {
        replace: true,
        searchParams: handoff
          ? new URLSearchParams({ handoff: handoff.hash })
          : new URLSearchParams(prompt ? { prompt } : {}),
      });
      return;
    }

    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      await set(redirectToConfiguredOnboarding$, params, signal);
      return;
    }

    const catalog = await get(modelCatalog$);
    signal.throwIfAborted();
    const resolvedRequestedModel = catalog.resolve(requestedModel);

    const cleaned = new URLSearchParams(params);
    cleaned.delete("prompt");
    cleaned.delete("handoff");
    cleaned.delete("model");
    cleaned.delete("template");
    cleaned.delete("connector");
    const draft = handoff
      ? await set(createMarketingHandoffDraft$, handoff.hash, signal)
      : undefined;
    signal.throwIfAborted();
    if (handoff && !draft) {
      set(detachedNavigateTo$, "/", {
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }
    const rootSignal = get(rootSignal$);
    await set(
      sendNewThread$,
      {
        agentId,
        prompt: prompt ?? "",
        ...(draft ? { draft, preserveAgentDraft: true } : {}),
        ...(handoff
          ? {
              onOptimisticSend: () => {
                // The durable optimistic event now owns the imported attachments.
                set(finishMarketingHandoff$, handoff);
              },
            }
          : {}),
        modelSelection: resolvedRequestedModel
          ? { selectedModel: resolvedRequestedModel, modelSettings: {} }
          : null,
        generationTemplate: resolvedGenerationTemplate?.template,
        generationTemplateTitleSnapshot:
          resolvedGenerationTemplate?.titleSnapshot,
        computerUseHostId: null,
        routeSearchParams: cleaned,
      },
      rootSignal,
    );
  },
);
