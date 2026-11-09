import { describe, expect, it } from "vitest";

import { templateUsageIdentities } from "../template-usage-identity";

describe("template usage identities", () => {
  it("normalizes all live built-in categories with their reporting fields", () => {
    expect(
      templateUsageIdentities(
        [
          {
            type: "presentation",
            selection: {
              templateId: "template:html-ppt-meridian",
              colorSystemId: "color-system:ocean-deep",
              previewUrl: "https://private.example.com/deck-preview",
            },
          },
          {
            type: "website",
            selection: { websiteTemplateId: "website-template:black-slabs" },
          },
          {
            type: "illustration",
            selection: { illustrationStyleId: "image-style:ink-mascot" },
          },
          {
            type: "workflow",
            selection: {
              workflowTemplateId: "workflow-template:daily-standup-report",
            },
          },
          {
            type: "document",
            selection: { documentTemplateId: "document-template:mutual-nda" },
          },
        ],
        [],
      ),
    ).toStrictEqual([
      {
        category: "presentation",
        templateId: "template:html-ppt-meridian",
        templateSlug: "html-ppt-meridian",
        source: "builtin",
        colorSystemId: "color-system:ocean-deep",
      },
      {
        category: "website",
        templateId: "website-template:black-slabs",
        templateSlug: "black-slabs",
        source: "builtin",
      },
      {
        category: "illustration",
        templateId: "image-style:ink-mascot",
        templateSlug: "ink-mascot",
        source: "builtin",
      },
      {
        category: "workflow",
        templateId: "workflow-template:daily-standup-report",
        templateSlug: "daily-standup-report",
        source: "builtin",
        workflowCategory: "Engineering",
      },
      {
        category: "document",
        templateId: "document-template:mutual-nda",
        templateSlug: "mutual-nda",
        source: "builtin",
      },
    ]);
  });

  it("preserves supported unprefixed website and document selection IDs", () => {
    expect(
      templateUsageIdentities(
        [
          {
            type: "website",
            selection: { websiteTemplateId: "black-slabs" },
          },
          {
            type: "document",
            selection: { documentTemplateId: "document-mutual-nda" },
          },
        ],
        [],
      ),
    ).toStrictEqual([
      {
        category: "website",
        templateId: "black-slabs",
        templateSlug: "black-slabs",
        source: "builtin",
      },
      {
        category: "document",
        templateId: "document-mutual-nda",
        templateSlug: "document-mutual-nda",
        source: "builtin",
      },
    ]);
  });

  it("uses authorized mounted kinds for imported templates without exposing row IDs", () => {
    const presentationId = "10101010-1010-4010-8010-101010101010";
    const documentId = "20202020-2020-4020-8020-202020202020";
    const illustrationId = "30303030-3030-4030-8030-303030303030";

    expect(
      templateUsageIdentities(
        [
          { type: "custom", selection: { userTemplateId: documentId } },
          { type: "custom", selection: { userTemplateId: illustrationId } },
          { type: "custom", selection: { userTemplateId: presentationId } },
          { type: "custom", selection: { userTemplateId: documentId } },
        ],
        [
          { templateId: presentationId, kind: "presentation" },
          { templateId: documentId, kind: "document" },
          { templateId: illustrationId, kind: "illustration" },
        ],
      ),
    ).toStrictEqual([
      {
        category: "document",
        templateId: "user-template",
        templateSlug: "user-template",
        source: "user-imported",
      },
      {
        category: "illustration",
        templateId: "user-template",
        templateSlug: "user-template",
        source: "user-imported",
      },
      {
        category: "presentation",
        templateId: "user-template",
        templateSlug: "user-template",
        source: "user-imported",
      },
      {
        category: "document",
        templateId: "user-template",
        templateSlug: "user-template",
        source: "user-imported",
      },
    ]);
  });

  it("reports legacy private presentations by provenance without private selection metadata", () => {
    expect(
      templateUsageIdentities(
        [
          {
            type: "presentation",
            selection: {
              templateId: "user-template:40404040-4040-4040-8040-404040404040",
              colorSystemId: "color-system:prism",
              previewUrl: "https://private.example.com/confidential-deck",
            },
          },
        ],
        [],
      ),
    ).toStrictEqual([
      {
        category: "presentation",
        templateId: "user-template",
        templateSlug: "user-template",
        source: "user-imported",
      },
    ]);
  });

  it("keeps each selection occurrence in marker order, including identical templates", () => {
    expect(
      templateUsageIdentities(
        [
          {
            type: "presentation",
            selection: { templateId: "template:html-ppt-meridian" },
          },
          {
            type: "document",
            selection: { documentTemplateId: "document-template:mutual-nda" },
          },
          {
            type: "presentation",
            selection: {
              templateId: "template:html-ppt-meridian",
              colorSystemId: "color-system:prism",
            },
          },
          {
            type: "presentation",
            selection: { templateId: "template:html-ppt-meridian" },
          },
        ],
        [],
      ),
    ).toStrictEqual([
      {
        category: "presentation",
        templateId: "template:html-ppt-meridian",
        templateSlug: "html-ppt-meridian",
        source: "builtin",
      },
      {
        category: "document",
        templateId: "document-template:mutual-nda",
        templateSlug: "mutual-nda",
        source: "builtin",
      },
      {
        category: "presentation",
        templateId: "template:html-ppt-meridian",
        templateSlug: "html-ppt-meridian",
        source: "builtin",
        colorSystemId: "color-system:prism",
      },
      {
        category: "presentation",
        templateId: "template:html-ppt-meridian",
        templateSlug: "html-ppt-meridian",
        source: "builtin",
      },
    ]);
  });

  it("returns no identities without a selection even when private templates are mounted", () => {
    expect(
      templateUsageIdentities(
        [],
        [
          {
            templateId: "50505050-5050-4050-8050-505050505050",
            kind: "document",
          },
        ],
      ),
    ).toStrictEqual([]);
  });
});
