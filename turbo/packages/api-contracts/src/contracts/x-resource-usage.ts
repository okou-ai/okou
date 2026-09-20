import { z } from "zod";

export const X_RESOURCE_USAGE_MAX_IDS = 1_000;

const quantitySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const occurrenceSchema = quantitySchema.min(1);

// These are transient explanations for counted units, never ledger metadata.
const remainderReasonSchema = z.enum([
  "missing_id",
  "unsupported_resource",
  "identity_limit",
  "parse_fallback",
]);

/** Resource-aware billing input. Validation, resource recording and atomic
 * accounting always apply, including site-wide daily billing deduplication.
 * Observations are admitted for the current and previous UTC dates. */
export const xResourceUsageEventSchema = z
  .object({
    protocol: z.literal("x-resource-v1"),
    idempotencyKey: z.uuid(),
    kind: z.literal("connector"),
    provider: z.literal("x"),
    // The billing categories derive namespaces: posts.read -> post, user.read -> user.
    category: z.enum(["posts.read", "user.read"]),
    quantity: quantitySchema,
    observedAt: z.iso.datetime({ precision: 3 }),
    resources: z
      .array(
        z
          .object({
            // Absolute end: JavaScript's $ also matches before a final newline.
            id: z.string().regex(/^[0-9]{1,32}(?![\s\S])/),
            occurrences: occurrenceSchema,
          })
          .strict(),
      )
      .max(X_RESOURCE_USAGE_MAX_IDS),
    remainder: z
      .array(
        z
          .object({
            reason: remainderReasonSchema,
            quantity: occurrenceSchema,
          })
          .strict(),
      )
      .max(remainderReasonSchema.options.length),
  })
  .strict()
  .superRefine((event, ctx) => {
    const ids = new Set(
      event.resources.map((resource) => {
        return resource.id;
      }),
    );
    if (ids.size !== event.resources.length) {
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Combine repeated IDs and preserve their occurrence count",
      });
    }
    const reasons = new Set(
      event.remainder.map((item) => {
        return item.reason;
      }),
    );
    if (reasons.size !== event.remainder.length) {
      ctx.addIssue({
        code: "custom",
        path: ["remainder"],
        message: "Each remainder reason must appear at most once",
      });
    }

    const counts = [
      ...event.resources.map((resource) => {
        return resource.occurrences;
      }),
      ...event.remainder.map((item) => {
        return item.quantity;
      }),
    ];
    if (
      !Number.isSafeInteger(event.quantity) ||
      counts.some((count) => {
        return !Number.isSafeInteger(count);
      })
    ) {
      return; // Base validation owns invalid numbers; BigInt requires integers.
    }
    const total = counts.reduce((sum, count) => {
      return sum + BigInt(count);
    }, 0n);
    if (total !== BigInt(event.quantity)) {
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Quantity must equal identified occurrences plus remainder",
      });
    }
  });
