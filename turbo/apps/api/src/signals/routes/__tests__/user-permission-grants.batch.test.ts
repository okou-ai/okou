import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApplyUserPermissionGrantsBatchRequest,
  userPermissionGrantsContract,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { userPermissionGrantsRoutes } from "../user-permission-grants";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: userPermissionGrantsRoutes })(
    userPermissionGrantsContract,
  );
}

function signIn(user: ApiTestUser) {
  mocks.clerk.session(user.userId, user.orgId, "org:member");
}

async function enableBatch(user: ApiTestUser, enabled = true) {
  if (!user.orgId) {
    throw new Error("Batch permission test actor requires an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...user, orgId: user.orgId },
    {
      [FeatureSwitchKey.BatchConnectorPermissions]: enabled,
    },
  );
  signIn(user);
}

async function fixture(visibility: "public" | "private" = "public") {
  const user = bdd.user({ orgRole: "org:member" });
  bdd.acceptAgentStorageWrites();
  const agent = await bdd.createAgent(user, { visibility });
  await enableBatch(user);
  return { user, agentId: agent.agentId };
}

function body(agentId: string): ApplyUserPermissionGrantsBatchRequest {
  return {
    agentId,
    groups: [
      {
        connectorSlug: "slack",
        grants: [
          { permission: "chat:write", action: "allow", expiresIn: "1h" },
        ],
      },
      {
        connectorSlug: "notion",
        grants: [{ permission: "read_content", action: "allow" }],
      },
    ],
  };
}

async function list(agentId: string) {
  return (await accept(client().list({ query: { agentId }, headers }), [200]))
    .body;
}

async function apply(input: ApplyUserPermissionGrantsBatchRequest) {
  return (await accept(client().applyBatch({ body: input, headers }), [200]))
    .body;
}

describe("PUT /api/user-permission-grants/apply-batch", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("patches multiple connectors for only the authenticated user and agent", async () => {
    const { user, agentId } = await fixture();
    const otherUser = bdd.user({ orgId: user.orgId, orgRole: "org:member" });
    const otherAgent = await bdd.createAgent(user);
    signIn(user);
    await accept(
      client().apply({
        headers,
        body: {
          agentId,
          connectorSlug: "slack",
          mode: "patch",
          grants: [{ permission: "conversations:read", action: "deny" }],
        },
      }),
      [200],
    );

    const applied = await apply(body(agentId));
    expect(applied).toHaveLength(2);
    expect(applied).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorSlug: "slack",
          permission: "chat:write",
          action: "allow",
        }),
        expect.objectContaining({
          connectorSlug: "notion",
          permission: "read_content",
          action: "allow",
        }),
      ]),
    );
    await expect(list(agentId)).resolves.toStrictEqual(
      expect.arrayContaining([
        ...applied,
        expect.objectContaining({
          connectorSlug: "slack",
          permission: "conversations:read",
          action: "deny",
        }),
      ]),
    );
    await expect(list(otherAgent.agentId)).resolves.toStrictEqual([]);
    signIn(otherUser);
    await expect(list(agentId)).resolves.toStrictEqual([]);
  });

  it("rejects an invalid connector or permission before writing any group", async () => {
    const { agentId } = await fixture();
    const initial = await apply({
      agentId,
      groups: body(agentId).groups.filter((group) => {
        return group.connectorSlug === "slack";
      }),
    });
    for (const invalid of [
      {
        connectorSlug: "notion",
        grants: [{ permission: "not-a-permission", action: "allow" as const }],
      },
      {
        connectorSlug: "unknown-connector",
        grants: [{ permission: "read", action: "allow" as const }],
      },
    ]) {
      const response = await accept(
        client().applyBatch({
          headers,
          body: {
            agentId,
            groups: [
              {
                connectorSlug: "slack",
                grants: [
                  { permission: "conversations:history", action: "allow" },
                ],
              },
              invalid,
            ],
          },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      await expect(list(agentId)).resolves.toStrictEqual(initial);
    }
  });

  it("keeps active allow expiration and timestamps stable when a batch is resubmitted", async () => {
    const { agentId } = await fixture();
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    mockNow(start);
    const initial = await apply(body(agentId));
    mockNow(start + 30 * 60 * 1000);
    const retryBody = body(agentId);
    retryBody.groups = retryBody.groups.map((group) => {
      return {
        ...group,
        grants: group.grants.map((grant) => {
          return {
            ...grant,
            expiresIn: group.connectorSlug === "slack" ? "7d" : "1h",
          };
        }),
      };
    });
    await expect(apply(retryBody)).resolves.toStrictEqual(initial);
    await expect(list(agentId)).resolves.toStrictEqual(initial);

    mockNow(start + 2 * 60 * 60 * 1000);
    const renewed = await apply(body(agentId));
    expect(renewed).toContainEqual(
      expect.objectContaining({
        connectorSlug: "slack",
        expiresAt: "2026-01-01T03:00:00.000Z",
      }),
    );
    expect(renewed).toContainEqual(
      initial.find((grant) => {
        return grant.connectorSlug === "notion";
      }),
    );
  });

  it("changes a deny to allow without replacing unselected permissions", async () => {
    const { agentId } = await fixture();
    await accept(
      client().apply({
        headers,
        body: {
          agentId,
          connectorSlug: "slack",
          mode: "patch",
          grants: [
            { permission: "chat:write", action: "deny" },
            { permission: "conversations:history", action: "deny" },
          ],
        },
      }),
      [200],
    );
    await apply(body(agentId));
    await expect(list(agentId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ permission: "chat:write", action: "allow" }),
        expect.objectContaining({
          permission: "conversations:history",
          action: "deny",
        }),
      ]),
    );
  });

  it("rejects duplicate permission pairs across groups without applying valid groups", async () => {
    const { agentId } = await fixture();
    const input = body(agentId);
    input.groups.push({
      connectorSlug: "slack",
      grants: [{ permission: "chat:write", action: "allow" }],
    });
    await accept(client().applyBatch({ headers, body: input }), [400]);
    await expect(list(agentId)).resolves.toStrictEqual([]);
  });

  it("enforces the total permission limit across connectors", async () => {
    const { agentId } = await fixture();
    const scopes = [
      {
        connectorSlug: "slack",
        permissions: [
          "conversations:read",
          "conversations:history",
          "users:read",
          "chat:write",
          "files:read",
          "files:write",
          "search:read",
          UNKNOWN_PERMISSION_GRANT,
        ],
      },
      {
        connectorSlug: "github",
        permissions: [
          "user:read",
          "notifications:read",
          "search:read",
          "pull_requests:read",
          "checks:read",
          UNKNOWN_PERMISSION_GRANT,
        ],
      },
      {
        connectorSlug: "gmail",
        permissions: [
          "messages.read",
          "messages.detail",
          "messages.write",
          UNKNOWN_PERMISSION_GRANT,
        ],
      },
      {
        connectorSlug: "cloudflare",
        permissions: [
          "dns-firewall.read",
          "dns-firewall.write",
          UNKNOWN_PERMISSION_GRANT,
        ],
      },
    ];
    const input: ApplyUserPermissionGrantsBatchRequest = {
      agentId,
      groups: scopes.map((scope) => {
        return {
          connectorSlug: scope.connectorSlug,
          grants: scope.permissions.map((permission) => {
            return { permission, action: "allow" };
          }),
        };
      }),
    };
    await accept(client().applyBatch({ headers, body: input }), [400]);
    await expect(list(agentId)).resolves.toStrictEqual([]);
    const maximum = {
      ...input,
      groups: input.groups.map((group) => {
        return group.connectorSlug === "cloudflare"
          ? { ...group, grants: group.grants.slice(0, 2) }
          : group;
      }),
    };
    await expect(apply(maximum)).resolves.toHaveLength(20);
    await expect(list(agentId)).resolves.toHaveLength(20);
  });

  it("gates batches with persisted feature overrides and leaves the single-connector API available", async () => {
    const { user, agentId } = await fixture();
    await enableBatch(user, false);
    await accept(client().applyBatch({ headers, body: body(agentId) }), [403]);
    await accept(
      client().apply({
        headers,
        body: {
          agentId,
          connectorSlug: "slack",
          mode: "patch",
          grants: [{ permission: "chat:write", action: "allow" }],
        },
      }),
      [200],
    );
    await expect(list(agentId)).resolves.toHaveLength(1);
    await enableBatch(user);
    await expect(apply(body(agentId))).resolves.toHaveLength(2);
  });

  it("requires authentication and a visible agent in the current organization", async () => {
    const { user, agentId } = await fixture("private");
    await accept(
      client().applyBatch({
        headers: { authorization: "" },
        body: body(agentId),
      }),
      [401],
    );
    signIn(bdd.user({ orgId: null, orgRole: "org:member" }));
    await accept(client().applyBatch({ headers, body: body(agentId) }), [401]);
    const sameOrgUser = bdd.user({ orgId: user.orgId, orgRole: "org:member" });
    const otherOrgUser = bdd.user({ orgRole: "org:member" });
    for (const actor of [sameOrgUser, otherOrgUser]) {
      await enableBatch(actor);
      await accept(
        client().applyBatch({ headers, body: body(agentId) }),
        [404],
      );
    }
    await enableBatch(user);
    await accept(
      client().applyBatch({ headers, body: body(randomUUID()) }),
      [404],
    );
    await expect(list(agentId)).resolves.toStrictEqual([]);
    await expect(apply(body(agentId))).resolves.toHaveLength(2);
  });
});
