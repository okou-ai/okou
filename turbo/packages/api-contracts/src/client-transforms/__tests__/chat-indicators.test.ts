import { describe, expect, it } from "vitest";
import { fromJSONSchema, type core } from "zod";
import {
  androidLegacyIndicators,
  iosLegacyIndicators,
} from "../chat-indicators";
import previousSchema from "./fixtures/indicators-2026-11-21.json";

// The iOS and Android 200 schemas in the deployed runtime snapshot are identical.
const previous = fromJSONSchema(previousSchema as core.JSONSchema.JSONSchema);
const id = "00000000-0000-4000-8000-000000000001";
const current = {
  threads: { [id]: "unread" },
  unreadAt: { [id]: "2026-11-21T00:00:00Z" },
};

describe.each([iosLegacyIndicators, androidLegacyIndicators])(
  "$client unread response",
  (transform) => {
    it("preserves thread markers for an installed reader that requires the Agent map", () => {
      expect(previous.safeParse(current).success).toBe(false);
      expect(previous.parse(transform.transform(current))).toStrictEqual({
        ...current,
        agents: {},
      });
      const historical = { ...current, agents: { [id]: "active" } };
      expect(previous.parse(transform.transform(historical))).toStrictEqual(
        historical,
      );
    });
  },
);
