import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../lib/db";

/** The current API cannot write the historical render state without a locator. */
export async function removeIntroVideoRenderProjectStorageFixture(
  generationId: string,
): Promise<void> {
  const updated = await db()
    .update(builtInGenerationJobs)
    .set({
      request: sql`${builtInGenerationJobs.request} #- '{renderState,projectStorage}'`,
    })
    .where(
      and(
        eq(builtInGenerationJobs.id, generationId),
        sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = 'intro-video-render'`,
        sql`${builtInGenerationJobs.request}->'renderState' ? 'projectStorage'`,
        sql`${builtInGenerationJobs.request}->'renderState'->>'submittedAt' IS NULL`,
      ),
    )
    .returning({ id: builtInGenerationJobs.id });
  if (updated.length !== 1) {
    throw new Error(
      "Expected one unsubmitted render with a stored input location",
    );
  }
}

/** Reproduce an active generation job persisted before publicBrand existed. */
export async function removeBuiltInGenerationPublicBrandFixture(
  generationId: string,
): Promise<void> {
  const [job] = await db()
    .select({ request: builtInGenerationJobs.request })
    .from(builtInGenerationJobs)
    .where(eq(builtInGenerationJobs.id, generationId))
    .limit(1);
  const internal = job?.request.__builtInGeneration;
  if (
    !job ||
    typeof internal !== "object" ||
    internal === null ||
    Array.isArray(internal) ||
    !Object.hasOwn(internal, "publicBrand")
  ) {
    throw new Error("Expected one active branded built-in generation job");
  }

  const legacyInternal = Object.fromEntries(
    Object.entries(internal).filter(([key]) => {
      return key !== "publicBrand";
    }),
  );
  const updated = await db()
    .update(builtInGenerationJobs)
    .set({
      request: {
        ...job.request,
        __builtInGeneration: legacyInternal,
      },
    })
    .where(eq(builtInGenerationJobs.id, generationId))
    .returning({ id: builtInGenerationJobs.id });
  if (updated.length !== 1) {
    throw new Error("Expected one active built-in generation job");
  }
}
