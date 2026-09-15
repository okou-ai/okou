import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  UserMessageDocument,
  GenerationTemplateRequest,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  avatarVideoContract,
  type AvatarVideoAvatar,
  type AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import {
  presentationTemplatesContract,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplatePreviewAsset,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { HttpResponse } from "msw";
import { expect, vi } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  THREAD_ID,
  context,
  mockAgent,
  mockBillingCapabilities,
  mockOrgModelRoutes,
  mockUrlObjectMethods,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

export { AGENT_ID, THREAD_ID, context };

interface TemplateChatCapture {
  readonly sentMessages: UserMessageDocument[];
  readonly selectedTemplates: GenerationTemplateRequest[];
  readonly runPrompts: string[];
  readonly runClientThreadIds: (string | undefined)[];
  readonly threadCreates: string[];
  readonly lifecycle: ReturnType<typeof mockChatLifecycle>;
}

export function mockTemplateChat(options?: {
  readonly threadId?: string;
  readonly tier?: string;
}): TemplateChatCapture {
  const sentMessages: UserMessageDocument[] = [];
  const selectedTemplates: GenerationTemplateRequest[] = [];
  const runPrompts: string[] = [];
  const runClientThreadIds: (string | undefined)[] = [];
  const threadCreates: string[] = [];

  mockAgent({ selectedModel: "claude-sonnet-4-6" });
  mockOrgModelRoutes("claude-sonnet-4-6");
  mockBillingCapabilities(
    { supportByok: true, restrictedBuiltInModels: false },
    options?.tier ?? "pro",
  );
  const lifecycle = mockChatLifecycle(context, {
    threadId: options?.threadId ?? THREAD_ID,
    selectedModel: "claude-sonnet-4-6",
    onThreadCreate(body) {
      threadCreates.push(body.clientThreadId ?? "server-selected");
    },
    onRunCreate(body) {
      runPrompts.push(body.prompt ?? "");
      runClientThreadIds.push(body.clientThreadId);
      if (body.userMessage) {
        sentMessages.push(body.userMessage);
        selectedTemplates.push(
          ...body.userMessage.parts.flatMap((part) => {
            return part.type === "template" ? [part.template] : [];
          }),
        );
      }
    },
  });
  mockPresentationTemplateLibrary([]);
  context.mocks.api(avatarVideoContract.avatars, ({ respond }) => {
    return respond(200, { avatars: [] });
  });
  context.mocks.api(avatarVideoContract.voices, ({ respond }) => {
    return respond(200, {
      voices: [],
      hasMore: false,
      filterOptions: { languages: [], useCases: [] },
    });
  });

  return {
    sentMessages,
    selectedTemplates,
    runPrompts,
    runClientThreadIds,
    threadCreates,
    lifecycle,
  };
}

export async function openTemplatePicker(
  user: ReturnType<typeof userEvent.setup>,
  category?:
    | "Presentation"
    | "Website"
    | "Illustration"
    | "Video"
    | "Creative video"
    | "Avatar",
): Promise<HTMLElement> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  const dialog = await waitFor(() => {
    return screen.getByRole("dialog");
  });
  if (category) {
    await user.click(tabByText(category));
  }
  return dialog;
}

export function mockTemplateObjectUrls(): void {
  let nextUrl = 0;
  mockUrlObjectMethods(() => {
    nextUrl += 1;
    return `blob:https://app.okou.ai/presentation-preview-${nextUrl}`;
  });
}

function presentationHtml(slideTitles: readonly string[]): string {
  return `<!doctype html><html><body>${slideTitles
    .map((title, index) => {
      return `<section data-okou-slide data-slide-id="slide-${index + 1}"><h1 data-okou-editable="text">${title}</h1></section>`;
    })
    .join("")}</body></html>`;
}

export function mockPresentationHtml(
  embedUrl: string,
  slideTitles: readonly string[],
): void {
  context.mocks.http.get(embedUrl, () => {
    return new HttpResponse(presentationHtml(slideTitles), {
      headers: { "Content-Type": "text/html" },
    });
  });
}

