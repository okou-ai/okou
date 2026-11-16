import { describe, expect, it } from "vitest";
import { fromJSONSchema, type core } from "zod";
import {
  iosProjectEventsTransform,
  androidProjectEventsTransform,
} from "../project-events";
import previousJsonSchema from "./fixtures/project-events-2026-11-16.json";

// Exact production iOS and Android 200 response schema from
// runtime-api-schema-prod/current.json, GitHub release asset 753299806,
// updated 2026-11-16T03:28:44Z before Archive Project.
const projectId = "00000000-0000-4000-8000-000000000071";
const events = (
  ["created", "renamed", "archived", "restored", "deleted"] as const
).map((kind, index) => {
  return {
    id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`,
    projectId,
    seqId: index + 1,
    kind,
    name: kind === "created" ? "Launch" : "Renamed launch",
    createdAt: `2026-11-${String(index + 10)}T00:00:00.000Z`,
  };
});

describe.each([
  { name: "iOS", transform: iosProjectEventsTransform },
  { name: "Android", transform: androidProjectEventsTransform },
])("$name Project event compatibility", ({ transform }) => {
  it("preserves identity, names and stream ordering while rendering lifecycle events for the installed reader", () => {
    const previous = fromJSONSchema(
      previousJsonSchema as core.JSONSchema.JSONSchema,
    );
    const current = { events, hasMore: true };
    expect(previous.safeParse(current).success).toBe(false);
    const transformed = transform.transform(current);
    expect(previous.safeParse(transformed).success).toBe(true);
    expect(transformed).toStrictEqual({
      events: events.map((event) => {
        return event.kind === "archived" || event.kind === "restored"
          ? { ...event, kind: "renamed" }
          : event;
      }),
      hasMore: true,
    });
    expect(events[2]?.kind).toBe("archived");
    expect(events[3]?.kind).toBe("restored");
  });
});
