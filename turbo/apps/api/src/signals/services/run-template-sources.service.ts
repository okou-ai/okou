import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { userTemplates } from "@okouai/db/schema/user-template";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
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
  return computed(async (get) => {
    const input = await get(input$);
    if (
      !input ||
      (!input.presentationIds.length && !input.userTemplateIds.length)
    ) {
      return { presentations: [], mounted: [] };
    }
    const db = get(db$);
    const presentations = db
      .select({
        isPresentation: sql`true`.mapWith(pgBooleanDecoder),
        id: presentationTemplates.id,
        kind: sql`null::text`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
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
    const mounted = db
      .select({
        isPresentation: sql`false`.mapWith(pgBooleanDecoder),
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
    const rows = await (input.presentationIds.length
      ? input.userTemplateIds.length
        ? presentations.unionAll(mounted)
        : presentations
      : mounted);
    return {
      presentations: rows.flatMap(({ isPresentation, id, guidanceBundle }) => {
        return isPresentation ? [{ id, guidanceBundle }] : [];
      }),
      mounted: rows.flatMap(({ isPresentation, id, kind, guidanceBundle }) => {
        return isPresentation ? [] : [{ id, kind, guidanceBundle }];
      }),
    };
  });
}
