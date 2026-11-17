import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { userTemplates } from "@okouai/db/schema/user-template";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";

interface TemplateSourceInput {
  readonly userId: string;
  readonly orgId: string;
  readonly presentationIds: readonly string[];
  readonly userTemplateIds: readonly string[];
}

const templateKind = sql`${userTemplates.manifest}->>'kind'`.mapWith(
  nullableDriverValueDecoder(pgTextDecoder),
);

/** Acquire authorized rows independently of guidance/model preparation. */
export function createRunTemplateSources(
  input$: Computed<Promise<TemplateSourceInput | null>>,
) {
  const presentations$ = computed(async (get) => {
    const input = await get(input$);
    if (!input?.presentationIds.length) {
      return [];
    }
    return await get(db$)
      .select({
        id: presentationTemplates.id,
        guidanceBundle: presentationTemplates.guidanceBundle,
      })
      .from(presentationTemplates)
      .where(
        and(
          inArray(presentationTemplates.id, [...input.presentationIds]),
          eq(presentationTemplates.orgId, input.orgId),
          or(
            eq(presentationTemplates.ownerUserId, input.userId),
            eq(presentationTemplates.visibility, "public"),
          ),
        ),
      );
  });
  const mounted$ = computed(async (get) => {
    const input = await get(input$);
    if (!input?.userTemplateIds.length) {
      return [];
    }
    return await get(db$)
      .select({
        id: userTemplates.id,
        kind: templateKind,
        guidanceBundle: userTemplates.guidanceBundle,
      })
      .from(userTemplates)
      .where(
        and(
          inArray(userTemplates.id, [...input.userTemplateIds]),
          eq(userTemplates.orgId, input.orgId),
          or(
            eq(userTemplates.ownerUserId, input.userId),
            eq(userTemplates.visibility, "organization"),
          ),
        ),
      );
  });
  return computed(async (get) => {
    const [presentations, mounted] = await Promise.all([
      get(presentations$),
      get(mounted$),
    ]);
    return { presentations, mounted };
  });
}
