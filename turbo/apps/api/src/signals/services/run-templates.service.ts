import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { userTemplates } from "@okouai/db/schema/user-template";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, or } from "drizzle-orm";
import { buildGenerationTemplatesPrompt } from "../../lib/generation-template-prompt";
import { db$ } from "../external/db";
import { projectUserMessage } from "./chat-user-message.service";
import {
  selectedUserPresentationTemplateIds,
  userPresentationTemplateVolumes,
  type PresentationTemplateVolume,
} from "./presentation-template-data.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import {
  selectedUserTemplateIds,
  userTemplateVolumes,
} from "./user-template-data.service";

export type RunTemplatesResult =
  | {
      readonly generationTemplatePrompt: string;
      readonly presentationTemplateVolumes: readonly PresentationTemplateVolume[];
    }
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
  features$: Computed<Promise<FeatureSwitchContext>>,
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
      .select({ id: presentationTemplates.id })
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
    const accessible = new Set(
      rows.map((row) => {
        return row.id;
      }),
    );
    return ids.filter((id) => {
      return accessible.has(id);
    });
  });
  const mounted$ = computed(async (get) => {
    const [selection, features] = await Promise.all([
      get(selection$),
      get(features$),
    ]);
    if (!selection) {
      return [];
    }
    const ids = selectedUserTemplateIds(selection.templates);
    if (
      !isFeatureEnabled(FeatureSwitchKey.CustomTemplates, features) ||
      !ids.length
    ) {
      return [];
    }
    const rows = await get(db$)
      .select({ id: userTemplates.id, manifest: userTemplates.manifest })
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
        return [row.id, row.manifest.kind];
      }),
    );
    return ids.flatMap((id) => {
      const kind = kinds.get(id);
      return kind === undefined ? [] : [{ templateId: id, kind }];
    });
  });
  return computed(async (get): Promise<RunTemplatesResult> => {
    const [selection, presentations, mounted] = await Promise.all([
      get(selection$),
      get(presentations$),
      get(mounted$),
    ]);
    const guidance = buildGenerationTemplatesPrompt(
      selection?.templates ?? [],
      {
        mountedUserPresentationTemplateIds: presentations,
        mountedUserTemplates: mounted,
      },
    );
    if (guidance.status === "invalid") {
      return { error: { code: "BAD_REQUEST", message: guidance.message } };
    }
    return {
      generationTemplatePrompt: guidance.prompt,
      presentationTemplateVolumes: [
        ...userPresentationTemplateVolumes(presentations),
        ...userTemplateVolumes(mounted),
      ],
    };
  });
}
