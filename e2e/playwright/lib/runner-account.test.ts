import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

interface TestOwner {
  readonly jobRef: string;
  readonly generation: string;
  readonly role: string;
}

interface OrganizationRequest {
  readonly created_by: string;
  readonly name: string;
  readonly private_metadata: {
    readonly vm0CiTest: TestOwner;
  };
}

interface StoredUser {
  readonly id: string;
  readonly email: string;
}

interface StoredOrganization {
  readonly id: string;
  readonly request: OrganizationRequest;
}

interface ClerkFixtureState {
  readonly users: StoredUser[];
  readonly organizations: StoredOrganization[];
  readonly organizationRequests: OrganizationRequest[];
  readonly deletionEvents: string[];
  readonly requests: string[];
  readonly memberships: Map<string, { userId: string; role: string }>;
  userCreateCount: number;
}

interface ClerkFixture {
  readonly apiUrl: string;
  readonly server: Server;
  readonly state: ClerkFixtureState;
}

interface FixtureOptions {
  readonly failUserCreateAt?: number;
  failOrganizationDelete?: boolean;
  readonly creatorRole?: string;
  readonly failMembershipUpdate?: boolean;
  readonly organizationSettingsResponse?: {
    readonly status: number;
    readonly body: unknown;
  };
}

test("prepares and cleans one generation of runner accounts", async () => {
  const fixture = await startClerkFixture();
  const tempDirectory = await mkdtemp(join(tmpdir(), "runner-account-test-"));
  try {
    const githubOutput = join(tempDirectory, "github-output");
    const environment = runnerEnvironment(fixture.apiUrl, {
      GITHUB_OUTPUT: githubOutput,
    });

    await runRunnerAccount("prepare", environment);

    // Baseline: five user POSTs, five organization POSTs and five role PATCHes.
    assert.equal(fixture.state.requests.length, 11);
    await assertPreparedAdminMemberships(fixture.apiUrl, githubOutput);
    assert.deepEqual(fixture.state.organizationRequests, [
      organizationRequest("user_1", "e2e-runner-pr-123", "runner"),
      organizationRequest(
        "user_2",
        "e2e-runner-real-codex-pr-123",
        "runner-real-codex",
      ),
      organizationRequest(
        "user_3",
        "e2e-runner-real-claude-pr-123",
        "runner-real-claude",
      ),
      organizationRequest(
        "user_4",
        "e2e-runner-mock-claude-pr-123",
        "runner-mock-claude",
      ),
      organizationRequest(
        "user_5",
        "e2e-runner-real-codex-built-in-pr-123",
        "runner-real-codex-built-in",
      ),
    ]);
    assert.equal(
      await readFile(githubOutput, "utf8"),
      [
        "runner-organization-id=org_1",
        "codex-organization-id=org_2",
        "claude-organization-id=org_3",
        "mock-claude-organization-id=org_4",
        "codex-built-in-organization-id=org_5",
        "runner-email=pr-123+clerk_test+9001-3+runner@vm0-e2e.ai",
        "codex-email=pr-123+clerk_test+9001-3+runner-real-codex@vm0-e2e.ai",
        "claude-email=pr-123+clerk_test+9001-3+runner-real-claude@vm0-e2e.ai",
        "mock-claude-email=pr-123+clerk_test+9001-3+runner-mock-claude@vm0-e2e.ai",
        "codex-built-in-email=pr-123+clerk_test+9001-3+runner-real-codex-built-in@vm0-e2e.ai",
        "",
      ].join("\n"),
    );

    fixture.state.users.push({
      id: "user_foreign",
      email: "pr-123+clerk_test+9001-2+runner@vm0-e2e.ai",
    });
    fixture.state.organizations.push({
      id: "org_foreign",
      request: {
        created_by: "user_foreign",
        name: "foreign generation",
        private_metadata: {
          vm0CiTest: {
            jobRef: "pr-123",
            generation: "9001-2",
            role: "runner",
          },
        },
      },
    });

    await runRunnerAccount(
      "cleanup-generation",
      runnerEnvironment(fixture.apiUrl),
    );

    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "organization:org_2",
      "organization:org_3",
      "organization:org_4",
      "organization:org_5",
      "user:user_1",
      "user:user_2",
      "user:user_3",
      "user:user_4",
      "user:user_5",
    ]);
    assert.deepEqual(fixture.state.users, [
      {
        id: "user_foreign",
        email: "pr-123+clerk_test+9001-2+runner@vm0-e2e.ai",
      },
    ]);
    assert.deepEqual(
      fixture.state.organizations.map((organization) => organization.id),
      ["org_foreign"],
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("prepares admin identities when Clerk uses a non-default creator role", async () => {
  const fixture = await startClerkFixture({ creatorRole: "org:owner" });
  const directory = await mkdtemp(join(tmpdir(), "runner-creator-role-"));
  const githubOutput = join(directory, "github-output");
  const environment = runnerEnvironment(fixture.apiUrl, {
    GITHUB_OUTPUT: githubOutput,
    E2E_CLERK_RESOURCE_DIR: join(directory, "resources"),
  });
  try {
    await runRunnerAccount("prepare", environment);
    assert.equal(fixture.state.requests.length, 16);
    await assertPreparedAdminMemberships(fixture.apiUrl, githubOutput);
    await runRunnerAccount("cleanup-recorded-generation", environment);
    assert.deepEqual(fixture.state.users, []);
    assert.deepEqual(fixture.state.organizations, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("rejects unsupported or unavailable creator settings before provisioning", async (context) => {
  const cases = [
    { name: "missing role", status: 200, body: { enabled: true } },
    {
      name: "invalid role",
      status: 200,
      body: { enabled: true, creator_role: null },
    },
    {
      name: "empty role",
      status: 200,
      body: { enabled: true, creator_role: " " },
    },
    {
      name: "disabled organizations",
      status: 200,
      body: { enabled: false, creator_role: "org:admin" },
    },
    { name: "provider error", status: 403, body: { errors: [] } },
    { name: "rate limited", status: 429, body: { errors: [] } },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const fixture = await startClerkFixture({
        organizationSettingsResponse: scenario,
      });
      const directory = await mkdtemp(join(tmpdir(), "runner-settings-error-"));
      const githubOutput = join(directory, "github-output");
      try {
        await assert.rejects(
          runRunnerAccount(
            "prepare",
            runnerEnvironment(fixture.apiUrl, {
              GITHUB_OUTPUT: githubOutput,
              E2E_CLERK_RESOURCE_DIR: join(directory, "resources"),
            }),
          ),
          /read Clerk organization settings/,
        );
        assert.deepEqual(fixture.state.users, []);
        assert.deepEqual(fixture.state.organizations, []);
        assert.deepEqual(fixture.state.requests, [
          "GET /v1/instance/organization_settings",
        ]);
        await assert.rejects(readFile(githubOutput), { code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true, force: true });
        await closeServer(fixture.server);
      }
    });
  }
});

test("rolls back a non-default creator when explicit admin setup fails", async () => {
  const fixture = await startClerkFixture({
    creatorRole: "org:owner",
    failMembershipUpdate: true,
  });
  const directory = await mkdtemp(join(tmpdir(), "runner-role-rollback-"));
  const githubOutput = join(directory, "github-output");
  try {
    await assert.rejects(
      runRunnerAccount(
        "prepare",
        runnerEnvironment(fixture.apiUrl, {
          GITHUB_OUTPUT: githubOutput,
          E2E_CLERK_RESOURCE_DIR: join(directory, "resources"),
        }),
      ),
      /update Clerk organization membership failed with HTTP 400/,
    );
    assert.deepEqual(fixture.state.users, []);
    assert.deepEqual(fixture.state.organizations, []);
    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "user:user_1",
    ]);
    await assert.rejects(readFile(githubOutput), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("runner resource records survive preparation and a later cleanup attempt", async () => {
  const fixture = await startClerkFixture();
  const directory = await mkdtemp(join(tmpdir(), "runner-records-test-"));
  try {
    const environment = runnerEnvironment(fixture.apiUrl, {
      GITHUB_OUTPUT: join(directory, "github-output"),
      E2E_CLERK_RESOURCE_DIR: join(directory, "resources"),
    });
    await runRunnerAccount("prepare", environment);
    assert.equal(fixture.state.organizations.length, 5);
    await runRunnerAccount("cleanup-recorded-run", {
      ...environment,
      GITHUB_RUN_ATTEMPT: "4",
    });
    assert.deepEqual(fixture.state.organizations, []);
    assert.deepEqual(fixture.state.users, []);
    assert.equal(fixture.state.deletionEvents.length, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("run cleanup removes every runner generation for the exact workflow run", async () => {
  const fixture = await startClerkFixture();
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "runner-account-run-cleanup-test-"),
  );
  try {
    await runRunnerAccount(
      "prepare",
      runnerEnvironment(fixture.apiUrl, {
        GITHUB_OUTPUT: join(tempDirectory, "github-output-1"),
        GITHUB_RUN_ATTEMPT: "1",
      }),
    );
    await runRunnerAccount(
      "prepare",
      runnerEnvironment(fixture.apiUrl, {
        GITHUB_OUTPUT: join(tempDirectory, "github-output-2"),
        GITHUB_RUN_ATTEMPT: "2",
      }),
    );

    const retainedResources = [
      {
        id: "other_run",
        email: "pr-123+clerk_test+90010-1+runner@vm0-e2e.ai",
        owner: {
          jobRef: "pr-123",
          generation: "90010-1",
          role: "runner",
        },
      },
      {
        id: "other_job_ref",
        email: "pr-124+clerk_test+9001-1+runner@vm0-e2e.ai",
        owner: {
          jobRef: "pr-124",
          generation: "9001-1",
          role: "runner",
        },
      },
      {
        id: "other_role",
        email: "pr-123+clerk_test+9001-1+browser@vm0-e2e.ai",
        owner: {
          jobRef: "pr-123",
          generation: "9001-1",
          role: "browser",
        },
      },
    ] as const;
    for (const resource of retainedResources) {
      fixture.state.users.push({
        id: `user_${resource.id}`,
        email: resource.email,
      });
      fixture.state.organizations.push({
        id: `org_${resource.id}`,
        request: {
          created_by: `user_${resource.id}`,
          name: resource.id,
          private_metadata: { vm0CiTest: resource.owner },
        },
      });
    }

    await runRunnerAccount("cleanup-run", runnerEnvironment(fixture.apiUrl));

    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "organization:org_2",
      "organization:org_3",
      "organization:org_4",
      "organization:org_5",
      "organization:org_6",
      "organization:org_7",
      "organization:org_8",
      "organization:org_9",
      "organization:org_10",
      "user:user_1",
      "user:user_2",
      "user:user_3",
      "user:user_4",
      "user:user_5",
      "user:user_6",
      "user:user_7",
      "user:user_8",
      "user:user_9",
      "user:user_10",
    ]);
    assert.deepEqual(
      fixture.state.users.map((user) => user.id),
      retainedResources.map((resource) => `user_${resource.id}`),
    );
    assert.deepEqual(
      fixture.state.organizations.map((organization) => organization.id),
      retainedResources.map((resource) => `org_${resource.id}`),
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("cleanup commands require an explicit job ref", async () => {
  const environment: Readonly<NodeJS.ProcessEnv> = {
    ...runnerEnvironment("http://127.0.0.1:1/v1"),
    JOB_REF: undefined,
  };

  for (const command of ["cleanup-generation", "cleanup-run"] as const) {
    await assert.rejects(
      runRunnerAccount(command, environment),
      /JOB_REF environment variable is required/,
    );
  }
});

test("partial runner preparation cleans resources without outputs", async () => {
  const fixture = await startClerkFixture({ failUserCreateAt: 2 });
  const tempDirectory = await mkdtemp(
    join(tmpdir(), "runner-account-partial-test-"),
  );
  try {
    await assert.rejects(
      runRunnerAccount(
        "prepare",
        runnerEnvironment(fixture.apiUrl, {
          GITHUB_OUTPUT: join(tempDirectory, "github-output"),
          E2E_CLERK_RESOURCE_DIR: join(tempDirectory, "resources"),
        }),
      ),
      /create Clerk user failed with HTTP 400 \(json\)/,
    );

    assert.deepEqual(fixture.state.users, []);
    assert.deepEqual(fixture.state.organizations, []);
    assert.deepEqual(fixture.state.deletionEvents, [
      "organization:org_1",
      "user:user_1",
    ]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

test("failed preparation preserves its original error and recorded resources when cleanup fails", async () => {
  const options: FixtureOptions = {
    failUserCreateAt: 2,
    failOrganizationDelete: true,
  };
  const fixture = await startClerkFixture(options);
  const directory = await mkdtemp(join(tmpdir(), "runner-cleanup-failure-"));
  const environment = runnerEnvironment(fixture.apiUrl, {
    GITHUB_OUTPUT: join(directory, "github-output"),
    E2E_CLERK_RESOURCE_DIR: join(directory, "resources"),
  });
  try {
    await assert.rejects(
      runRunnerAccount("prepare", environment),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Recorded runner cleanup failed/);
        assert.match(
          error.message,
          /delete Clerk test organization failed with HTTP 403/,
        );
        assert.match(error.message, /create Clerk user failed with HTTP 400/);
        return true;
      },
    );
    assert.equal(fixture.state.users.length, 1);
    assert.equal(fixture.state.organizations.length, 1);
    assert.deepEqual(fixture.state.deletionEvents, []);
    options.failOrganizationDelete = false;
    await runRunnerAccount("cleanup-recorded-generation", environment);
    assert.deepEqual(fixture.state.users, []);
    assert.deepEqual(fixture.state.organizations, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await closeServer(fixture.server);
  }
});

async function startClerkFixture(
  options: FixtureOptions = {},
): Promise<ClerkFixture> {
  const state: ClerkFixtureState = {
    users: [],
    organizations: [],
    organizationRequests: [],
    deletionEvents: [],
    requests: [],
    memberships: new Map(),
    userCreateCount: 0,
  };
  const server = createServer((request, response) => {
    handleClerkRequest(request, response, state, options).catch(
      (error: unknown) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Expected Clerk fixture to listen on a TCP port");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/v1`,
    server,
    state,
  };
}

async function handleClerkRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ClerkFixtureState,
  options: FixtureOptions,
): Promise<void> {
  const path = request.url ?? "";
  const url = new URL(path, "http://clerk.test");
  state.requests.push(`${request.method} ${path}`);
  if (
    request.method === "GET" &&
    url.pathname === "/v1/instance/organization_settings"
  ) {
    const result = options.organizationSettingsResponse;
    sendJson(
      response,
      result
        ? result.body
        : {
            object: "organization_settings",
            enabled: true,
            creator_role: options.creatorRole ?? "org:admin",
          },
      result ? result.status : 200,
    );
    return;
  }
  const membershipPath = /^\/v1\/organizations\/(org_\d+)\/memberships$/.exec(
    url.pathname,
  );
  if (request.method === "GET" && membershipPath) {
    const membership = state.memberships.get(membershipPath[1]);
    sendJson(response, {
      data: membership
        ? [
            {
              role: membership.role,
              public_user_data: { user_id: membership.userId },
            },
          ]
        : [],
      total_count: membership ? 1 : 0,
    });
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/v1/users/")) {
    const id = url.pathname.slice("/v1/users/".length);
    const user = state.users.find((candidate) => candidate.id === id);
    sendJson(
      response,
      user ? { id, email_addresses: [{ email_address: user.email }] } : {},
      user ? 200 : 404,
    );
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname.startsWith("/v1/organizations/")
  ) {
    const id = url.pathname.slice("/v1/organizations/".length);
    const organization = state.organizations.find(
      (candidate) => candidate.id === id,
    );
    sendJson(
      response,
      organization
        ? { id, private_metadata: organization.request.private_metadata }
        : {},
      organization ? 200 : 404,
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/users") {
    sendJson(
      response,
      state.users.map((user) => ({
        id: user.id,
        email_addresses: [{ email_address: user.email }],
      })),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/organizations") {
    sendJson(response, {
      data: state.organizations.map((organization) => ({
        id: organization.id,
        private_metadata: organization.request.private_metadata,
      })),
      total_count: state.organizations.length,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/users") {
    state.userCreateCount += 1;
    if (state.userCreateCount === options.failUserCreateAt) {
      sendJson(response, { errors: [] }, 400);
      return;
    }
    const email = await readUserEmail(request);
    const id = `user_${state.userCreateCount}`;
    state.users.push({ id, email });
    sendJson(response, { id });
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/organizations") {
    const body = await readOrganizationRequest(request);
    const id = `org_${state.organizations.length + 1}`;
    state.organizationRequests.push(body);
    state.organizations.push({ id, request: body });
    state.memberships.set(id, {
      userId: body.created_by,
      role: options.creatorRole ?? "org:admin",
    });
    sendJson(response, { id });
    return;
  }
  if (
    request.method === "PATCH" &&
    /^\/v1\/organizations\/org_\d+\/memberships\/user_\d+$/.test(url.pathname)
  ) {
    if (options.failMembershipUpdate) {
      sendJson(response, { errors: [] }, 400);
      return;
    }
    const [, , , organizationId, , userId] = url.pathname.split("/");
    const membership = state.memberships.get(organizationId);
    const body = await readJsonBody(request);
    if (
      !membership ||
      membership.userId !== userId ||
      !isRecord(body) ||
      body.role !== "org:admin"
    ) {
      sendJson(response, { errors: [] }, 422);
      return;
    }
    membership.role = body.role;
    sendJson(response, { role: "org:admin" });
    return;
  }
  if (
    request.method === "DELETE" &&
    url.pathname.startsWith("/v1/organizations/")
  ) {
    if (options.failOrganizationDelete) {
      sendJson(response, {}, 403);
      return;
    }
    const id = url.pathname.slice("/v1/organizations/".length);
    state.memberships.delete(id);
    deleteStoredResource(
      state.organizations,
      id,
      state.deletionEvents,
      "organization",
    );
    sendJson(response, {});
    return;
  }
  if (request.method === "DELETE" && url.pathname.startsWith("/v1/users/")) {
    const id = url.pathname.slice("/v1/users/".length);
    deleteStoredResource(state.users, id, state.deletionEvents, "user");
    sendJson(response, {});
    return;
  }
  sendJson(response, { error: "not found" }, 404);
}

async function assertPreparedAdminMemberships(
  apiUrl: string,
  githubOutput: string,
): Promise<void> {
  const output = await readFile(githubOutput, "utf8");
  const organizationIds = output
    .split("\n")
    .filter((line) => line.includes("-organization-id="))
    .map((line) => line.split("=")[1]);
  assert.equal(organizationIds.length, 5);
  assert.equal(new Set(organizationIds).size, 5);
  for (const [index, id] of organizationIds.entries()) {
    const response = await fetch(`${apiUrl}/organizations/${id}/memberships`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      data: [
        {
          role: "org:admin",
          public_user_data: { user_id: `user_${index + 1}` },
        },
      ],
      total_count: 1,
    });
  }
}

function deleteStoredResource<T extends { readonly id: string }>(
  resources: T[],
  id: string,
  events: string[],
  type: "organization" | "user",
): void {
  const index = resources.findIndex((resource) => resource.id === id);
  if (index === -1) {
    return;
  }
  resources.splice(index, 1);
  events.push(`${type}:${id}`);
}

async function readUserEmail(request: IncomingMessage): Promise<string> {
  const parsed = await readJsonBody(request);
  if (!isRecord(parsed) || !Array.isArray(parsed.email_address)) {
    throw new Error("Invalid user request");
  }
  const email = parsed.email_address[0];
  if (typeof email !== "string") {
    throw new Error("Invalid user request email");
  }
  return email;
}

async function readOrganizationRequest(
  request: IncomingMessage,
): Promise<OrganizationRequest> {
  const parsed = await readJsonBody(request);
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    typeof parsed.created_by !== "string" ||
    !isRecord(parsed.private_metadata) ||
    !isRecord(parsed.private_metadata.vm0CiTest)
  ) {
    throw new Error("Invalid organization request");
  }
  const owner = parsed.private_metadata.vm0CiTest;
  if (
    typeof owner.jobRef !== "string" ||
    typeof owner.generation !== "string" ||
    typeof owner.role !== "string"
  ) {
    throw new Error("Invalid organization owner metadata");
  }
  return {
    name: parsed.name,
    created_by: parsed.created_by,
    private_metadata: {
      vm0CiTest: {
        jobRef: owner.jobRef,
        generation: owner.generation,
        role: owner.role,
      },
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", resolve);
    request.on("error", reject);
  });
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

function organizationRequest(
  createdBy: string,
  name: string,
  role: string,
): OrganizationRequest {
  return {
    created_by: createdBy,
    name,
    private_metadata: {
      vm0CiTest: {
        jobRef: "pr-123",
        generation: "9001-3",
        role,
      },
    },
  };
}

function runnerEnvironment(
  clerkApiUrl: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    CLERK_API_TEST_BASE_URL: clerkApiUrl,
    CLERK_SECRET_KEY: "clerk-test-secret",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_RUN_ID: "9001",
    JOB_REF: "pr-123",
    ...extra,
  };
}

async function runRunnerAccount(
  command:
    | "prepare"
    | "cleanup-generation"
    | "cleanup-run"
    | "cleanup-recorded-generation"
    | "cleanup-recorded-run",
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "playwright/runner-account.ts", command],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
    },
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
