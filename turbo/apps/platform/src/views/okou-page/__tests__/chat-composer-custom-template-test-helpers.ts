import {
  userTemplatesContract,
  type UserTemplateDetail,
} from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
  openTemplatePicker,
} from "./chat-composer-template-gallery-test-helpers.ts";

export function customTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Q3 board review",
    sourceFilename: "q3-board-final-v4.pptx",
    kind: "presentation",
    coverUrl: "https://example.test/cover.png",
    coverHasMorePages: true,
    pageCount: 18,
    visibility: "private",
    ownerUserId: "user_self",
    ownerDisplayName: "Dana Self",
    canManage: true,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    pageUrls: ["https://example.test/page-1.png"],
    sourceUrl: "https://example.test/source.pptx?signature=abc",
    previewAssets: [],
    ...overrides,
  };
}

export function mockCustomTemplates(
  templates: readonly UserTemplateDetail[],
): void {
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      ),
    );
  });
}

/** `"fail"` answers 500; nothing at all answers immediately. */
type RequestOutcome = "fail" | undefined;

/**
 * List, detail, update and delete served from one mutable array, so a mutation is
 * observable the only way a user can observe it: by looking at the panel again.
 */
export function mockCustomTemplateStore(
  initial: readonly UserTemplateDetail[],
  outcomes: {
    readonly update?: () => RequestOutcome;
    readonly delete?: () => RequestOutcome;
  } = {},
) {
  let templates = [...initial];
  const serverError = {
    error: {
      code: "INTERNAL_SERVER_ERROR" as const,
      message: "User template request failed",
    },
  };
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(
      200,
      templates.map(
        ({ pageUrls: _pageUrls, sourceUrl: _sourceUrl, ...entry }) => {
          return entry;
        },
      ),
    );
  });
  context.mocks.api(userTemplatesContract.get, ({ params, respond }) => {
    const template = templates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    if (!template) {
      throw new Error(`No template mocked for ${params.templateId}`);
    }
    return respond(200, template);
  });
  context.mocks.api(
    userTemplatesContract.update,
    ({ body, params, respond }) => {
      if (outcomes.update?.() === "fail") {
        return respond(500, serverError);
      }
      const index = templates.findIndex((candidate) => {
        return candidate.id === params.templateId;
      });
      const current = templates[index];
      if (!current) {
        throw new Error(`No template mocked for ${params.templateId}`);
      }
      const updated: UserTemplateDetail = {
        ...current,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1000).toISOString(),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.visibility === undefined
          ? {}
          : { visibility: body.visibility }),
      };
      templates[index] = updated;
      const {
        pageUrls: _pageUrls,
        sourceUrl: _sourceUrl,
        previewAssets: _previewAssets,
        ...summary
      } = updated;
      return respond(200, summary);
    },
  );
  context.mocks.api(userTemplatesContract.delete, ({ params, respond }) => {
    if (outcomes.delete?.() === "fail") {
      return respond(500, serverError);
    }
    templates = templates.filter((template) => {
      return template.id !== params.templateId;
    });
    return respond(204);
  });
  return {
    replace: (next: readonly UserTemplateDetail[]) => {
      templates = [...next];
    },
  };
}

export function queryTabByText(text: string): HTMLElement | undefined {
  return queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

export function tabByText(text: string): HTMLElement {
  const tab = queryTabByText(text);
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

export function buttonByName(
  name: string,
  container: ParentNode = document.body,
) {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
}

export async function openCustomPanel(enabled = true) {
  const user = userEvent.setup({ delay: null });
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.CustomTemplates]: enabled,
    },
  });
  const dialog = await openTemplatePicker(user);
  return { user, dialog, capture };
}

export const DOCUMENT_SOURCE_URL =
  "https://storage.example.test/private-artifacts/brand-report.docx?signature=abc";

export function documentTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return customTemplate({
    id: "33333333-3333-4333-8333-333333333333",
    title: "Brand report",
    sourceFilename: "brand-report.docx",
    kind: "document",
    coverUrl: null,
    coverHasMorePages: false,
    pageCount: null,
    pageUrls: [],
    sourceUrl: DOCUMENT_SOURCE_URL,
    ...overrides,
  });
}

const ILLUSTRATION_SOURCE_URL =
  "https://storage.example.test/private-artifacts/market-day.png?signature=abc";
const MARKET_DAY_EXAMPLE_URL =
  "https://storage.example.test/private-artifacts/ref-market-day.png?signature=def";

export function illustrationTemplate(
  overrides: Partial<UserTemplateDetail> = {},
): UserTemplateDetail {
  return customTemplate({
    id: "44444444-4444-4444-8444-444444444444",
    title: "Market day",
    sourceFilename: "market-day.png",
    kind: "illustration",
    coverHasMorePages: false,
    pageCount: null,
    pageUrls: [],
    sourceUrl: ILLUSTRATION_SOURCE_URL,
    // Covered by the example its style produced, never by its source.
    coverUrl: MARKET_DAY_EXAMPLE_URL,
    previewAssets: [previewAsset("example-1", MARKET_DAY_EXAMPLE_URL)],
    ...overrides,
  });
}

export function previewAsset(name: string, url: string) {
  return {
    previewAssetId: `utp:44444444-4444-4444-8444-444444444444:${name}`,
    url,
    expiresAt: "2026-12-31T00:00:00.000Z",
  };
}
