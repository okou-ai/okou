import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";

import {
  generationTemplateKind,
  type GenerationTemplateKind,
} from "./generation-template-kind";
import { isUserPresentationTemplateId } from "./presentation-template-selection";
import { findWorkflowTemplateItem } from "./workflow-template-items";

/**
 * Analytics category for one template selection.
 *
 * These are reporting buckets, not UI identifiers. The picker's own tab id for
 * presentations is `"slides"` (see `resolveTemplatePickerCategory` in the
 * platform composer); this enum stays spelled out here instead, so a tab rename
 * cannot silently rewrite historical reporting.
 *
 * It is listed separately from `GenerationTemplateKind` rather than aliased to
 * it on purpose. `videoIdentity` assigns a kind straight into this type, so
 * adding a kind fails to compile until someone decides what it reports as —
 * a new bucket cannot appear in reporting by accident.
 */
export type GenerationTemplateCategory =
  | "avatar"
  | "custom"
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
 * The six built-in catalogues each name their templates differently
 * (`template:`, `website-template:`, `image-style:`, `video-template:`,
 * `workflow-template:`, `avatar-template:`). Reporting
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

/** What Intro Video selections reported before they had their own wire type. */
const RETIRED_INTRO_VIDEO_TEMPLATE_ID = "explainer-video";

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
 * Talking avatar is reported as its own category even though it travels inside
 * the video envelope.
 *
 * Both share `type: "video"` on the wire, so bucketing on `type` alone would
 * merge two products with two separate catalogues into one number. The split
 * itself belongs to `generationTemplateKind`; this only records what each kind
 * reports as.
 */
function videoIdentity(
  selection: Extract<GenerationTemplateRequest, { type: "video" }>["selection"],
): GenerationTemplateIdentity {
  const kind: GenerationTemplateKind = generationTemplateKind({
    type: "video",
    selection,
  });
  return builtinIdentity(kind, selection.stylePresetId);
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
    case "custom": {
      // Its own bucket, and never the row id. What this selection can say
      // without reading the database is its provenance, and reporting a row id
      // would put one workspace's private template into a shared metric.
      return {
        category: "custom",
        templateId: USER_IMPORTED_TEMPLATE_ID,
        templateSlug: USER_IMPORTED_TEMPLATE_ID,
        source: "user-imported",
      };
    }
    case "intro-video": {
      // Retired product; the rows are append-only. Reported in the video
      // bucket under the identifier the pre-split selections already used, so
      // one removed product does not open a permanent reporting category.
      return builtinIdentity("video", RETIRED_INTRO_VIDEO_TEMPLATE_ID);
    }
    default: {
      return unreachableGenerationTemplateType(request);
    }
  }
}
