import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testStripeAutomationEventFixtureActionSchema = z.enum([
  "corrupt-latest-snapshot",
  "hold-latest-claim",
  "expire-latest-retry-window",
  "make-latest-due",
  "clear-automation-account-projection",
]);
export type TestStripeAutomationEventFixtureAction = z.infer<
  typeof testStripeAutomationEventFixtureActionSchema
>;

export const testStripeAutomationEventFixtureContract = c.router({
  apply: {
    method: "POST",
    path: "/api/test/stripe-automation-event-fixture",
    body: z
      .object({
        automation_id: z.uuid(),
        action: testStripeAutomationEventFixtureActionSchema,
      })
      .strict(),
    responses: {
      200: z.object({ ok: z.literal(true) }),
      404: z.string(),
    },
    summary: "Inject an unconstructible Stripe workflow delivery state",
  },
});
