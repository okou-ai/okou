import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { userTemplates } from "@okouai/db/schema/user-template";
import { computed, type Computed } from "ccstate";
import { and, eq, inArray, notExists, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { joinAll } from "../utils";
import type { TemplateSkillVolume } from "./run-prompt-and-skills";

interface TemplateIdentity {
  readonly userId: string;
  readonly orgId: string;
}

interface TemplateSourceInput extends TemplateIdentity {
  readonly presentationIds: readonly string[];
  readonly userTemplateIds: readonly string[];
}

const templateKind = sql`${userTemplates.manifest}->>'kind'`.mapWith(
  nullableDriverValueDecoder(pgTextDecoder),
);

function presentationAccessCondition(input: TemplateIdentity) {
  return and(
    eq(presentationTemplates.orgId, input.orgId),
    or(
      eq(presentationTemplates.ownerUserId, input.userId),
      eq(presentationTemplates.visibility, "public"),
    ),
  );
}

function userTemplateAccessCondition(input: TemplateIdentity) {
  return and(
    eq(userTemplates.orgId, input.orgId),
    or(
      eq(userTemplates.ownerUserId, input.userId),
      eq(userTemplates.visibility, "organization"),
    ),
  );
}

/** Validate accepted identities in the caller's current authorization snapshot. */
export function acceptedRunTemplatesAvailableCondition(
  input: TemplateIdentity & {
    readonly volumes: readonly TemplateSkillVolume[];
  },
): SQL {
  if (input.volumes.length === 0) {
    return sql`true`;
  }
  // Bind one rowset so the query shape stays fixed for larger selections.
  const expected = input.volumes.map((volume) => {
    const reference = volume.templateGuidanceBundle;
    return {
      ownerKind: reference.ownerKind,
      templateId: reference.templateId,
      templateKind: volume.templateKind,
      guidanceBundle: {
        sha256: reference.sha256,
        archiveBytes: reference.archiveBytes,
      },
    };
  });
  const rows = sql`jsonb_to_recordset(${JSON.stringify(expected)}::jsonb) AS expected_template("ownerKind" text, "templateId" uuid, "templateKind" text, "guidanceBundle" jsonb)`;
  const id = sql`expected_template."templateId"`;
  const ownerKind = sql`expected_template."ownerKind"`;
  const bundle = sql`expected_template."guidanceBundle"`;
  const builder = new QueryBuilder();
  const presentation = builder
    .select({ id: presentationTemplates.id })
    .from(presentationTemplates)
    .where(
      and(
        eq(presentationTemplates.id, id),
        presentationAccessCondition(input),
        eq(presentationTemplates.guidanceBundle, bundle),
      ),
    );
  const custom = builder
    .select({ id: userTemplates.id })
    .from(userTemplates)
    .where(
      and(
        eq(userTemplates.id, id),
        userTemplateAccessCondition(input),
        eq(templateKind, sql`expected_template."templateKind"`),
        eq(userTemplates.guidanceBundle, bundle),
      ),
    );
  return notExists(
    builder
      .select({ id: id.mapWith(userTemplates.id) })
      .from(rows)
      .where(
        or(
          and(eq(ownerKind, "presentation-template"), notExists(presentation)),
          and(eq(ownerKind, "user-template"), notExists(custom)),
        ),
      ),
  );
}

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
          presentationAccessCondition(input),
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
          userTemplateAccessCondition(input),
        ),
      );
  });
  return computed(async (get) => {
    const [presentations, mounted] = await joinAll([
      get(presentations$),
      get(mounted$),
    ]);
    return { presentations, mounted };
  });
}
