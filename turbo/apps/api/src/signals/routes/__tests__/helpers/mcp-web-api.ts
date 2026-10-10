import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mcpServerContract } from "@okouai/api-contracts/contracts/mcp-server";
import { http, HttpResponse } from "msw";
import { z } from "zod";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import {
  setupApp,
  setupRawAppRequest,
} from "../../../../__tests__/test-helpers";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { agentsRoutes } from "../../agents";
import { chatEventsRoutes } from "../../chat-events";
import { chatThreadRoutes } from "../../chat-threads";
import { mcpServerRoutes } from "../../mcp-server";
import { runModelsRoutes } from "../../run-models";
import { runsCancelRoutes } from "../../runs-cancel";
import type { ApiTestUser } from "./api-bdd";

export const MCP_WEB_SCOPES =
  "user:org:read okou:chat:read okou:chat:send okou:chat:manage okou:run:cancel";
const version = "2026-07-28";

export function createMcpWebApi(context: TestContext) {
  function authorize(actor: ApiTestUser) {
    if (!actor.orgId) {
      throw new Error("MCP requires an organization");
    }
    const issuer = "https://clerk.mcp.example.test";
    const resource = "https://api.mcp.example.test/mcp";
    mockEnv("MCP_RESOURCE_URL", resource);
    mockEnv("MCP_OAUTH_ISSUER", issuer);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = randomUUID();
    server.use(
      http.get("https://api.clerk.com/v1/jwks", () => {
        return HttpResponse.json({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              kid,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }),
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          id: randomUUID(),
          role: "org:member",
          organization: { id: actor.orgId },
        },
      ],
      totalCount: 1,
    });
    return (claims: Record<string, unknown> = {}) => {
      const seconds = Math.floor(now() / 1000);
      const encode = (value: Record<string, unknown>) => {
        return Buffer.from(JSON.stringify(value)).toString("base64url");
      };
      const input = `${encode({ alg: "RS256", kid, typ: "at+jwt" })}.${encode({
        iss: issuer,
        aud: resource,
        sub: actor.userId,
        org_id: actor.orgId,
        client_id: "mcp_test_client",
        scope: MCP_WEB_SCOPES,
        iat: seconds,
        nbf: seconds - 1,
        exp: seconds + 3600,
        ...claims,
      })}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
    };
  }

  async function rpc(
    token: string,
    method: string,
    params: Record<string, unknown> = {},
    modern = true,
  ) {
    const response = await accept(
      setupApp({ context, routes: mcpServerRoutes })(mcpServerContract).request(
        {
          extraHeaders: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": modern ? version : "2025-11-25",
            ...(modern ? { "MCP-Method": method } : {}),
            ...(modern && typeof params.name === "string"
              ? { "MCP-Name": params.name }
              : {}),
          },
          body: {
            jsonrpc: "2.0",
            id: 1,
            method,
            params: {
              ...params,
              ...(modern
                ? {
                    _meta: {
                      "io.modelcontextprotocol/protocolVersion": version,
                      "io.modelcontextprotocol/clientCapabilities": {},
                      "io.modelcontextprotocol/clientInfo": {
                        name: "okou-test",
                        version: "1",
                      },
                    },
                  }
                : {}),
            },
          },
        },
      ),
      [200],
    );
    const body: unknown = response.body;
    if (typeof body !== "string") {
      return body;
    }
    const frame = body.split("\n").find((line) => {
      return line.startsWith("data: ");
    });
    if (!frame) {
      throw new Error("Expected an MCP SSE reply");
    }
    return JSON.parse(frame.slice(6)) as unknown;
  }

  async function call(
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    return z
      .object({
        result: z.object({
          isError: z.boolean().optional(),
          structuredContent: z.unknown().optional(),
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
        }),
      })
      .parse(await rpc(token, "tools/call", { name, arguments: args })).result;
  }
  const raw = setupRawAppRequest({
    context,
    routes: [
      ...agentsRoutes,
      ...runModelsRoutes,
      ...chatThreadRoutes,
      ...chatEventsRoutes,
      ...runsCancelRoutes,
    ],
  });
  async function web(
    token: string,
    path: string,
    method = "GET",
    body?: unknown,
  ) {
    return await raw(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return { authorize, rpc, call, web };
}
