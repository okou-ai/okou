import type {
  CommerceInspectRequest,
  CommerceSearchRequest,
} from "@okouai/api-contracts/contracts/commerce";
import { z } from "zod";

export type CommerceRequest =
  | { operation: "search"; body: CommerceSearchRequest }
  | { operation: "inspect"; body: CommerceInspectRequest };

const taskSchema = z
  .object({
    id: z.string().min(1),
    status_code: z.number().int(),
    status_message: z.string(),
    cost: z.number().finite().nonnegative(),
  })
  .passthrough();
export const commerceProviderStatusSchema = z
  .object({
    status_code: z.number().int(),
    status_message: z.string(),
    cost: z.number().finite().nonnegative(),
    tasks_count: z.literal(1),
    tasks_error: z.number().int().min(0).max(1),
    tasks: z.array(taskSchema).length(1),
  })
  .passthrough();
export const commerceProviderResponseSchema =
  commerceProviderStatusSchema.extend({
    tasks: z
      .array(
        taskSchema.extend({
          result: z
            .array(
              z
                .object({
                  items: z.array(z.object({ type: z.string() }).passthrough()),
                })
                .passthrough(),
            )
            .nullable(),
        }),
      )
      .length(1),
  });

type ProviderBody = z.infer<typeof commerceProviderResponseSchema>;

export function projectCommerceItems(
  body: ProviderBody,
  request: CommerceRequest,
): unknown[] {
  const pages = body.tasks.flatMap((task) => {
    return task.result ?? [];
  });
  // Auxiliary SERP containers (related searches/recommendations) are retained in
  // source, but are not products and must not consume the requested product limit.
  const items = pages
    .flatMap((page) => {
      return page.items;
    })
    .filter((item) => {
      return request.operation === "search"
        ? item.type === "amazon_serp" || item.type === "amazon_paid"
        : item.type === "amazon_product_info";
    });
  return items.slice(
    0,
    request.operation === "search" ? request.body.limit : 48,
  );
}
