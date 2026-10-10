import type { ClientResponseTransform } from "@okouai/api-contracts/client-transforms/types";
import {
  CLIENT_TYPE_APP,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import type { JsonResponseObservation, JsonResponseObserver } from "../route";

const context = testContext();
const c = initContract();

const HOST_PATH = "/__test/client-response-transforms/host";

const transformTestContract = c.router({
  host: {
    method: "GET",
    path: HOST_PATH,
    responses: {
      200: z.object({ displayName: z.string() }),
      400: z.object({ error: z.string() }),
    },
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameField(from: string, to: string) {
  return (body: unknown): unknown => {
    if (!isRecord(body)) {
      throw new Error("Expected an object response body");
    }
    const { [from]: value, ...rest } = body;
    return { ...rest, [to]: value };
  };
}

function hostTransform(
  overrides: Pick<ClientResponseTransform, "maxVersion" | "transform"> &
    Partial<Pick<ClientResponseTransform, "status">>,
): ClientResponseTransform {
  return {
    client: "desktop",
    method: "GET",
    path: HOST_PATH,
    status: 200,
    since: "#38758",
    ...overrides,
  };
}

// Desktop up to 1.2.3 reads `name`; Desktop up to 1.0.0 reads `label`, which
// it receives by applying both transforms in registry order. A 4xx entry is
// registered only to show that it is never applied.
const fixtureTransforms: readonly ClientResponseTransform[] = [
  hostTransform({
    maxVersion: "1.2.3",
    transform: renameField("displayName", "name"),
  }),
  hostTransform({
    maxVersion: "1.0.0",
    transform: renameField("name", "label"),
  }),
  hostTransform({
    status: 400,
    maxVersion: null,
    transform: () => {
      return { transformed: true };
    },
  }),
];

interface HostAppOptions {
  readonly status?: 200 | 400;
  readonly body?: unknown;
  readonly clientResponseTransforms?: readonly ClientResponseTransform[];
  readonly observeJsonResponse?: JsonResponseObserver;
}

function requestHost(
  headers: Record<string, string>,
  {
    status = 200,
    // The extra field is not in the contract, so validation strips it before
    // any transform sees the body.
    body = { displayName: "Studio Mac", internalNote: "not in the contract" },
    clientResponseTransforms = fixtureTransforms,
    observeJsonResponse,
  }: HostAppOptions = {},
): Response | Promise<Response> {
  const handler$ = computed(() => {
    return { status, body };
  });
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      {
        route: transformTestContract.host,
        handler: handler$,
        observeJsonResponse,
      },
    ],
    clientResponseTransforms,
  });
  return app.request(`http://api.test${HOST_PATH}`, { headers });
}

function desktop(version: string): Record<string, string> {
  return {
    [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
    [CLIENT_VERSION_HEADER]: version,
  };
}

describe("client response transforms", () => {
  it.each([
    ["equal to maxVersion", "1.2.3", { name: "Studio Mac" }],
    ["below maxVersion", "1.1.0", { name: "Studio Mac" }],
    ["below both maxVersions", "1.0.0", { label: "Studio Mac" }],
  ])(
    "renders the old shape for a Desktop version %s",
    async (_case, version, expected) => {
      const response = await requestHost(desktop(version));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual(expected);
    },
  );

  it.each([
    ["a newer Desktop version", desktop("1.2.4")],
    [
      "an App client",
      {
        [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
        [CLIENT_VERSION_HEADER]: "1.0.0",
      },
    ],
    [
      "a Desktop request without a version",
      { [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP },
    ],
    ["an unparseable Desktop version", desktop("1.0.0-beta.1")],
    ["a request without client headers", {}],
  ])("sends the current body to %s", async (_case, headers) => {
    const response = await requestHost(headers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      displayName: "Studio Mac",
    });
  });

  it("leaves non-2xx bodies untouched", async () => {
    const response = await requestHost(desktop("1.0.0"), {
      status: 400,
      body: { error: "Invalid host" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid host",
    });
  });

  it("validates the handler's body against the current contract first", async () => {
    // Renaming would turn this into a well-formed old shape, so a transformed
    // response would mean the current contract was not enforced.
    const response = await requestHost(desktop("1.0.0"), {
      body: { displayName: 42 },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("transform failed");
      },
    ],
    [
      "returns no body",
      () => {
        return undefined;
      },
    ],
  ])("fails the request when a transform %s", async (_case, transform) => {
    const response = await requestHost(desktop("1.0.0"), {
      clientResponseTransforms: [
        hostTransform({ maxVersion: null, transform }),
      ],
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
  });

  it("observes the size of the transformed body", async () => {
    const observations: JsonResponseObservation[] = [];
    const response = await requestHost(desktop("1.2.3"), {
      observeJsonResponse: (_context, observation) => {
        observations.push(observation);
      },
    });

    const sent = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent)).toStrictEqual({ name: "Studio Mac" });
    expect(observations).toStrictEqual([
      {
        byteLength: Buffer.byteLength(sent),
        serializationDurationMs: expect.any(Number),
      },
    ]);
  });
});
