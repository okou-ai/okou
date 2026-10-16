import {
  compareRuntimeApiSchemas,
  type RuntimeApiCompatFinding,
} from "../compat";
import type { RuntimeApiRouteOwner } from "../routes";
import {
  type JsonObject,
  runtimeApiSchemaFormatVersion,
  type RuntimeApiSchemaDocument,
} from "../schema";

function documentWithBody(bodySchema: JsonObject): RuntimeApiSchemaDocument {
  return {
    schemaFormatVersion: runtimeApiSchemaFormatVersion,
    packageName: "@okouai/api-contracts",
    packageVersion: "0.0.0",
    generatedAt: "2026-07-02T00:00:00.000Z",
    routes: [
      {
        id: "webhooks.agent.example",
        owner: "guest-agent",
        method: "POST",
        path: "/api/webhooks/agent/example",
        request: {
          body: {
            kind: "json-schema",
            schema: bodySchema,
          },
        },
        responses: {
          "200": {
            kind: "json-schema",
            schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
              },
              required: ["ok"],
            },
          },
        },
      },
    ],
  };
}

function objectSchema(
  properties: Record<string, JsonObject>,
  required: readonly string[],
): JsonObject {
  return {
    type: "object",
    properties,
    required: [...required],
  };
}

/** A route whose 409 declares its error codes and whose 426 names a floor. */
function documentWithErrorResponses(
  owner: RuntimeApiRouteOwner,
  conflictCodes: readonly string[],
  upgradeRequired: readonly string[],
): RuntimeApiSchemaDocument {
  const document = documentWithBody(objectSchema({}, []));
  return {
    ...document,
    routes: document.routes.map((route) => {
      return {
        ...route,
        owner,
        responses: {
          ...route.responses,
          "409": {
            kind: "json-schema",
            schema: objectSchema(
              {
                error: objectSchema(
                  { code: { type: "string", enum: [...conflictCodes] } },
                  ["code"],
                ),
              },
              ["error"],
            ),
          },
          "426": {
            kind: "json-schema",
            schema: objectSchema(
              { minimumSupportedVersion: { type: "string" } },
              upgradeRequired,
            ),
          },
        },
      };
    }),
  };
}

function findingKinds(
  findings: readonly RuntimeApiCompatFinding[],
): readonly string[] {
  return findings.map((finding) => {
    return finding.kind;
  });
}

describe("runtime API compatibility diff", () => {
  it("allows required request fields to become optional", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );
    const current = documentWithBody(
      objectSchema({ a: { type: "string" } }, []),
    );

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("allows optional request fields to be removed", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, []),
    );
    const current = documentWithBody(objectSchema({}, []));

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("rejects required request field removal", () => {
    const online = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );
    const current = documentWithBody(objectSchema({}, []));

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "request-required-field-removed",
    );
  });

  it("rejects adding a required request field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const current = documentWithBody(
      objectSchema({ a: { type: "string" } }, ["a"]),
    );

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "request-required-field-added",
    );
  });

  it("rejects removing a required response field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }

    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [
        {
          ...route,
          responses: {
            "200": {
              kind: "json-schema" as const,
              schema: {
                type: "object",
                properties: {},
                required: [],
              },
            },
          },
        },
      ],
    };

    expect(findingKinds(compareRuntimeApiSchemas(online, current))).toContain(
      "response-required-field-removed",
    );
  });

  it("allows adding a required response field", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }

    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [
        {
          ...route,
          responses: {
            "200": {
              kind: "json-schema",
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  id: { type: "string" },
                },
                required: ["ok", "id"],
              },
            },
          },
        },
      ],
    };

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("words a widened response enum as a value production clients cannot decode", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }
    const withStatus = (
      values: readonly string[],
    ): RuntimeApiSchemaDocument => {
      return {
        ...online,
        routes: [
          {
            ...route,
            responses: {
              "200": {
                kind: "json-schema",
                schema: objectSchema(
                  { status: { type: "string", enum: [...values] } },
                  ["status"],
                ),
              },
            },
          },
        ],
      };
    };

    const [finding] = compareRuntimeApiSchemas(
      withStatus(["queued"]),
      withStatus(["queued", "paused"]),
    );

    expect(finding).toMatchObject({
      kind: "response-enum-value-removed",
      path: "responses.200.status",
      responseStatus: 200,
      problem:
        'Enum value "paused" can be returned by the current schema but is not in the production schema, so clients that decode the production enum reject it.',
    });
  });

  it("compares non-2xx response bodies on Desktop routes", () => {
    const findings = compareRuntimeApiSchemas(
      documentWithErrorResponses(
        "desktop",
        ["CONFLICT"],
        ["minimumSupportedVersion"],
      ),
      documentWithErrorResponses("desktop", ["COMMAND_NOT_RUNNING"], []),
    );

    expect(findings).toMatchObject([
      {
        kind: "response-enum-value-removed",
        path: "responses.409.error.code",
        responseStatus: 409,
      },
      {
        kind: "response-required-field-removed",
        path: "responses.426.minimumSupportedVersion",
        responseStatus: 426,
      },
    ]);
  });

  it("compares only 2xx response bodies on runtime service routes", () => {
    const findings = compareRuntimeApiSchemas(
      documentWithErrorResponses(
        "guest-agent",
        ["CONFLICT"],
        ["minimumSupportedVersion"],
      ),
      documentWithErrorResponses("guest-agent", ["COMMAND_NOT_RUNNING"], []),
    );

    expect(findings).toEqual([]);
  });

  it("reports nothing for a route that production does not have yet", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }
    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [
        route,
        { ...route, id: "desktop.example", owner: "desktop", path: "/api/org" },
      ],
    };

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });

  it("matches a renamed binding id by its method and path", () => {
    const online = documentWithBody(objectSchema({}, []));
    const route = online.routes[0];
    if (!route) {
      throw new Error("missing test route");
    }
    const current: RuntimeApiSchemaDocument = {
      ...online,
      routes: [{ ...route, id: "webhooks.agent.renamed" }],
    };

    expect(compareRuntimeApiSchemas(online, current)).toEqual([]);
  });
});
