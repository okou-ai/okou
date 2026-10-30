import { describe, expect, it } from "vitest";
import { number, object, string } from "zod";
import {
  initClient as initContractClient,
  initContract,
  validateResponse,
} from "../../contracts/trpc-contract";
import { initClient, trpcRestFetchApi } from "../transport";
import type { ApiFetcherArgs, ClientDescriptor } from "../types";

const c = initContract();
const contract = c.router({
  send: {
    method: "POST",
    path: "items/:id?existing=first",
    pathParams: c.type<{ id: string }>(),
    query: c.type<{
      tags?: (string | null | undefined)[];
      enabled?: boolean;
      count?: number;
      absent?: null;
    }>(),
    headers: c.type<Record<string, string | number>>(),
    body: c.type<unknown>(),
    responses: { 200: c.type<unknown>(), 409: c.type<unknown>() },
  },
});
const descriptor: ClientDescriptor<typeof contract> = {
  send: {
    method: "POST",
    path: "items/:id?existing=first",
    statuses: { 200: true, 409: true },
  },
};

const responseHeaders = new Headers({ "x-result": "accepted" });
const result = {
  status: 200,
  body: { accepted: true },
  headers: responseHeaders,
};

const variants = [
  { name: "full contract", contract },
  { name: "schema-free descriptor", contract: descriptor },
];

describe.each(variants)(
  "shared transport with $name",
  ({ contract: routes }) => {
    it("preserves URL resolution, path encoding, repeated query values, JSON and header precedence", async () => {
      const requests: ApiFetcherArgs[] = [];
      const signal = new AbortController().signal;
      const fetchOptions: RequestInit = { signal, credentials: "include" };
      const client = initClient(routes, {
        baseUrl: "https://api.example.test/root/",
        baseHeaders: { "x-source": "base", "x-base": "preserved" },
        jsonQuery: true,
        api: async (args) => {
          requests.push(args);
          return result;
        },
      });

      const response = await client.send({
        params: { id: "folder/with space" },
        query: {
          tags: ["a b", undefined, null, "c"],
          enabled: false,
          count: 0,
          absent: null,
        },
        headers: { "X-Source": "route", "x-request": "kept", ignored: 123 },
        extraHeaders: { "x-source": "extra" },
        body: { name: "item" },
        fetchOptions,
      });

      const request = requests[0];
      expect(request?.path).toBe(
        "https://api.example.test/root/items/folder%2Fwith%20space?existing=first&tags=a+b&tags=c&enabled=false&count=0",
      );
      expect(request?.method).toBe("POST");
      expect(request?.body).toBe('{"name":"item"}');
      expect(Object.fromEntries(new Headers(request?.headers))).toEqual({
        "content-type": "application/json",
        "x-base": "preserved",
        "x-request": "kept",
        "x-source": "extra",
      });
      expect(request?.fetchOptions).toBe(fetchOptions);
      expect(response).toBe(result);
      expect(response.headers.get("x-result")).toBe("accepted");
    });

    it("retains an explicitly supplied content type for JSON bodies", async () => {
      const requests: ApiFetcherArgs[] = [];
      const client = initClient(routes, {
        baseUrl: "https://api.example.test/",
        baseHeaders: { "content-type": "application/vnd.example+json" },
        api: async (args) => {
          requests.push(args);
          return result;
        },
      });
      await client.send({ params: { id: "one" }, body: null });
      expect(requests[0]?.body).toBe("null");
      expect(new Headers(requests[0]?.headers).get("content-type")).toBe(
        "application/vnd.example+json",
      );
    });

    it.each([
      { name: "string", body: "raw text" },
      { name: "Blob", body: new Blob(["raw bytes"]) },
      { name: "FormData", body: new FormData() },
      { name: "URLSearchParams", body: new URLSearchParams({ value: "a b" }) },
      { name: "ArrayBuffer", body: new ArrayBuffer(4) },
      { name: "typed array", body: new Uint8Array([1, 2, 3]) },
      { name: "DataView", body: new DataView(new ArrayBuffer(4)) },
    ])("passes $name bodies to the fetcher unchanged", async ({ body }) => {
      const requests: ApiFetcherArgs[] = [];
      const client = initClient(routes, {
        baseUrl: "https://api.example.test/",
        api: async (args) => {
          requests.push(args);
          return result;
        },
      });
      await client.send({ params: { id: "one" }, body });
      expect(requests[0]?.body).toBe(body);
      expect(new Headers(requests[0]?.headers).get("content-type")).toBeNull();
    });

    it("accepts declared error statuses and rejects unknown statuses when configured", async () => {
      const client = initClient(routes, {
        baseUrl: "https://api.example.test/",
        throwOnUnknownStatus: true,
        api: async ({ path }) => {
          return {
            ...result,
            status: path.includes("unknown") ? 503 : 409,
          };
        },
      });

      await expect(
        client.send({ params: { id: "conflict" } }),
      ).resolves.toMatchObject({
        status: 409,
      });
      await expect(client.send({ params: { id: "unknown" } })).rejects.toThrow(
        "Unknown response status 503 for POST items/:id?existing=first",
      );
    });

    it("returns unknown statuses unchanged when strict status handling is disabled", async () => {
      const client = initClient(routes, {
        baseUrl: "https://api.example.test/",
        api: async () => {
          return { ...result, status: 503 };
        },
      });
      await expect(
        client.send({ params: { id: "one" } }),
      ).resolves.toMatchObject({
        status: 503,
        body: { accepted: true },
      });
    });
  },
);

