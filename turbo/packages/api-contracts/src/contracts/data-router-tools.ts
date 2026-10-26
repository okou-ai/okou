import {
  array,
  boolean,
  literal,
  object,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

export const dataRouterFamilySchema = zEnum([
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
export const dataRouterToolSchema = object({
  name: string().min(1),
  title: string().optional(),
  description: string().optional(),
  inputSchema: object({ type: literal("object") }).catchall(zUnknown()),
  _meta: object({
    "ai.okou/data": object({
      family: dataRouterFamilySchema,
      requestHistory: boolean().optional(),
    }).optional(),
  })
    .catchall(zUnknown())
    .optional(),
}).catchall(zUnknown());

export const dataRouterToolsPageSchema = object({
  tools: array(dataRouterToolSchema),
  nextCursor: string().optional(),
});
export type DataRouterTool = zInfer<typeof dataRouterToolSchema>;
