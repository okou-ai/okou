import { z } from "zod";

import { initContract } from "../../contracts/base";
import { buildRuntimeApiSchemaDocument } from "../schema";
import type { RuntimeApiRouteBinding } from "../routes";

const c = initContract();

function binding(id: string, path: string): RuntimeApiRouteBinding {
  const contract = c.router({
    get: {
      method: "GET",
      path,
      query: z.object({ cursor: z.string().optional() }),
      responses: {
        200: z.object({ ok: z.boolean() }),
      },
    },
  });
  return { id, owner: "guest-agent", route: contract.get };
}

function strictUnionBinding(id: string, path: string): RuntimeApiRouteBinding {
  const contract = c.router({
    report: {
      method: "POST",
      path,
      body: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("plain") }).strict(),
        z
          .object({
            kind: z.literal("sourced"),
            source: z.enum(["provider_response", "upstream_transport"]),
          })
          .strict(),
      ]),
      responses: {
        200: z.object({ ok: z.boolean() }),
      },
    },
  });
  return { id, owner: "mitm-addon", route: contract.report };
}

describe("runtime API schema document", () => {
  it("publishes strict discriminated-union request bodies as oneOf alternatives", () => {
    const document = buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
      strictUnionBinding("mitm.example", "/api/runners/example"),
    ]);
    const route = document.routes.find(({ id }) => {
      return id === "mitm.example";
    });

    expect(route).toMatchObject({
      method: "POST",
      owner: "mitm-addon",
      path: "/api/runners/example",
    });
    const body = route?.request.body;
    if (!body || body.kind !== "json-schema") {
      throw new Error("Expected a JSON schema request body");
    }
    const alternatives = body.schema.oneOf;
    if (!Array.isArray(alternatives)) {
      throw new Error("Expected request alternatives");
    }
    expect(alternatives).toHaveLength(2);
    expect(alternatives).toContainEqual({
      additionalProperties: false,
      properties: {
        kind: {
          const: "sourced",
          type: "string",
        },
        source: {
          enum: ["provider_response", "upstream_transport"],
          type: "string",
        },
      },
      required: ["kind", "source"],
      type: "object",
    });
  });

  it("publishes one snapshot per binding, at the path its contract declares", () => {
    const document = buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
      binding("guest.example", "/api/webhooks/agent/example"),
    ]);

    expect(document.routes).toHaveLength(1);
    expect(document.routes[0]).toMatchObject({
      id: "guest.example",
      path: "/api/webhooks/agent/example",
    });
  });

  it("rejects duplicate ids and duplicate method/path registrations", () => {
    expect(() => {
      buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
        binding("guest.example", "/api/webhooks/agent/one"),
        binding("guest.example", "/api/webhooks/agent/two"),
      ]);
    }).toThrow("Duplicate runtime API route id: guest.example");

    expect(() => {
      buildRuntimeApiSchemaDocument("2026-08-12T00:00:00.000Z", [
        binding("guest.one", "/api/webhooks/agent/example"),
        binding("guest.two", "/api/webhooks/agent/example"),
      ]);
    }).toThrow(
      "Duplicate runtime API route registration: GET /api/webhooks/agent/example",
    );
  });
});
