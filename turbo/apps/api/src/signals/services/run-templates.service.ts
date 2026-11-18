import {
  templateGuidanceBundleSchema,
  templateGuidanceMountPath,
  type StoredTemplateGuidanceBundle,
  type TemplateGuidanceBundle,
} from "@okouai/api-contracts/contracts/template-guidance-bundle";
import {
  USER_TEMPLATE_KINDS,
  type UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import { computed, type Computed } from "ccstate";
import { enum as zEnum } from "zod";
import {
  resolveGenerationTemplatesGuidance,
  type LiveGenerationTemplate,
} from "../../lib/generation-template-prompt";
import {
  templateUsageIdentities,
  type TemplateUsageIdentity,
} from "../../lib/template-usage-identity";
import { projectUserMessage } from "./chat-user-message.service";
import { selectedUserPresentationTemplateIds } from "./presentation-template-data.service";
import type {
  RunPromptAndSkills,
  TemplateSkillVolume,
} from "./run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import {
  selectedUserTemplateIds,
  type MountedUserTemplate,
} from "./user-template-data.service";
import { createRunTemplateSources } from "./run-template-sources.service";
import type { AgentRunContextSignals } from "./agent-run-context.signals";

const templateKindSchema = zEnum(USER_TEMPLATE_KINDS);

type PrefetchedTemplates = Pick<
  AgentRunContextSignals,
  "requestTemplateInputId$" | "requestTemplateSources$"
>;

export type RunTemplatesResult =
  | (RunPromptAndSkills & {
      readonly skillVolumes: readonly TemplateSkillVolume[];
      readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
    })
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

type RunTemplateGuidanceResult =
  | {
      readonly skillVolumes: readonly TemplateSkillVolume[];
      readonly templateUsageIdentities: readonly TemplateUsageIdentity[];
      readonly renderPrompt: () => string;
    }
  | Extract<RunTemplatesResult, { readonly error: unknown }>;

export function createRunTemplates(
  event$: Parameters<typeof createRunTemplateGuidance>[0],
  orgId$: Parameters<typeof createRunTemplateGuidance>[1],
  disabledPaidTools$: Parameters<typeof createRunTemplateGuidance>[2],
  prefetched?: PrefetchedTemplates,
) {
  const guidance = createRunTemplateGuidance(
    event$,
    orgId$,
    disabledPaidTools$,
    prefetched,
  );
  const templates$ = computed(async (get): Promise<RunTemplatesResult> => {
    const prepared = await get(guidance.guidance$);
    if ("error" in prepared) {
      return prepared;
    }
    return {
      templateUsageIdentities: prepared.templateUsageIdentities,
      skillVolumes: prepared.skillVolumes,
      systemPromptVariables: {
        generationTemplatePrompt: prepared.renderPrompt(),
      },
      userPromptVariables: {},
    };
  });
  return { sources$: guidance.sources$, templates$ };
}

function createRunTemplateGuidance(
  event$: Computed<
    Promise<
      | (Pick<PickedThreadInputEvent, "userId" | "userMessage"> & {
          readonly id?: string;
        })
      | null
    >
  >,
  orgId$: Computed<Promise<string>>,
  disabledPaidTools$: Computed<Promise<readonly string[]>>,
  prefetched?: PrefetchedTemplates,
) {
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
  const sourceInput$ = computed(async (get) => {
    const [selection, orgId] = await Promise.all([
      get(selection$),
      get(orgId$),
    ]);
    return selection
      ? {
          userId: selection.userId,
          orgId,
          presentationIds: selectedUserPresentationTemplateIds(
            selection.templates,
          ),
          userTemplateIds: selectedUserTemplateIds(selection.templates),
        }
      : null;
  });
  const currentSources$ = createRunTemplateSources(sourceInput$);
  const sources$ = computed(async (get) => {
    const event = await get(event$);
    return prefetched &&
      event?.id !== undefined &&
      event.id === (await get(prefetched.requestTemplateInputId$))
      ? await get(prefetched.requestTemplateSources$)
      : await get(currentSources$);
  });
  const presentations$ = computed(async (get) => {
    const [selection, { presentations: rows }] = await Promise.all([
      get(selection$),
      get(sources$),
    ]);
    const ids = selectedUserPresentationTemplateIds(selection?.templates ?? []);
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
    const [selection, { mounted: rows }] = await Promise.all([
      get(selection$),
      get(sources$),
    ]);
    const ids = selectedUserTemplateIds(selection?.templates ?? []);
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
              kind: templateKindSchema.parse(row.kind),
              guidanceBundle: templateGuidanceBundleSchema.parse(
                row.guidanceBundle,
              ),
            },
          ];
    });
  });
  const guidance$ = computed(
    async (get): Promise<RunTemplateGuidanceResult> => {
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
    },
  );
  return { sources$, guidance$ };
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
}): RunTemplateGuidanceResult {
  const { templates, presentations, mounted, disabledPaidTools } = args;
  const guidance = resolveGenerationTemplatesGuidance(templates, {
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
  const references: (StoredTemplateGuidanceBundle & {
    readonly templateKind: UserTemplateKind;
  })[] = [
    ...presentations.map((row) => {
      return {
        ownerKind: "presentation-template" as const,
        templateKind: "presentation" as const,
        templateId: row.templateId,
        beforeMountPaths: [],
        ...row.guidanceBundle,
      };
    }),
    ...mounted.map((row) => {
      return {
        ownerKind: "user-template" as const,
        templateKind: row.kind,
        templateId: row.templateId,
        beforeMountPaths: [],
        ...row.guidanceBundle,
      };
    }),
  ];
  return {
    templateUsageIdentities: templateUsageIdentities(templates, mounted),
    renderPrompt: guidance.render,
    skillVolumes: references.map(({ templateKind, ...reference }) => {
      return {
        source: "request_additional_volume" as const,
        mountPath: templateGuidanceMountPath(reference),
        templateGuidanceBundle: reference,
        templateKind,
      };
    }),
  };
}