export function templatePart(
  message: UserMessageDocument,
): Extract<UserMessageDocument["parts"][number], { type: "template" }> {
  const part = message.parts.find((candidate) => {
    return candidate.type === "template";
  });
  if (!part || part.type !== "template") {
    throw new Error("Sent message has no template part");
  }
  return part;
}

export async function sendComposerMessage(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const editor = await waitFor(() => {
    const candidate = document.querySelector<HTMLElement>(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!candidate) {
      throw new Error("Composer editor not found");
    }
    return candidate;
  });
  await user.click(editor);
  await user.keyboard(text);
  await user.keyboard("{Enter}");
}

export function createUploadedTemplate(options: {
  readonly id: string;
  readonly title: string;
  readonly pageCount?: number;
  readonly visibility?: "private" | "public";
  readonly canManage?: boolean;
  readonly updatedAt?: string;
}): PresentationTemplateCatalogEntry {
  const pageCount = options.pageCount ?? 3;
  const previewAssets = Array.from(
    { length: pageCount },
    (_, index): PresentationTemplatePreviewAsset => {
      return {
        previewAssetId: `${options.id}-page-${index + 1}`,
        url: `https://cdn.example.test/${options.id}/slide-${index + 1}.png`,
        expiresAt: "2026-08-01T00:15:00.000Z",
      };
    },
  );
  return {
    id: options.id,
    title: options.title,
    sourceFilename: `${options.title}.pptx`,
    coverUrl: previewAssets[0]?.url ?? null,
    pageCount,
    visibility: options.visibility ?? "public",
    canManage: options.canManage ?? false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-08-01T00:00:00.000Z",
    previewAssets,
  };
}

function summaryOf(
  template: PresentationTemplateCatalogEntry,
): PresentationTemplateSummary {
  const { previewAssets: _previewAssets, ...summary } = template;
  return summary;
}

interface PresentationLibraryControl {
  readonly requests: {
    readonly listCount: number;
    readonly updates: {
      readonly templateId: string;
      readonly body: { title?: string; visibility?: "private" | "public" };
    }[];
    readonly deletes: string[];
  };
  replace(templates: readonly PresentationTemplateCatalogEntry[]): void;
}

export function mockPresentationTemplateLibrary(
  initialTemplates: readonly PresentationTemplateCatalogEntry[],
): PresentationLibraryControl {
  let templates = [...initialTemplates];
  let listCount = 0;
  const updates: PresentationLibraryControl["requests"]["updates"] = [];
  const deletes: string[] = [];

  context.mocks.api(presentationTemplatesContract.list, ({ respond }) => {
    listCount += 1;
    return respond(200, templates);
  });
  context.mocks.api(
    presentationTemplatesContract.resolvePreviewUrls,
    ({ body, respond }) => {
      const requestedIds = new Set(body.previewAssetIds);
      return respond(200, {
        assets: templates.flatMap((template) => {
          return template.previewAssets.filter((asset) => {
            return requestedIds.has(asset.previewAssetId);
          });
        }),
      });
    },
  );
  context.mocks.api(
    presentationTemplatesContract.get,
    ({ params, respond }) => {
      const template = templates.find((candidate) => {
        return candidate.id === params.templateId;
      });
      if (!template) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: "Presentation template not found",
          },
        });
      }
      return respond(200, {
        ...template,
        pageUrls: template.previewAssets.map((asset) => {
          return asset.url;
        }),
      });
    },
  );
  context.mocks.api(
    presentationTemplatesContract.update,
    ({ params, body, respond }) => {
      updates.push({ templateId: params.templateId, body });
      const previous = templates.find((candidate) => {
        return candidate.id === params.templateId;
      });
      if (!previous) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: "Presentation template not found",
          },
        });
      }
      const updated = {
        ...previous,
        ...body,
        updatedAt: "2026-08-01T00:01:00.000Z",
      };
      templates = templates.map((candidate) => {
        return candidate.id === updated.id ? updated : candidate;
      });
      return respond(200, summaryOf(updated));
    },
  );
  context.mocks.api(
    presentationTemplatesContract.delete,
    ({ params, respond }) => {
      deletes.push(params.templateId);
      templates = templates.filter((candidate) => {
        return candidate.id !== params.templateId;
      });
      return respond(204);
    },
  );

  return {
    requests: {
      get listCount() {
        return listCount;
      },
      updates,
      deletes,
    },
    replace(nextTemplates) {
      templates = [...nextTemplates];
    },
  };
}