const validationContract = c.router({
  get: {
    method: "GET",
    path: "/validated",
    responses: {
      200: object({ count: string().transform(Number) }),
      500: object({ detail: number() }),
    },
  },
});
const validationDescriptor: ClientDescriptor<typeof validationContract> = {
  get: {
    method: "GET",
    path: "/validated",
    statuses: { 200: true, 500: true },
  },
};

describe("response validation compatibility", () => {
  it("requires a validation callback when descriptor validation is requested", () => {
    expect(() => {
      return initClient(validationDescriptor, {
        baseUrl: "https://api.example.test/",
        validateResponse: true,
      });
    }).toThrow("Response validation requires a response validator");
  });

  it("keeps legacy response transformations and headers", async () => {
    const client = initContractClient(validationContract, {
      baseUrl: "https://api.example.test/",
      validateResponse: true,
      api: async () => {
        return { ...result, body: { count: "12" } };
      },
    });
    const response = await client.get();
    expect(response.body).toEqual({ count: 12 });
    expect(response.headers).toBe(responseHeaders);
  });

  it("supports a descriptor validator without attaching schemas to the descriptor", async () => {
    const client = initClient(
      validationDescriptor,
      {
        baseUrl: "https://api.example.test/",
        validateResponse: true,
        api: async () => {
          return { ...result, body: { count: "12" } };
        },
      },
      ({ response }) => {
        return validateResponse({ appRoute: validationContract.get, response });
      },
    );
    await expect(client.get()).resolves.toMatchObject({ body: { count: 12 } });
  });

  it("preserves raw responses when legacy validation is disabled", async () => {
    const client = initContractClient(validationContract, {
      baseUrl: "https://api.example.test/",
      api: async () => {
        return { ...result, body: { count: "12" } };
      },
    });
    await expect(client.get()).resolves.toMatchObject({
      body: { count: "12" },
    });
  });

  it("rejects invalid declared responses through the legacy client", async () => {
    const client = initContractClient(validationContract, {
      baseUrl: "https://api.example.test/",
      validateResponse: true,
      api: async () => {
        return { ...result, body: { count: 12 } };
      },
    });
    await expect(client.get()).rejects.toThrow("Response validation failed:");
  });

  it.each(["Internal Server Error", { error: "Server unavailable" }])(
    "preserves framework 5xx responses: %j",
    async (body) => {
      const client = initContractClient(validationContract, {
        baseUrl: "https://api.example.test/",
        validateResponse: true,
        api: async () => {
          return { ...result, status: 500, body };
        },
      });
      await expect(client.get()).resolves.toMatchObject({ status: 500, body });
    },
  );

  it("checks unknown statuses before running the validation boundary", async () => {
    const client = initClient(
      validationDescriptor,
      {
        baseUrl: "https://api.example.test/",
        validateResponse: true,
        throwOnUnknownStatus: true,
        api: async () => {
          return { ...result, status: 418 };
        },
      },
      () => {
        throw new Error("Response validator failure");
      },
    );
    await expect(client.get()).rejects.toThrow(
      "Unknown response status 418 for GET /validated",
    );
  });
});

function dataRequest(path: string): ApiFetcherArgs {
  return {
    path,
    method: "GET",
    headers: new Headers(),
    route: { method: "GET", path, statuses: { 200: true } },
  };
}

describe("native fetch transport", () => {
  it.each([
    { type: "application/json", body: '{"value":12}', expected: { value: 12 } },
    { type: "text/plain", body: "plain text", expected: "plain text" },
  ])(
    "parses $type responses and preserves response headers",
    async ({ type, body, expected }) => {
      const response = await trpcRestFetchApi(
        dataRequest(`data:${type},${encodeURIComponent(body)}`),
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expected);
      expect(response.headers.get("content-type")).toBe(type);
    },
  );

  it("returns binary responses as Blobs", async () => {
    const response = await trpcRestFetchApi(
      dataRequest("data:application/octet-stream;base64,AQID"),
    );
    expect(response.body).toBeInstanceOf(Blob);
    if (!(response.body instanceof Blob)) {
      throw new Error("Expected binary response body");
    }
    expect(new Uint8Array(await response.body.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("skips response parsing when requested", async () => {
    const response = await trpcRestFetchApi(
      dataRequest("data:application/json,not-json"),
      { parseResponseBody: false },
    );
    expect(response).toMatchObject({ status: 200, body: undefined });
  });

  it("gives explicit transport method, headers and body precedence over fetchOptions", async () => {
    const response = await trpcRestFetchApi({
      ...dataRequest("data:text/plain,accepted"),
      fetchOptions: {
        method: "invalid method",
        headers: { "invalid header": "ignored" },
        body: "would be invalid on GET",
      },
    });
    expect(response.body).toBe("accepted");
  });

  it("forwards AbortSignals to native fetch", async () => {
    await expect(
      trpcRestFetchApi({
        ...dataRequest("data:text/plain,accepted"),
        fetchOptions: { signal: AbortSignal.abort() },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
