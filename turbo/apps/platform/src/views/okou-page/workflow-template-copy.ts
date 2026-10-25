import type { WorkflowTemplateItem } from "@okouai/core/workflow-template-items";
import { i18n } from "../../i18n/index.ts";
import type enUSCommon from "../../i18n/locales/en-US/common.json";
import { DEFAULT_LOCALE, DEFAULT_NAMESPACE } from "../../i18n/resources.ts";

// The catalog lives in core, which ships one English string per field. Every
// surface that shows a template to the user reads its copy from here instead,
// keyed by the catalog slug. en-US carries the catalog's own wording, so a
// template added before its translations land keeps its English copy.
type TemplateSlug = keyof typeof enUSCommon.artifacts.templates.workflowCatalog;
type TemplateCategory =
  keyof typeof enUSCommon.artifacts.templates.workflowCategories;

const TEMPLATE_ID_PREFIX = "workflow-template:";

function isTemplateSlug(value: string): value is TemplateSlug {
  return i18n.exists(`artifacts.templates.workflowCatalog.${value}.title`, {
    lng: DEFAULT_LOCALE,
    ns: DEFAULT_NAMESPACE,
  });
}

function isTemplateCategory(value: string): value is TemplateCategory {
  return i18n.exists(`artifacts.templates.workflowCategories.${value}`, {
    lng: DEFAULT_LOCALE,
    ns: DEFAULT_NAMESPACE,
  });
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
