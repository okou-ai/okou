import {
  userTemplatesContract,
  type UserTemplateCatalogEntry,
  type UserTemplateDetail,
  type UserTemplateSummary,
} from "@okouai/api-contracts/contracts/user-templates";

import { mockApi } from "../msw-contract.ts";

/**
 * Nothing can seed a row until the reverse run publishes one, so an empty
 * catalog is what every workspace sees until a test says otherwise.
 */
let mockUserTemplates: UserTemplateDetail[] = [];

function summary(template: UserTemplateDetail): UserTemplateSummary {
  const {
    pageUrls: _pageUrls,
    previewAssets: _previewAssets,
    ...templateSummary
  } = template;
  return templateSummary;
}

function catalogEntry(template: UserTemplateDetail): UserTemplateCatalogEntry {
  const { pageUrls: _pageUrls, ...entry } = template;
  return entry;
}

function notFound(templateId: string) {
  return {
    error: {
      code: "NOT_FOUND" as const,
      message: `User template not found: ${templateId}`,
    },
  };
}

export function resetMockUserTemplates(): void {
  mockUserTemplates = [];
}

export const apiUserTemplatesHandlers = [
  mockApi(userTemplatesContract.list, ({ respond }) => {
    return respond(200, mockUserTemplates.map(catalogEntry));
  }),
  mockApi(userTemplatesContract.get, ({ params, respond }) => {
    const template = mockUserTemplates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    return template
      ? respond(200, template)
      : respond(404, notFound(params.templateId));
  }),
  mockApi(userTemplatesContract.resolvePreviewUrls, ({ body, respond }) => {
    const requestedPreviewAssetIds = new Set(body.previewAssetIds);
    const assets = mockUserTemplates.flatMap((template) => {
      return template.previewAssets.filter((asset) => {
        return requestedPreviewAssetIds.has(asset.previewAssetId);
      });
    });
    return respond(200, { assets });
  }),
  mockApi(userTemplatesContract.update, ({ body, params, respond }) => {
    const index = mockUserTemplates.findIndex((candidate) => {
      return candidate.id === params.templateId;
    });
    if (index === -1) {
      return respond(404, notFound(params.templateId));
    }
    const current = mockUserTemplates[index]!;
    const updated: UserTemplateDetail = {
      ...current,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      updatedAt: new Date().toISOString(),
    };
    mockUserTemplates[index] = updated;
    return respond(200, summary(updated));
  }),
  mockApi(userTemplatesContract.delete, ({ params, respond }) => {
    const template = mockUserTemplates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    if (!template) {
      return respond(404, notFound(params.templateId));
    }
    mockUserTemplates = mockUserTemplates.filter((candidate) => {
      return candidate.id !== params.templateId;
    });
    return respond(204);
  }),
];
