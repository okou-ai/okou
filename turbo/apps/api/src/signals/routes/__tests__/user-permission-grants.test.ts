import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ApplyUserPermissionGrant,
  type UserPermissionGrantResponse,
  userPermissionGrantsContract,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { clearMockNow, mockNow } from "../../../lib/time";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  deleteUsageStateFixture$,
  seedCompose$,
  seedUsageStateFixture$,
  type UsageStateFixture,
} from "./helpers/usage-state";
import { userPermissionGrantsRoutes } from "../user-permission-grants";

const TEST_APP_ROUTES = Object.freeze([...userPermissionGrantsRoutes]);

const context = testContext({ connectorCatalog: true });
const store = createStore();
const mocks = createRouteMocks(context);

const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;
const SLACK_CONNECTOR = "slack";
const SLACK_READ_PERMISSION = "conversations:read";
const SLACK_HISTORY_PERMISSION = "conversations:history";
const SLACK_WRITE_PERMISSION = "chat:write";

async function seedMember(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly role?: "admin" | "member";
}): Promise<void> {
  await store.set(
    seedOrgMembership$,
    {
      orgId: args.orgId,
      userId: args.userId,
      role: args.role ?? "member",
    },
    context.signal,
  );
}

async function seedAgent(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly visibility?: "public" | "private";
}): Promise<string> {
  const { agentId } = await store.set(
    seedCompose$,
    {
      orgId: args.orgId,
      userId: args.userId,
      visibility: args.visibility,
    },
    context.signal,
  );
  return agentId;
}

function client() {
  return setupApp({ context, routes: userPermissionGrantsRoutes })(
    userPermissionGrantsContract,
  );
}

async function applyPermissionGrants(args: {
  readonly agentId: string;
  readonly connectorSlug: string;
  readonly mode?: "patch" | "replace";
  readonly grants: readonly ApplyUserPermissionGrant[];
}): Promise<readonly UserPermissionGrantResponse[]> {
  const response = await accept(
    client().apply({
      body: {
        agentId: args.agentId,
        connectorSlug: args.connectorSlug,
        mode: args.mode ?? "patch",
        grants: [...args.grants],
      },
      headers: AUTH_HEADERS,
    }),
    [200],
  );
  return response.body;
}

async function listPermissionGrants(
  agentId: string,
): Promise<readonly UserPermissionGrantResponse[]> {
  const response = await accept(
    client().list({
      query: { agentId },
      headers: AUTH_HEADERS,
    }),
    [200],
  );
  return response.body;
}

type ApplyPermissionGrantRequest = {
  readonly agentId: string;
  readonly connectorSlug: string;
} & ApplyUserPermissionGrant;

async function applyPermissionGrant(
  body: ApplyPermissionGrantRequest,
): Promise<{
  readonly agentId: string;
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}> {
  const grants = await applyPermissionGrants({
    agentId: body.agentId,
    connectorSlug: body.connectorSlug,
    grants: [
      body.action === "allow"
        ? {
            permission: body.permission,
            action: "allow",
            ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
          }
        : {
            permission: body.permission,
            action: "deny",
          },
    ],
  });
  const grant = grants[0];
  if (!grant) {
    throw new Error("User permission grant apply did not return a grant");
  }
  if (!grant.agentId) {
    throw new Error("User permission grant apply did not return agent scope");
  }
  return { ...grant, agentId: grant.agentId };
}

