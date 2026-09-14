import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";

import { parseAvatarTemplateStylePresetId } from "./avatar-template";
import { isUserPresentationTemplateId } from "./presentation-template-selection";
import { findWorkflowTemplateItem } from "./workflow-template-items";

/**
 * Analytics category for one template selection.
 *
 * These are reporting buckets, not UI identifiers. The picker's own tab id for
 * presentations is `"slides"` (see `resolveTemplatePickerCategory` in the
 * platform composer); this enum follows the wire contract's `type` instead, so
 * a tab rename cannot silently rewrite historical reporting.
 */
export type GenerationTemplateCategory =
  | "avatar"
  | "brand-motion"
  | "illustration"
  | "presentation"
  | "video"
  | "website"
  | "workflow";

/** Where the selected template came from. */
export type GenerationTemplateSource = "builtin" | "user-imported";

/**
 * One template selection, normalised into a shape that is comparable across
 * categories.
 *
 * The built-in catalogues each name their templates differently
 * (`template:`, `website-template:`, `image-style:`, `video-template:`,
 * `workflow-template:`, `avatar-template:`, `brand-motion:`). Reporting
 * on the raw selection would produce one incomparable property per category, so
 * every consumer reads this instead.
 */
export interface GenerationTemplateIdentity {
  readonly category: GenerationTemplateCategory;
  /** The identifier exactly as it appears in the selection. */
  readonly templateId: string;
  /** `templateId` without its namespace prefix; the readable form for reports. */
  readonly templateSlug: string;
  readonly source: GenerationTemplateSource;
  /** Presentation only: the colour system chosen alongside the template. */
  readonly colorSystemId?: string;
  /** Workflow only: the persona bucket the template belongs to. */
  readonly workflowCategory?: string;
}

/**
 * A private presentation template is reported by provenance, never by row id.
 *
 * The row id identifies a document belonging to one user. It joins to nothing
 * outside the database, and admitting it into reporting would put an unbounded
 * set of per-user identifiers into a breakdown that only needs to distinguish
 * built-in templates from bring-your-own ones.
 */
const USER_IMPORTED_TEMPLATE_ID = "user-template";

function unreachableGenerationTemplateType(request: never): never {
  throw new Error(
    `Unsupported generation template type: ${JSON.stringify(request)}`,
  );
}

/**
 * Drop the namespace prefix shared by every catalogue's identifiers.
 *
 * One rule for all categories rather than a per-category strip list: the
 * prefixes are an implementation detail of how each catalogue namespaces
 * itself, and a selection carrying no prefix at all (older rows predate some of
 * them) has to survive unchanged rather than being mangled.
 */
function templateSlugFromId(templateId: string): string {
  const separatorIndex = templateId.indexOf(":");
  return separatorIndex === -1
    ? templateId
    : templateId.slice(separatorIndex + 1);
}

function builtinIdentity(
  category: GenerationTemplateCategory,
  templateId: string,
): GenerationTemplateIdentity {
  return {
    category,
    templateId,
    templateSlug: templateSlugFromId(templateId),
    source: "builtin",
  };
}

function presentationIdentity(
  selection: Extract<
    GenerationTemplateRequest,
    { type: "presentation" }
  >["selection"],
): GenerationTemplateIdentity {
  if (isUserPresentationTemplateId(selection.templateId)) {
    return {
      category: "presentation",
      templateId: USER_IMPORTED_TEMPLATE_ID,
      templateSlug: USER_IMPORTED_TEMPLATE_ID,
      source: "user-imported",
    };
  }
  return {
    ...builtinIdentity("presentation", selection.templateId),
    ...(selection.colorSystemId === undefined
      ? {}
      : { colorSystemId: selection.colorSystemId }),
  };
}

/**
 * Avatar templates have their own reporting category even though they travel
 * inside the video envelope.
 *
 * The contract reuses `type: "video"` for talking-avatar selections so that
 * bundles deployed before the split can still parse newer messages. Bucketing
 * on `type` alone would merge text-to-video with talking-avatar usage, which
 * are different products with different catalogues.
 */
function videoIdentity(
  selection: Extract<GenerationTemplateRequest, { type: "video" }>["selection"],
): GenerationTemplateIdentity {
  const avatarId = parseAvatarTemplateStylePresetId(selection.stylePresetId);
  return builtinIdentity(
    avatarId === undefined ? "video" : "avatar",
    selection.stylePresetId,
  );
}

function workflowIdentity(
  selection: Extract<
    GenerationTemplateRequest,
    { type: "workflow" }
  >["selection"],
): GenerationTemplateIdentity {
  const item = findWorkflowTemplateItem(selection.workflowTemplateId);
  return {
    ...builtinIdentity("workflow", selection.workflowTemplateId),
    ...(item === undefined ? {} : { workflowCategory: item.category }),
  };
}

/**
 * Normalise one template selection for reporting.
 *
 * Every branch of the wire contract's discriminated union is mapped, so an
 * unrecognised `type` is unreachable: the request body is validated against
 * that union before a route sees it, and the two paths that read a persisted
 * message only reach this function for a selection the prompt builder already
 * resolved. The remaining case is therefore a programmer error and throws
 * rather than inventing a category.
 */
export function generationTemplateIdentity(
  request: GenerationTemplateRequest,
): GenerationTemplateIdentity {
  switch (request.type) {
    case "presentation": {
      return presentationIdentity(request.selection);
    }
    case "video": {
      return videoIdentity(request.selection);
    }
    case "brand-motion": {
      return builtinIdentity("brand-motion", request.selection.templateId);
    }
    case "illustration": {
      return builtinIdentity(
        "illustration",
        request.selection.illustrationStyleId,
      );
    }
    case "workflow": {
      return workflowIdentity(request.selection);
    }
    case "website": {
      return builtinIdentity("website", request.selection.websiteTemplateId);
    }
    default: {
      return unreachableGenerationTemplateType(request);
    }
  }
}
