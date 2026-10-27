import {
  array,
  boolean,
  literal,
  object,
  record,
  string,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

/** Router serves only this stateless MCP revision: JSON responses, no sessions or SSE. */
export const DATA_ROUTER_PROTOCOL_VERSION = "2026-07-28";

/**
 * Shared control metadata only. Router owns tool names, schemas, family IDs
 * and their display text; Okou treats every family as an opaque string.
 */
export const dataRouterToolSchema = object({
  name: string().min(1),
  title: string().optional(),
  description: string().optional(),
  inputSchema: object({ type: literal("object") }).catchall(zUnknown()),
  _meta: object({
    "ai.okou/data": object({
      family: string().min(1),
      requestHistory: boolean().optional(),
    })
      .catchall(zUnknown())
      .optional(),
  })
    .catchall(zUnknown())
    .optional(),
}).catchall(zUnknown());

/** Router-provided display text for one family, keyed by locale. */
export const dataRouterFamilySchema = object({
  id: string().min(1),
  title: record(string(), string()),
  description: record(string(), string()),
  summary: string().optional(),
}).catchall(zUnknown());

export const dataRouterToolsPageSchema = object({
  tools: array(dataRouterToolSchema),
  nextCursor: string().optional(),
  _meta: object({
    "ai.okou/data": object({ families: array(dataRouterFamilySchema) })
      .catchall(zUnknown())
      .optional(),
  })
    .catchall(zUnknown())
    .optional(),
});
export type DataRouterTool = zInfer<typeof dataRouterToolSchema>;
export type DataRouterFamily = zInfer<typeof dataRouterFamilySchema>;

/** Router's localized text, then its English text, then the stable ID. */
export function dataRouterFamilyText(
  text: Readonly<Record<string, string>>,
  locale: string | undefined,
  fallback: string,
): string {
  return (locale ? text[locale] : undefined) ?? text["en-US"] ?? fallback;
}
