import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import {
  initClient,
  initContract,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { server } from "../../../mocks/server";
import {
  cliClientHeaderApi,
  createCliClientHeaderInjector,
} from "../client-headers";

function uuidSequence(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (!value) {
      throw new Error("UUID sequence exhausted");
    }
    return value;
  };
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

describe("CLI client headers", () => {
  it("adds CLI client headers with a stable session id and per-request ids", () => {
    const addClientHeaders = createCliClientHeaderInjector({
      clientVersion: "1.2.3",
      createUuid: uuidSequence("session-id", "request-id-1", "request-id-2"),
    });
    const first = new Headers([
      [CLIENT_VERSION_HEADER, "caller-version"],
      [CLIENT_TYPE_HEADER, "caller-type"],
      [CLIENT_SESSION_ID_HEADER, "caller-session-id"],
      [CLIENT_REQUEST_ID_HEADER, "caller-request-id"],
    ]);
    const second = new Headers();

    addClientHeaders(first);
    addClientHeaders(second);

    expect(first.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(first.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
    expect(first.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(first.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-1");
    expect(second.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(second.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
    expect(second.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(second.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-2");
  });

  it("overrides spoofed headers after contract-client header merging", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-bypass");
    const contract = initContract();
    const testContract = contract.router({
      get: {
        method: "GET",
        path: "/api/test-client-headers",
        headers: contract.type<Record<string, string>>(),
        responses: {
          200: contract.type<{ readonly ok: true }>(),
        },
      },
    });
    const client = initClient(testContract, {
      baseUrl: "http://localhost:3000",
      baseHeaders: { Authorization: "Bearer test-token" },
      jsonQuery: false,
      api: cliClientHeaderApi,
    });
    const capturedHeaders: Headers[] = [];
    const spoofedHeaders = {
      [CLIENT_VERSION_HEADER]: "caller-version",
      [CLIENT_TYPE_HEADER]: "caller-type",
      [CLIENT_SESSION_ID_HEADER]: "caller-session-id",
      [CLIENT_REQUEST_ID_HEADER]: "caller-request-id",
    };

    server.use(
      http.get("http://localhost:3000/api/test-client-headers", (ctx) => {
        capturedHeaders.push(ctx.request.headers);
        return HttpResponse.json({ ok: true });
      }),
    );

    const first = await client.get({
      headers: spoofedHeaders,
      extraHeaders: spoofedHeaders,
    });
    const second = await client.get({ headers: spoofedHeaders });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(capturedHeaders).toHaveLength(2);

    const firstHeaders = capturedHeaders[0];
    const secondHeaders = capturedHeaders[1];
    if (!firstHeaders || !secondHeaders) {
      throw new Error("Expected two captured requests");
    }

    expect(firstHeaders.get("authorization")).toBe("Bearer test-token");
    expect(firstHeaders.get("x-vercel-protection-bypass")).toBe(
      "preview-bypass",
    );
    expect(secondHeaders.get("x-vercel-protection-bypass")).toBe(
      "preview-bypass",
    );
    expect(firstHeaders.get(CLIENT_VERSION_HEADER)).toBe("0.0.0-test");
    expect(firstHeaders.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);
    expect(secondHeaders.get(CLIENT_VERSION_HEADER)).toBe("0.0.0-test");
    expect(secondHeaders.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_CLI);

    const sessionId = requiredHeader(firstHeaders, CLIENT_SESSION_ID_HEADER);
    expect(requiredHeader(secondHeaders, CLIENT_SESSION_ID_HEADER)).toBe(
      sessionId,
    );
    expect(firstHeaders.get(CLIENT_SESSION_ID_HEADER)).not.toBe(
      "caller-session-id",
    );
    expect(requiredHeader(firstHeaders, CLIENT_REQUEST_ID_HEADER)).not.toBe(
      requiredHeader(secondHeaders, CLIENT_REQUEST_ID_HEADER),
    );
    expect(firstHeaders.get(CLIENT_REQUEST_ID_HEADER)).not.toBe(
      "caller-request-id",
    );
  });
});