describe("zero user permission grants", () => {
  const fixtures: UsageStateFixture[] = [];

  async function createFixture(
    role: "admin" | "member" = "member",
  ): Promise<UsageStateFixture> {
    const fixture = await store.set(
      seedUsageStateFixture$,
      undefined,
      context.signal,
    );
    fixtures.push(fixture);
    await store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId, role },
      context.signal,
    );
    return fixture;
  }

  afterEach(async () => {
    clearMockNow();

    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await store.set(deleteUsageStateFixture$, fixture, context.signal);
      }
    }
  });

  it("patches one grant and lists only the authenticated user's active grants", async () => {
    const fixture = await createFixture();
    const otherUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: fixture.orgId, userId: otherUserId });
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const patched = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });

    expect(patched).toMatchObject({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(patched.expiresAt).toBeNull();

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_WRITE_PERMISSION,
      action: "deny",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const listed = await listPermissionGrants(agentId);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
  });

  it("accepts canonical connector slugs", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const base = {
      agentId,
      mode: "patch" as const,
      grants: [
        {
          permission: SLACK_READ_PERMISSION,
          action: "allow" as const,
        },
      ],
    };

    const canonical = await accept(
      client().apply({
        body: { ...base, connectorSlug: SLACK_CONNECTOR },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    expect(canonical.body[0]).toMatchObject({
      connectorSlug: SLACK_CONNECTOR,
    });
  });

  it("uses visible-agent scope for private and cross-org agents", async () => {
    const owner = await createFixture();
    const otherOrgUser = await createFixture();
    const sameOrgUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: owner.orgId, userId: sameOrgUserId });
    const publicAgentId = await seedAgent({
      orgId: owner.orgId,
      userId: owner.userId,
      visibility: "public",
    });
    const privateAgentId = await seedAgent({
      orgId: owner.orgId,
      userId: owner.userId,
      visibility: "private",
    });

    const client = setupApp({
      context,
      routes: userPermissionGrantsRoutes,
    })(userPermissionGrantsContract);

    mocks.clerk.session(owner.userId, owner.orgId, "org:member");
    const ownerResponse = await applyPermissionGrant({
      agentId: privateAgentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(ownerResponse.agentId).toBe(privateAgentId);

    mocks.clerk.session(sameOrgUserId, owner.orgId, "org:member");
    const sameOrgPublicResponse = await applyPermissionGrant({
      agentId: publicAgentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(sameOrgPublicResponse.agentId).toBe(publicAgentId);

    const sameOrgResponse = await accept(
      client.apply({
        body: {
          agentId: privateAgentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [{ permission: SLACK_READ_PERMISSION, action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(sameOrgResponse.body.error.code).toBe("NOT_FOUND");

    mocks.clerk.session(otherOrgUser.userId, otherOrgUser.orgId, "org:member");
    const crossOrgResponse = await accept(
      client.list({
        query: { agentId: privateAgentId },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(crossOrgResponse.body.error.code).toBe("NOT_FOUND");

    const missingResponse = await accept(
      client.list({
        query: { agentId: randomUUID() },
        headers: AUTH_HEADERS,
      }),
      [404],
    );
    expect(missingResponse.body.error.code).toBe("NOT_FOUND");
  });

  it("validates connector slugs, permission names, ask, and __unknown__", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({
      context,
      routes: userPermissionGrantsRoutes,
    })(userPermissionGrantsContract);

    const malformedConnector = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: "INVALID_REF",
          mode: "patch",
          grants: [{ permission: SLACK_READ_PERMISSION, action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(malformedConnector.body.error.code).toBe("BAD_REQUEST");

    const unknownConnector = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: "not-a-real-connector",
          mode: "patch",
          grants: [{ permission: SLACK_READ_PERMISSION, action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownConnector.body.error.code).toBe("VALIDATION_ERROR");

    const unknownPermissionForUnknownConnector = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: "not-a-real-connector",
          mode: "patch",
          grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownPermissionForUnknownConnector.body.error.code).toBe(
      "VALIDATION_ERROR",
    );

    const unknownPermission = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [{ permission: "not-a-real-permission", action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(unknownPermission.body.error.code).toBe("VALIDATION_ERROR");

    const unknownGrant = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: UNKNOWN_PERMISSION_GRANT,
      action: "deny",
    });
    expect(unknownGrant).toMatchObject({
      connectorSlug: SLACK_CONNECTOR,
      permission: UNKNOWN_PERMISSION_GRANT,
      action: "deny",
    });

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const askResponse = await app.request("/api/user-permission-grants/apply", {
      method: "PUT",
      headers: {
        authorization: AUTH_HEADERS.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectorSlug: SLACK_CONNECTOR,
        mode: "patch",
        grants: [
          {
            permission: SLACK_READ_PERMISSION,
            action: "ask",
          },
        ],
      }),
    });
    expect(askResponse.status).toBe(400);
  });

  it("replaces connector grants with an empty grant set", async () => {
    const fixture = await createFixture();
    const otherUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: fixture.orgId, userId: otherUserId });
    const agentId = await seedAgent(fixture);
    const otherAgentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      grants: [
        { permission: SLACK_READ_PERMISSION, action: "deny" },
        { permission: SLACK_WRITE_PERMISSION, action: "deny" },
      ],
    });
    await applyPermissionGrant({
      agentId,
      connectorSlug: "notion",
      permission: "read_content",
      action: "deny",
    });
    await applyPermissionGrant({
      agentId: otherAgentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "deny",
    });

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const applied = await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      mode: "replace",
      grants: [],
    });
    expect(applied).toStrictEqual([]);

    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        connectorSlug: "notion",
        permission: "read_content",
        action: "deny",
      },
    ]);
    await expect(listPermissionGrants(otherAgentId)).resolves.toMatchObject([
      {
        connectorSlug: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "deny",
      },
    ]);

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        connectorSlug: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "allow",
      },
    ]);
  });

  it("applies one connector's changed grants transactionally", async () => {
    const fixture = await createFixture();
    const otherUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: fixture.orgId, userId: otherUserId });
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const seededAt = Date.parse("2026-01-01T00:00:00.000Z");
    const oldExpiresAt = "2026-01-08T00:00:00.000Z";
    mockNow(seededAt);
    const seededRead = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "7d",
    });
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_HISTORY_PERMISSION,
      action: "deny",
    });
    await applyPermissionGrant({
      agentId,
      connectorSlug: "notion",
      permission: "read_content",
      action: "deny",
    });

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "deny",
    });

    mockNow(seededAt + 60 * 60 * 1000);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const applied = await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      grants: [
        {
          permission: SLACK_READ_PERMISSION,
          action: "allow",
        },
        {
          permission: SLACK_WRITE_PERMISSION,
          action: "deny",
        },
        {
          permission: UNKNOWN_PERMISSION_GRANT,
          action: "deny",
        },
      ],
    });

    expect(
      applied.map((grant) => {
        return [grant.permission, grant.action, grant.expiresAt] as const;
      }),
    ).toStrictEqual([
      [SLACK_READ_PERMISSION, "allow", oldExpiresAt],
      [SLACK_WRITE_PERMISSION, "deny", null],
      [UNKNOWN_PERMISSION_GRANT, "deny", null],
    ]);

    const patchedRead = applied.find((grant) => {
      return grant.permission === SLACK_READ_PERMISSION;
    });
    expect(patchedRead).toMatchObject({
      action: "allow",
      expiresAt: oldExpiresAt,
    });
    expect(patchedRead?.createdAt).toBe(seededRead.createdAt);
    expect(Date.parse(patchedRead?.updatedAt ?? "")).toBeGreaterThan(
      Date.parse(seededRead.updatedAt),
    );

    await expect(listPermissionGrants(agentId)).resolves.toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorSlug: SLACK_CONNECTOR,
          permission: SLACK_HISTORY_PERMISSION,
          action: "deny",
        }),
        expect.objectContaining({
          connectorSlug: "notion",
          permission: "read_content",
          action: "deny",
        }),
      ]),
    );

    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        connectorSlug: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "deny",
      },
    ]);
  });

  it("validates connector-scoped apply requests", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const client = setupApp({
      context,
      routes: userPermissionGrantsRoutes,
    })(userPermissionGrantsContract);

    const invalidConnector = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: "not-a-real-connector",
          mode: "patch",
          grants: [],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(invalidConnector.body.error.code).toBe("VALIDATION_ERROR");

    const duplicate = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [
            { permission: SLACK_READ_PERMISSION, action: "allow" },
            { permission: SLACK_READ_PERMISSION, action: "deny" },
          ],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(duplicate.body.error.code).toBe("VALIDATION_ERROR");

    const invalidPermission = await accept(
      client.apply({
        body: {
          agentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [{ permission: "not-a-real-permission", action: "allow" }],
        },
        headers: AUTH_HEADERS,
      }),
      [400],
    );
    expect(invalidPermission.body.error.code).toBe("VALIDATION_ERROR");

    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
    const denyExpiration = await app.request(
      "/api/user-permission-grants/apply",
      {
        method: "PUT",
        headers: {
          authorization: AUTH_HEADERS.authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [
            {
              permission: SLACK_READ_PERMISSION,
              action: "deny",
              expiresIn: "1h",
            },
          ],
        }),
      },
    );
    expect(denyExpiration.status).toBe(400);
  });

  it("replaces then applies changed grants when requested", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      grants: [
        { permission: SLACK_READ_PERMISSION, action: "allow" },
        { permission: SLACK_HISTORY_PERMISSION, action: "deny" },
      ],
    });

    const applied = await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      mode: "replace",
      grants: [
        {
          permission: SLACK_WRITE_PERMISSION,
          action: "deny",
        },
      ],
    });

    expect(applied).toMatchObject([
      { permission: SLACK_WRITE_PERMISSION, action: "deny" },
    ]);
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      { permission: SLACK_WRITE_PERMISSION, action: "deny" },
    ]);
  });

  it("rejects connector-scoped apply for invisible agents", async () => {
    const owner = await createFixture();
    const sameOrgUserId = `user_${randomUUID()}`;
    await seedMember({ orgId: owner.orgId, userId: sameOrgUserId });
    const privateAgentId = await seedAgent({
      orgId: owner.orgId,
      userId: owner.userId,
      visibility: "private",
    });
    mocks.clerk.session(sameOrgUserId, owner.orgId, "org:member");
    const client = setupApp({
      context,
      routes: userPermissionGrantsRoutes,
    })(userPermissionGrantsContract);

    const response = await accept(
      client.apply({
        body: {
          agentId: privateAgentId,
          connectorSlug: SLACK_CONNECTOR,
          mode: "patch",
          grants: [],
        },
        headers: AUTH_HEADERS,
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("filters expired grants and folds active grants into legacy policies", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const checkedAt = Date.parse("2026-01-01T00:00:00.000Z");

    mockNow(checkedAt - 60 * 60 * 1000 - 1000);
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });
    mockNow(checkedAt - 60 * 60 * 1000);
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_HISTORY_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });
    mockNow(checkedAt);
    await applyPermissionGrants({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      grants: [
        { permission: SLACK_WRITE_PERMISSION, action: "deny" },
        { permission: UNKNOWN_PERMISSION_GRANT, action: "deny" },
      ],
    });

    const listed = await listPermissionGrants(agentId);
    expect(
      listed
        .map((grant) => {
          return grant.permission;
        })
        .sort(),
    ).toStrictEqual([UNKNOWN_PERMISSION_GRANT, SLACK_WRITE_PERMISSION].sort());

    const active = listed;
    expect(
      active
        .map((grant) => {
          return grant.permission;
        })
        .sort(),
    ).toStrictEqual([UNKNOWN_PERMISSION_GRANT, SLACK_WRITE_PERMISSION].sort());

    expect(permissionGrantsToFirewallPolicies(active)).toStrictEqual({
      slack: {
        policies: { [SLACK_WRITE_PERMISSION]: "deny" },
        unknownPolicy: "deny",
      },
    });
    expect(permissionGrantsToFirewallPolicies([])).toBeNull();
  });

  it("preserves active allow expiration when expiresIn is omitted", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const firstAppliedAt = Date.parse("2026-01-01T00:00:00.000Z");
    mockNow(firstAppliedAt);
    const first = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "7d",
    });

    mockNow(firstAppliedAt + 60 * 60 * 1000);
    const second = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(second.action).toBe("allow");
    expect(second.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(
      Date.parse(first.updatedAt),
    );
  });

  it("clears active expiration when action changes to deny", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });

    const denied = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "deny",
    });
    expect(denied.action).toBe("deny");
    expect(denied.expiresAt).toBeNull();
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        permission: SLACK_READ_PERMISSION,
        action: "deny",
        expiresAt: null,
      },
    ]);
  });

  it("clears active expiration only when expiresIn is always", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });

    const cleared = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "always",
    });
    expect(cleared.expiresAt).toBeNull();
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        permission: SLACK_READ_PERMISSION,
        action: "allow",
        expiresAt: null,
      },
    ]);
  });

  it("revives expired grants as permanent grants when expiresIn is omitted", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    mockNow(Date.parse("2000-01-01T00:00:00.000Z"));
    await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });

    mockNow(Date.parse("2026-01-01T00:00:00.000Z"));
    const revived = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
    expect(revived.action).toBe("allow");
    expect(revived.expiresAt).toBeNull();
  });

  it("computes grant expiration from server-side expiresIn", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const timestamp = new Date("2026-02-01T12:00:00.000Z");
    mockNow(timestamp);

    const oneHour = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "1h",
    });
    expect(oneHour.expiresAt).toBe("2026-02-01T13:00:00.000Z");

    const oneDay = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "24h",
    });
    expect(oneDay.expiresAt).toBe("2026-02-02T12:00:00.000Z");

    const sevenDays = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "7d",
    });
    expect(sevenDays.expiresAt).toBe("2026-02-08T12:00:00.000Z");

    const always = await applyPermissionGrant({
      agentId,
      connectorSlug: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
      expiresIn: "always",
    });
    expect(always.expiresAt).toBeNull();
    await expect(listPermissionGrants(agentId)).resolves.toMatchObject([
      {
        permission: SLACK_READ_PERMISSION,
        action: "allow",
        expiresAt: null,
      },
    ]);
  });

  it("rejects invalid grant expiration options", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const response = await app.request("/api/user-permission-grants/apply", {
      method: "PUT",
      headers: {
        authorization: AUTH_HEADERS.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectorSlug: SLACK_CONNECTOR,
        mode: "patch",
        grants: [
          {
            permission: SLACK_READ_PERMISSION,
            action: "allow",
            expiresIn: "2h",
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects expiration options for deny grants", async () => {
    const fixture = await createFixture();
    const agentId = await seedAgent(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });

    const response = await app.request("/api/user-permission-grants/apply", {
      method: "PUT",
      headers: {
        authorization: AUTH_HEADERS.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectorSlug: SLACK_CONNECTOR,
        mode: "patch",
        grants: [
          {
            permission: SLACK_READ_PERMISSION,
            action: "deny",
            expiresIn: "1h",
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
  });
});
