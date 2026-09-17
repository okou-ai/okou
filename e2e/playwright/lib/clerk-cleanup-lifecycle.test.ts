import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cleanupClerkTestJobRef,
  cleanupRecordedClerkTestResources,
  cleanupStaleClerkTestResources,
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "./clerk-api";
import { withClerkCleanupBudget } from "./clerk-cleanup-budget";

interface Resource {
  readonly id: string;
  readonly created_at: number;
  readonly email_addresses?: readonly { readonly email_address: string }[];
  readonly private_metadata?: unknown;
}

interface Fixture {
  readonly users: Map<string, Resource>;
  readonly organizations: Map<string, Resource>;
  readonly requests: string[];
  loseOrganizationResponse: boolean;
  failMembershipUpdate: boolean;
  failDeletes: boolean;
  failReads: boolean;
  redirectReads: boolean;
  stallBody: boolean;
}

test("recorded lifecycle avoids a 40-request empty scan among 19,119 unrelated organizations", async (context) => {
  await withFixture(async (fixture) => {
    addUnrelatedOrganizations(fixture, 19_119);
    for (let index = 0; index < 87; index += 1) {
      const id = `user_unrelated_${index}`;
      fixture.users.set(id, {
        id,
        created_at: 0,
        email_addresses: [
          { email_address: `person-${index}@unrelated.invalid` },
        ],
      });
    }
    const emptyScan = await cleanupClerkTestJobRef("pr-123");
    assert.equal(emptyScan.selectedOrganizations, 0);
    assert.equal(emptyScan.selectedUsers, 0);
    assert.equal(fixture.requests.length, 40);

    const user = await createUser(generateTestEmail("playwright"));
    const organization = await createOrganization(
      "Fixture",
      user,
      "playwright",
    );
    fixture.requests.length = 0;
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.organizations.has(organization), false);
    assert.equal(fixture.users.has(user), false);
    assert.equal(fixture.organizations.size, 19_119);
    assert.equal(fixture.users.size, 87);
    assert.equal(fixture.requests.length, 4);
    fixture.requests.length = 0;
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.deepEqual(fixture.requests, []);
    context.diagnostic(
      "HTTP fixture: empty full scan = 40 requests; one recorded user/org = 4; empty recorded cleanup = 0; 19,119 unrelated organizations preserved",
    );
  });
});

test("a lost organization response retains its owner and recovers in a later scheduled pass", async () => {
  await withFixture(async (fixture) => {
    addUnrelatedOrganizations(fixture, 19_119);
    const email = generateTestEmail("playwright");
    const user = await createUser(email);
    fixture.loseOrganizationResponse = true;
    await assert.rejects(
      createOrganization("Fixture", user, "playwright"),
      /request failed after 1 attempt/,
    );
    fixture.requests.length = 0;
    await deleteClerkTestOwnerResources(email, undefined);
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.deepEqual(fixture.requests, [`GET /v1/users/${user}`]);
    assert.equal(fixture.users.has(user), true);
    assert.equal(fixture.organizations.size, 19_120);

    fixture.requests.length = 0;
    await cleanupStaleClerkTestResources(["playwright"], new Date(1));
    assert.equal(fixture.organizations.size, 19_119);
    assert.equal(fixture.users.has(user), false);
    assert.deepEqual(
      fixture.requests.filter((request) => request.startsWith("DELETE")),
      ["DELETE /v1/organizations/org_1", `DELETE /v1/users/${user}`],
    );
    assert.equal(fixture.requests.length, 42);
  });
});

test("membership setup failure survives failed rollback and retained records recover", async () => {
  await withFixture(async (fixture) => {
    const user = await createUser(generateTestEmail("playwright"));
    fixture.failMembershipUpdate = true;
    fixture.failDeletes = true;
    await assert.rejects(
      createOrganization("Fixture", user, "playwright"),
      /update Clerk organization membership failed with HTTP 400/,
    );
    assert.equal(fixture.users.has(user), true);
    assert.equal(fixture.organizations.size, 1);
    fixture.failDeletes = false;
    await cleanupRecordedClerkTestResources(["playwright"]);
    assert.equal(fixture.users.has(user), false);
    assert.equal(fixture.organizations.size, 0);
  });
});

test("exhausted inventory budget authorizes no deletion and a complete later pass recovers", async () => {
  await withFixture(async (fixture) => {
    addUnrelatedOrganizations(fixture, 501);
    const user = await createUser(generateTestEmail("playwright"));
    const organization = await createOrganization(
      "Fixture",
      user,
      "playwright",
    );
    fixture.requests.length = 0;
    await assert.rejects(
      withClerkCleanupBudget(
        () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
        { maxRequests: 2 },
      ),
      /request budget exhausted \(2\/2 attempts\)/,
    );
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.users.has(user), true);
    assert.equal(fixture.organizations.has(organization), true);
    await cleanupStaleClerkTestResources(["playwright"], new Date(1));
    assert.equal(fixture.users.has(user), false);
    assert.equal(fixture.organizations.has(organization), false);
    assert.equal(fixture.organizations.size, 501);
  });
});

