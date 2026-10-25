import { z } from "zod";

export const dataRouterFamilySchema = z.enum([
  "web-search",
  "people-search",
  "data-search",
  "scrape",
  "finance",
  "maps",
  "seo",
  "social",
]);

/** Shared control metadata; business tool names and schemas belong to Router. */
export const dataRouterToolSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.object({ type: z.literal("object") }).catchall(z.unknown()),
    _meta: z
      .object({
        "ai.okou/data": z
          .object({
            family: dataRouterFamilySchema,
            requestHistory: z.boolean().optional(),
          })
          .optional(),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .catchall(z.unknown());

export const dataRouterToolsPageSchema = z.object({
  tools: z.array(dataRouterToolSchema),
  nextCursor: z.string().optional(),
});
export type DataRouterTool = z.infer<typeof dataRouterToolSchema>;
