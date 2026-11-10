import {
  templateGuidanceBundleSchema,
  templateGuidanceMountPath,
  type StoredTemplateGuidanceBundle,
  type TemplateGuidanceBundle,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { userTemplates } from "@okouai/db/schema/user-template";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  buildGenerationTemplatesPrompt,
  type LiveGenerationTemplate,
} from "../../lib/generation-template-prompt";
import {
  templateUsageIdentities,
  type TemplateUsageIdentity,
} from "../../lib/template-usage-identity";
import { db$ } from "../external/db";
import { projectUserMessage } from "./chat-user-message.service";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import type { RunPromptAndSkills } from "./run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import {
  selectedUserTemplateIds,
  type MountedUserTemplate,
} from "./user-template-data.service";

export type RunTemplatesResult =
  | (RunPromptAndSkills & {
      readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
    })
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export function createRunTemplates(
  event$: Computed<
    Promise<Pick<PickedThreadInputEvent, "userId" | "userMessage"> | null>
  >,
  orgId$: Computed<Promise<string>>,
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
): Computed<Promise<RunTemplatesResult>> {
  const selection$ = computed(async (get) => {
    const event = await get(event$);
    if (!event) {
      return null;
    }
    if (!event.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }
    return {
      userId: event.userId,
      templates: projectUserMessage(event.userMessage).templates,
    };
  });
  const presentations$ = computed(async (get) => {
    const orgId = await get(orgId$);
    const selection = await get(selection$);
    if (!selection) {
      return [];
    }
    const ids = selectedUserPresentationTemplateIds(selection.templates);
    if (!ids.length) {
      return [];
    }
    const rows = await get(db$)
      .select({
        id: presentationTemplates.id,
        guidanceBundle: presentationTemplates.guidanceBundle,
      })
      .from(presentationTemplates)
      .where(
        and(
          inArray(presentationTemplates.id, [...ids]),
          eq(presentationTemplates.orgId, orgId),
          or(
            eq(presentationTemplates.ownerUserId, selection.userId),
            eq(presentationTemplates.visibility, "public"),
          ),
        ),
      );
    const accessible = new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
    return ids.flatMap((id) => {
      const row = accessible.get(id);
      return row
        ? [
            {
              templateId: id,
              guidanceBundle: templateGuidanceBundleSchema.parse(
                row.guidanceBundle,
              ),
            },
          ]
        : [];
    });
  });
  const mounted$ = computed(async (get) => {
    const orgId = await get(orgId$);
    const selection = await get(selection$);
    if (!selection) {
      return [];
    }
    const ids = selectedUserTemplateIds(selection.templates);
    if (!ids.length) {
      return [];
    }
    const rows = await get(db$)
      .select({
        id: userTemplates.id,
        manifest: userTemplates.manifest,
        guidanceBundle: userTemplates.guidanceBundle,
      })
      .from(userTemplates)
      .where(
        and(
          inArray(userTemplates.id, [...ids]),
          eq(userTemplates.orgId, orgId),
          or(
            eq(userTemplates.ownerUserId, selection.userId),
            eq(userTemplates.visibility, "organization"),
          ),
        ),
      );
    const kinds = new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
    return ids.flatMap((id) => {
      const row = kinds.get(id);
      return row === undefined
        ? []
        : [
            {
              templateId: id,
              kind: row.manifest.kind,
              guidanceBundle: templateGuidanceBundleSchema.parse(
                row.guidanceBundle,
              ),
            },
          ];
    });
  });
  return computed(async (get): Promise<RunTemplatesResult> => {
    const [selection, presentations, mounted, disabledPaidTools] =
      await Promise.all([
        get(selection$),
        get(presentations$),
        get(mounted$),
        get(disabledPaidTools$),
      ]);
    return buildRunTemplateGuidance({
      templates: selection?.templates ?? [],
      presentations,
      mounted,
      disabledPaidTools,
    });
  });
}

function buildRunTemplateGuidance(args: {
  readonly templates: readonly LiveGenerationTemplate[];
  readonly presentations: readonly {
    readonly templateId: string;
    readonly guidanceBundle: TemplateGuidanceBundle;
  }[];
  readonly mounted: readonly (MountedUserTemplate & {
    readonly guidanceBundle: TemplateGuidanceBundle;
  })[];
  readonly disabledPaidTools: readonly string[];
}): RunTemplatesResult {
  const { templates, presentations, mounted, disabledPaidTools } = args;
  const guidance = buildGenerationTemplatesPrompt(templates, {
    mountedUserPresentationTemplateIds: presentations.map((row) => {
      return row.templateId;
    }),
    mountedUserTemplates: mounted,
    includeManagedImageInstructions:
      !disabledPaidTools.includes("image-generation"),
  });
  if (guidance.status === "invalid") {
    return { error: { code: "BAD_REQUEST", message: guidance.message } };
  }
  const references: StoredTemplateGuidanceBundle[] = [
    ...presentations.map((row) => {
      return {
        ownerKind: "presentation-template" as const,
        templateId: row.templateId,
        beforeMountPaths: [],
        ...row.guidanceBundle,
      };
    }),
    ...mounted.map((row) => {
      return {
        ownerKind: "user-template" as const,
        templateId: row.templateId,
        beforeMountPaths: [],
        ...row.guidanceBundle,
      };
    }),
  ];
  return {
    templateUsageIdentities: templateUsageIdentities(templates, mounted),
    systemPromptVariables: { generationTemplatePrompt: guidance.prompt },
    userPromptVariables: {},
    skillVolumes: references.map((reference) => {
      return {
        source: "request_additional_volume" as const,
        mountPath: templateGuidanceMountPath(reference),
        templateGuidanceBundle: reference,
      };
    }),
  };
}