test("partial organization deletion retains users and the next sweep completes cleanup", async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 2; index += 1) {
      const user = await createUser(generateTestEmail("playwright"));
      await createOrganization("Fixture", user, "playwright");
    }
    fixture.requests.length = 0;
    await assert.rejects(
      withClerkCleanupBudget(
        () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
        { maxRequests: 3 },
      ),
      /request budget exhausted \(3\/3 attempts\)/,
    );
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.organizations.size, 1);
    assert.equal(fixture.users.size, 2);
    await cleanupStaleClerkTestResources(["playwright"], new Date(1));
    assert.equal(fixture.organizations.size, 0);
    assert.equal(fixture.users.size, 0);
  });
});

test("provider retries consume the same cleanup budget", async () => {
  await withFixture(async (fixture) => {
    fixture.failReads = true;
    await assert.rejects(
      withClerkCleanupBudget(
        () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
        { maxRequests: 2 },
      ),
      /request budget exhausted \(2\/2 attempts\)/,
    );
    assert.deepEqual(fixture.requests, ["GET /v1/users", "GET /v1/users"]);
    fixture.failReads = false;
    await cleanupStaleClerkTestResources(["playwright"], new Date(1));
  });
});

test("automatic redirects cannot escape the cleanup request budget", async () => {
  await withFixture(async (fixture) => {
    fixture.redirectReads = true;
    await assert.rejects(
      withClerkCleanupBudget(
        () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
        { maxRequests: 2 },
      ),
      /request budget exhausted \(2\/2 attempts\)/,
    );
    assert.deepEqual(fixture.requests, ["GET /v1/users", "GET /v1/users"]);
  });
});

test(
  "the cleanup deadline cancels a stalled response body before any deletion",
  { timeout: 10_000 },
  async () => {
    await withFixture(async (fixture) => {
      fixture.stallBody = true;
      await assert.rejects(
        withClerkCleanupBudget(
          () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
          { maxDurationMs: 500 },
        ),
        /response read failed/,
      );
      assert.deepEqual(fixture.requests, ["GET /v1/users"]);
    });
  },
);

test(
  "pacing waits share the deadline and cannot start a late request",
  { timeout: 10_000 },
  async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(
        withClerkCleanupBudget(
          () => cleanupStaleClerkTestResources(["playwright"], new Date(1)),
          {
            maxDurationMs: 500,
            requestIntervalMs: 5_000,
          },
        ),
        /Clerk cleanup time budget exhausted/,
      );
      assert.deepEqual(fixture.requests, ["GET /v1/users"]);
    });
  },
);

function addUnrelatedOrganizations(fixture: Fixture, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const id = `org_unrelated_${index}`;
    fixture.organizations.set(id, { id, created_at: 0, private_metadata: {} });
  }
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clerk-cleanup-lifecycle-"));
  const fixture: Fixture = {
    users: new Map(),
    organizations: new Map(),
    requests: [],
    loseOrganizationResponse: false,
    failMembershipUpdate: false,
    failDeletes: false,
    failReads: false,
    redirectReads: false,
    stallBody: false,
  };
  let nextUser = 0;
  let nextOrganization = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    fixture.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && fixture.redirectReads) {
      response.writeHead(307, { location: "/v1/organizations" });
      response.end();
      return;
    }
    if (request.method === "GET" && fixture.failReads) {
      send(response, {}, 503);
      return;
    }
    if (request.method === "DELETE" && fixture.failDeletes) {
      send(response, {}, 403);
      return;
    }
    if (request.method === "GET" && fixture.stallBody) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("[");
      return;
    }
    if (request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<
        string,
        unknown
      >;
      if (url.pathname === "/v1/users") {
        assert.ok(Array.isArray(body.email_address));
        assert.equal(typeof body.email_address[0], "string");
        const id = `user_${++nextUser}`;
        fixture.users.set(id, {
          id,
          created_at: 0,
          email_addresses: [{ email_address: String(body.email_address[0]) }],
        });
        send(response, { id });
        return;
      }
      if (url.pathname === "/v1/organizations") {
        const id = `org_${++nextOrganization}`;
        fixture.organizations.set(id, {
          id,
          created_at: 0,
          private_metadata: body.private_metadata,
        });
        if (fixture.loseOrganizationResponse) {
          response.destroy();
        } else {
          send(response, { id });
        }
        return;
      }
    }
    if (request.method === "PATCH" && url.pathname.includes("/memberships/")) {
      send(
        response,
        { role: "org:admin" },
        fixture.failMembershipUpdate ? 400 : 200,
      );
      return;
    }
    const match = /^\/v1\/(users|organizations)(?:\/([^/]+))?$/.exec(
      url.pathname,
    );
    assert.ok(
      match,
      `Unexpected fixture request ${request.method} ${url.pathname}`,
    );
    const resources =
      match[1] === "users" ? fixture.users : fixture.organizations;
    const id = match[2];
    if (request.method === "GET" && !id) {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const page = [...resources.values()].slice(offset, offset + limit);
      send(
        response,
        match[1] === "users"
          ? page
          : { data: page, total_count: resources.size },
      );
    } else if (request.method === "GET" && id) {
      send(response, resources.get(id) ?? {}, resources.has(id) ? 200 : 404);
    } else if (request.method === "DELETE" && id) {
      send(response, {}, resources.delete(id) ? 200 : 404);
    } else {
      assert.fail(
        `Unexpected fixture request ${request.method} ${url.pathname}`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const environment = {
    CLERK_API_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    CLERK_SECRET_KEY: "fixture-secret",
    E2E_CLERK_RESOURCE_DIR: directory,
    JOB_REF: "pr-123",
    GITHUB_RUN_ID: "8000",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const previous = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  try {
    await run(fixture);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
