import type { WorkflowShelfCover } from "./composer-workflow-recommendations.ts";

/**
 * The capability home's trigger suggestions. `source` names the service in
 * the request a suggestion prepares, and `mode` picks that request: an event
 * the source pushes, or a feed the workflow checks periodically.
 *
 * Each draws the same shelf cover as the workflow recommendations: the
 * source's mark over the shape of what the trigger leaves behind. Webhook and
 * RSS have no catalog connector, so a glyph stands in for their mark.
 */
export const TRIGGER_EXAMPLES = [
  {
    id: "email",
    source: "Gmail",
    mode: "event",
    cover: {
      tone: "artifact-video",
      kind: "doc",
      sources: ["gmail"],
      destination: null,
    },
  },
  {
    id: "calendar",
    source: "Google Calendar",
    mode: "event",
    cover: {
      tone: "chart-green",
      kind: "card",
      sources: ["google-calendar"],
      destination: null,
    },
  },
  {
    id: "slack",
    source: "Slack",
    mode: "event",
    cover: {
      tone: "chart-blue-300",
      kind: "check",
      sources: ["slack"],
      destination: null,
    },
  },
  {
    id: "webhook",
    source: "Webhook",
    mode: "event",
    cover: {
      tone: "usage-kind-connector",
      kind: "table",
      sources: [{ glyph: "webhook" }],
      destination: null,
    },
  },
  {
    id: "news",
    source: "RSS",
    mode: "monitor",
    cover: {
      tone: "chart-gold",
      kind: "list",
      sources: [{ glyph: "rss" }],
      destination: null,
    },
  },
  {
    id: "social",
    source: "X",
    mode: "monitor",
    cover: {
      tone: "artifact-image",
      kind: "doc",
      sources: ["x"],
      destination: null,
    },
  },
] as const satisfies readonly {
  readonly id: string;
  readonly source: string;
  readonly mode: "event" | "monitor";
  readonly cover: WorkflowShelfCover;
}[];
