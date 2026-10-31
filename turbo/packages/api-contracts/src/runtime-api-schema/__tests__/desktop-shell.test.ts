import { describe, expect, it } from "vitest";
import { compareRuntimeApiSchemas } from "../compat";
import { evaluateRuntimeApiGate } from "../gate";
import {
  buildRuntimeApiSchemaDocument,
  type JsonValue,
  type RuntimeSchemaSnapshot,
} from "../schema";

function changeField(
  value: JsonValue,
  field: string,
  replacement: JsonValue | undefined,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      return changeField(entry, field, replacement);
    });
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (
        value["x-desktop-stable-fields"] === true &&
        key === "properties" &&
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        field in entry
      ) {
        const remaining = Object.fromEntries(
          Object.entries(entry).filter(([name]) => {
            return name !== field;
          }),
        );
        return [
          key,
          replacement === undefined
            ? remaining
            : { ...remaining, [field]: replacement },
        ];
      }
      return [key, changeField(entry, field, replacement)];
    }),
  );
}

describe("Desktop Shell queue contract gate", () => {
  it.each([
    [
      "waitMs",
      { type: "string" },
      "desktop.computerUseHostCommandNext",
      "response",
    ],
    [
      "nextCursor",
      { type: "string" },
      "desktop.computerUseHostCommandComplete",
      "request",
    ],
    ["command", undefined, "desktop.computerUseHostCommandNext", "response"],
    [
      "outputBase64",
      undefined,
      "desktop.computerUseHostCommandComplete",
      "request",
    ],
  ] as const)(
    "blocks incompatible changes to %s without a new floor",
    (field, replacement, routeId, direction) => {
      const production = buildRuntimeApiSchemaDocument("2026-10-31T00:00:00Z");
      const change = (
        snapshot: RuntimeSchemaSnapshot,
      ): RuntimeSchemaSnapshot => {
        if (snapshot.kind !== "json-schema") return snapshot;
        const schema = changeField(snapshot.schema, field, replacement);
        if (
          typeof schema !== "object" ||
          schema === null ||
          Array.isArray(schema)
        ) {
          throw new Error("Expected an object schema");
        }
        return { ...snapshot, schema };
      };
      const current = {
        ...production,
        routes: production.routes.map((route) => {
          return route.id !== routeId
            ? route
            : {
                ...route,
                request: {
                  ...route.request,
                  ...(route.request.body
                    ? { body: change(route.request.body) }
                    : {}),
                },
                responses: Object.fromEntries(
                  Object.entries(route.responses).map(([status, schema]) => {
                    return [status, change(schema)];
                  }),
                ),
              };
        }),
      };
      const result = evaluateRuntimeApiGate({
        findings: compareRuntimeApiSchemas(production, current),
        blockingOwners: new Set(["desktop"]),
        desktopFloor: { floor: "0.54.0", baseFloor: "0.54.0" },
        desktopTransforms: [],
      });
      expect(result.passed).toBe(false);
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          routeId,
          direction,
          outcome: "blocking",
        }),
      );
    },
  );
});
