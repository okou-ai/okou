import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import { i18n } from "../../i18n/index.ts";
import enUSCommon from "../../i18n/locales/en-US/common.json";

// The catalog lives in core, which ships one English string per field. Every
// surface that shows a template to the user reads its copy from here instead,
// keyed by the catalog slug. en-US carries the catalog's own wording, so a
// template added before its translations land keeps its English copy.
const TEMPLATE_COPY = enUSCommon.artifacts.templates.workflowCatalog;
const CATEGORY_COPY = enUSCommon.artifacts.templates.workflowCategories;

type TemplateSlug = keyof typeof TEMPLATE_COPY;
type TemplateCategory = keyof typeof CATEGORY_COPY;

const TEMPLATE_ID_PREFIX = "workflow-template:";

function isTemplateSlug(value: string): value is TemplateSlug {
  return Object.hasOwn(TEMPLATE_COPY, value);
}

function isTemplateCategory(value: string): value is TemplateCategory {
  return Object.hasOwn(CATEGORY_COPY, value);
}

/**
 * The template with its user-visible copy in the reader's language. The
 * connectors and the prompt guidance are unchanged: the guidance is context for
 * the agent, which answers in the user's language on its own.
 */
export function localizedWorkflowTemplate(
  item: WorkflowTemplateItem,
): WorkflowTemplateItem {
  const slug = item.id.slice(TEMPLATE_ID_PREFIX.length);
  if (!isTemplateSlug(slug)) {
    return item;
  }
  return {
    ...item,
    title: i18n.t(($) => {
      return $.artifacts.templates.workflowCatalog[slug].title;
    }),
    description: i18n.t(($) => {
      return $.artifacts.templates.workflowCatalog[slug].description;
    }),
    shortDescription: i18n.t(($) => {
      return $.artifacts.templates.workflowCatalog[slug].shortDescription;
    }),
  };
}

/** The persona group's name in the reader's language. */
export function localizedWorkflowTemplateCategory(category: string): string {
  if (!isTemplateCategory(category)) {
    return category;
  }
  return i18n.t(($) => {
    return $.artifacts.templates.workflowCategories[category];
  });
}
