import { array, number, object, string, uuid, type infer as zInfer } from "zod";

export const browserTabOrderBindingSchema = object({
  instanceId: uuid(),
  windowId: number().int().nonnegative().safe().nullable(),
});
export const browserTabOrderSchema = browserTabOrderBindingSchema.extend({
  targetIds: array(string().min(1).max(512)),
});
export type BrowserTabOrder = zInfer<typeof browserTabOrderSchema>;