export function mockAvatarCatalog(options: {
  readonly avatars: readonly AvatarVideoAvatar[];
  readonly additionalAvatars?: readonly AvatarVideoAvatar[];
  readonly voices?: readonly AvatarVideoVoice[];
  readonly additionalVoices?: readonly AvatarVideoVoice[];
  readonly recommendedVoiceId?: string;
}): void {
  context.mocks.api(avatarVideoContract.avatars, ({ query, respond }) => {
    const source =
      query.page === 2 ? (options.additionalAvatars ?? []) : options.avatars;
    const avatars = source.filter((avatar) => {
      const aspectRatioMatches =
        query.aspectRatio === undefined ||
        (query.aspectRatio === "portrait" && avatar.aspectRatio === 1) ||
        (query.aspectRatio === "landscape" && avatar.aspectRatio === 2);
      return (
        aspectRatioMatches &&
        (query.style === undefined || avatar.style === query.style) &&
        (query.gender === undefined || avatar.gender === query.gender) &&
        (query.age === undefined || avatar.age === query.age)
      );
    });
    return respond(200, { avatars });
  });
  context.mocks.api(avatarVideoContract.voices, ({ query, respond }) => {
    const source =
      query.page === 2
        ? (options.additionalVoices ?? [])
        : (options.voices ?? []);
    const voices = source.filter((voice) => {
      return (
        (query.language === undefined || voice.language === query.language) &&
        (query.gender === undefined || voice.gender === query.gender) &&
        (query.age === undefined || voice.age === query.age) &&
        (query.useCase === undefined || voice.useCase === query.useCase)
      );
    });
    const recommended = voices.find((voice) => {
      return voice.id === options.recommendedVoiceId;
    });
    return respond(200, {
      voices: recommended
        ? [
            recommended,
            ...voices.filter((voice) => {
              return voice !== recommended;
            }),
          ]
        : voices,
      hasMore: query.page !== 2 && (options.additionalVoices?.length ?? 0) > 0,
      filterOptions: {
        languages: ["English", "French"],
        useCases: ["Narration", "Social"],
      },
    });
  });
}

export function mockPlayableMedia(): {
  readonly play: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
} {
  const playing = new WeakSet<HTMLMediaElement>();
  const pausedGetter = vi
    .spyOn(HTMLMediaElement.prototype, "paused", "get")
    .mockImplementation(function (this: HTMLMediaElement) {
      return !playing.has(this);
    });
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(function (this: HTMLMediaElement) {
      playing.add(this);
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(function (this: HTMLMediaElement) {
      playing.delete(this);
      this.dispatchEvent(new Event("pause"));
    });
  context.signal.addEventListener(
    "abort",
    () => {
      pausedGetter.mockRestore();
      play.mockRestore();
      pause.mockRestore();
    },
    { once: true },
  );
  return { play, pause };
}

export async function expectInlineTemplate(
  title: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const node = Array.from(
      document.querySelectorAll<HTMLElement>("[data-composer-inline-template]"),
    ).find((candidate) => {
      return candidate.textContent?.includes(title);
    });
    expect(node).toBeInTheDocument();
    if (!node) {
      throw new Error(`Inline template ${title} not found`);
    }
    return node;
  });
}
