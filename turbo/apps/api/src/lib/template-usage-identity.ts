import { isUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { findWorkflowTemplateItem } from "@okouai/core/workflow-template-items";

import type { MountedUserTemplate } from "../signals/services/user-template-data.service";
import type { LiveGenerationTemplate } from "./generation-template-prompt";

export type TemplateUsageIdentity = {
  readonly category:
    "presentation" | "website" | "illustration" | "workflow" | "document";
  readonly templateId: string;
  readonly templateSlug: string;
  readonly source: "builtin" | "user-imported";
  readonly colorSystemId?: string;
  readonly workflowCategory?: string;
};

function builtinIdentity(
  category: TemplateUsageIdentity["category"],
  templateId: string,
): TemplateUsageIdentity {
  const separator = templateId.indexOf(":");
  return {
    category,
    templateId,
    templateSlug:
      separator === -1 ? templateId : templateId.slice(separator + 1),
    source: "builtin",
  };
}

function userImportedIdentity(
  category: MountedUserTemplate["kind"],
): TemplateUsageIdentity {
  return {
    category,
    templateId: "user-template",
    templateSlug: "user-template",
    source: "user-imported",
  };
}

/**
 * Normalize only after the caller resolves guidance for the whole batch.
 * Mounted custom-template kinds must come from authorized rows, not selections.
 * Preserve marker order and repeated selections; private identities collapse to
 * provenance, never to a row ID, title, preview URL, or package path.
 */
export function templateUsageIdentities(
  templates: readonly LiveGenerationTemplate[],
  mountedUserTemplates: readonly MountedUserTemplate[],
): readonly TemplateUsageIdentity[] {
  return templates.map((template): TemplateUsageIdentity => {
    switch (template.type) {
      case "presentation": {
        const { templateId, colorSystemId } = template.selection;
        if (isUserPresentationTemplateId(templateId)) {
          return userImportedIdentity("presentation");
        }
        return {
          ...builtinIdentity("presentation", templateId),
          ...(colorSystemId === undefined ? {} : { colorSystemId }),
        };
      }
      case "website": {
        return builtinIdentity("website", template.selection.websiteTemplateId);
      }
      case "illustration": {
        return builtinIdentity(
          "illustration",
          template.selection.illustrationStyleId,
        );
      }
      case "workflow": {
        const { workflowTemplateId } = template.selection;
        const item = findWorkflowTemplateItem(workflowTemplateId);
        return {
          ...builtinIdentity("workflow", workflowTemplateId),
          ...(item === undefined ? {} : { workflowCategory: item.category }),
        };
      }
      case "document": {
        return builtinIdentity(
          "document",
          template.selection.documentTemplateId,
        );
      }
      case "custom": {
        const mounted = mountedUserTemplates.find((candidate) => {
          return candidate.templateId === template.selection.userTemplateId;
        });
        if (!mounted) {
          throw new Error("Validated custom template is not mounted");
        }
        return userImportedIdentity(mounted.kind);
      }
      default: {
        throw new Error("Validated generation template kind is unsupported");
      }
    }
  });
}
