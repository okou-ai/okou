// Template for testing a Desktop response transform. Copy this file's shape
// next to a real registry entry: the old shape is an explicit JSON Schema, so
// the assertion does not depend on the contract that the change replaced.
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CLIENT_TYPE_DESKTOP } from "../../contracts/client-headers";
import { selectClientResponseTransforms } from "../select";
import type { ClientResponseTransform } from "../types";

// The current contract's 200 body: `name` was renamed to `displayName` and
// `platform` was added.
const currentHostSchema = z.object({
  hostId: z.string(),
  displayName: z.string(),
  platform: z.enum(["darwin"]),
});

// The 200 body that Desktop builds up to maxVersion decode. For a real route,
// copy `responses["200"].schema` for the route from the production runtime API
// schema snapshot (`current.json` in the `runtime-api-schema-prod` release),
// which is what installed Desktop builds were generated against.
const previousHostJsonSchema: z.core.JSONSchema.JSONSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    hostId: { type: "string" },
    name: { type: "string" },
  },
  required: ["hostId", "name"],
  additionalProperties: false,
};
const previousHostSchema = z.fromJSONSchema(previousHostJsonSchema);

const renameDisplayName: ClientResponseTransform = {
  client: "desktop",
  method: "GET",
  path: "/api/example/hosts/:hostId",
  status: 200,
  maxVersion: null,
  since: "#38758",
  transform: (body) => {
    const { hostId, displayName } = currentHostSchema.parse(body);
    return { hostId, name: displayName };
  },
};

const currentBody = {
  hostId: "host_1",
  displayName: "Studio Mac",
  platform: "darwin",
} satisfies z.infer<typeof currentHostSchema>;

describe("Desktop response transform template", () => {
  it("documents that the current body breaks the old shape", () => {
    expect(previousHostSchema.safeParse(currentBody).success).toBe(false);
  });

  it("renders the current body as the old shape", () => {
    const transformed = renameDisplayName.transform(currentBody);

    expect(previousHostSchema.parse(transformed)).toStrictEqual({
      hostId: "host_1",
      name: "Studio Mac",
    });
  });

  it("is selected for the Desktop builds that need the old shape", () => {
    expect(
      selectClientResponseTransforms({
        transforms: [renameDisplayName],
        client: CLIENT_TYPE_DESKTOP,
        version: "0.52.2",
        method: "GET",
        path: "/api/example/hosts/:hostId",
        status: 200,
      }),
    ).toStrictEqual([renameDisplayName]);
  });
});
