import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The explicitly invoked native Morning Brief delivery preview.
 *
 * It ships in the ordinary API route table and is reachable on a development
 * server and on a protected preview deployment; production answers 404 through
 * the environment gate before authentication, even when `simpleMorningBrief`
 * is on for the caller.
 *
 * The single input is a reference to a result the generation preview already
 * persisted. Nothing else can be supplied: no Markdown, recipient, thread,
 * owner, Agent, model or source bundle. The owner comes from the authenticated
 * organization and user, and the reference only resolves inside that scope.
 *
 * Delivery never collects, prompts or calls a model. It appends the accepted
 * body to the member's own Morning Brief thread as a canonical run-less
 * assistant message and hands the same body to the shared email outbox.
 */

export const morningBriefDeliveryEmailResolutionSchema = z.enum([
  "enqueued",
  "unsubscribed",
  "suppressed",
  "no_email",
  "render_rejected",
]);

const morningBriefDeliveryViewSchema = z.object({
  chatThreadId: z.string(),
  chatEventId: z.string(),
  emailResolution: morningBriefDeliveryEmailResolutionSchema,
  deliveredAt: z.string(),
});

const deliverResponseSchema = z.object({
  /**
   * `delivered` committed this delivery; `already-delivered` returns the one
   * this occurrence already has. A repeat request never appends a second
   * message or creates a second email intent.
   */
  result: z.enum(["delivered", "already-delivered"]),
  delivery: morningBriefDeliveryViewSchema,
});

export const morningBriefDeliveryPreviewContract = c.router({
  preview: {
    method: "POST",
    path: "/api/morning-brief/preview/delivery",
    headers: authHeadersSchema,
    body: z.object({
      /**
       * The opaque attempt identifier the generation preview returned. It is
       * resolved against the caller's own organization and user, so another
       * member's reference simply does not exist.
       */
      resultAttemptId: z.uuid(),
    }),
    responses: {
      200: deliverResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
      409: apiErrorSchema,
    },
    summary: "Deliver one persisted Morning Brief preview result",
  },
});

export type MorningBriefDeliveryEmailResolution = z.infer<
  typeof morningBriefDeliveryEmailResolutionSchema
>;
export type MorningBriefDeliveryView = z.infer<
  typeof morningBriefDeliveryViewSchema
>;
