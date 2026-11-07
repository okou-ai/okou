import { browserTabOrderBindingSchema } from "@okouai/api-contracts/contracts/browser";
import { array, number, object, string, type infer as zInfer } from "zod";

export const browserTabOrderStateSchema = browserTabOrderBindingSchema.extend({
  savedTabIds: array(number().int().nonnegative().safe()),
  tabs: array(
    object({
      targetId: string().min(1).max(512).nullable(),
      tabId: number().int().nonnegative().safe().nullable(),
    }).refine((tab) => {
      return tab.targetId !== null || tab.tabId !== null;
    }),
  ),
});
export type BrowserTabOrderState = zInfer<typeof browserTabOrderStateSchema>;
