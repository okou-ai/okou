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
import { db$ } from "../external/db";
import { projectUserMessage } from "./chat-user-message.service";
import {
  selectedUserPresentationTemplateIds,
  userPresentationTemplateVolumes,
} from "./presentation-template-data.service";
import type { RunPromptAndSkills } from "./run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import {
  selectedUserTemplateIds,
  userTemplateVolumes,
  type MountedUserTemplate,
} from "./user-template-data.service";

export type RunTemplatesResult =
  | RunPromptAndSkills
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
  orgId: string,
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
        ? [{ templateId: id, guidanceBundle: row.guidanceBundle }]
        : [];
    });
  });
  const mounted$ = computed(async (get) => {
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
              guidanceBundle: row.guidanceBundle,
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
    readonly guidanceBundle: TemplateGuidanceBundle | null;
  }[];
  readonly mounted: readonly (MountedUserTemplate & {
    readonly guidanceBundle: TemplateGuidanceBundle | null;
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
  // #45716 C03: retained NULL owners use legacy Storage until the separately
  // reviewed backfill and legacy-writer/rollback retirement are complete.
  const references: StoredTemplateGuidanceBundle[] = [
    ...presentations.flatMap((row) => {
      return row.guidanceBundle === null
        ? []
        : [
            {
              ownerKind: "presentation-template" as const,
              templateId: row.templateId,
              beforeMountPaths: [],
              ...templateGuidanceBundleSchema.parse(row.guidanceBundle),
            },
          ];
    }),
    ...mounted.flatMap((row) => {
      return row.guidanceBundle === null
        ? []
        : [
            {
              ownerKind: "user-template" as const,
              templateId: row.templateId,
              beforeMountPaths: [],
              ...templateGuidanceBundleSchema.parse(row.guidanceBundle),
            },
          ];
    }),
  ];
  const bundlesByMount = new Map(
    references.map((ref) => {
      return [templateGuidanceMountPath(ref), ref];
    }),
  );
  return {
    systemPromptVariables: { generationTemplatePrompt: guidance.prompt },
    userPromptVariables: {},
    skillVolumes: [
      ...userPresentationTemplateVolumes(
        presentations.map((row) => {
          return row.templateId;
        }),
      ),
      ...userTemplateVolumes(mounted),
    ].map((volume) => {
      const reference = bundlesByMount.get(volume.mountPath);
      return reference
        ? {
            source: "request_additional_volume" as const,
            mountPath: volume.mountPath,
            templateGuidanceBundle: reference,
          }
        : { ...volume, source: "request_additional_volume" as const };
    }),
  };
}
