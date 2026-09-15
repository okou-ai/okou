import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";

import {
  cleanupClerkTestJobRef,
  cleanupCurrentClerkTestGeneration,
  cleanupStaleClerkTestResources,
  createOrganization,
  createUser,
  currentClerkTestGeneration,
  deleteClerkTestOwnerResources,
  deleteOrganizationById,
  deleteUserByEmail,
  generateTestEmail,
  parseClerkTestEmail,
  parseClerkTestOrganizationMetadata,
  runnerTestAccounts,
} from "./clerk-api";

interface ObservedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type ClerkServerHandler = (
  request: ObservedRequest,
  response: ServerResponse,
  requests: readonly ObservedRequest[],
) => void;

test("creates and parses generation-scoped test identities", () => {
  withEnvironment(
    {
      JOB_REF: "pr-123",
      GITHUB_RUN_ID: "31500000000",
      GITHUB_RUN_ATTEMPT: "2",
    },
    () => {
      assert.equal(currentClerkTestGeneration(), "31500000000-2");
      assert.equal(
        generateTestEmail("browser"),
        "pr-123+clerk_test+31500000000-2+browser@vm0-e2e.ai",
      );
      assert.match(
        generateTestEmail("playwright"),
        /^pr-123\+clerk_test\+31500000000-2\+playwright-[0-9a-f]{8}@vm0-e2e\.ai$/,
      );
      assert.deepEqual(runnerTestAccounts(), {
        runner: "pr-123+clerk_test+31500000000-2+runner@vm0-e2e.ai",
        codex: "pr-123+clerk_test+31500000000-2+runner-real-codex@vm0-e2e.ai",
        claude: "pr-123+clerk_test+31500000000-2+runner-real-claude@vm0-e2e.ai",
        mockClaude:
          "pr-123+clerk_test+31500000000-2+runner-mock-claude@vm0-e2e.ai",
      });
    },
  );

  assert.deepEqual(
    parseClerkTestEmail(
      "staging+clerk_test+31500000000-1+paid-onboarding-0123abcd@vm0-e2e.ai",
    ),
    {
      jobRef: "staging",
      generation: "31500000000-1",
      role: "paid-onboarding",
    },
  );
  assert.equal(
    parseClerkTestEmail("pr-123+clerk_test+31500000000-1+browser@example.com"),
    null,
  );
  assert.equal(
    parseClerkTestEmail("pr-123+clerk_test+browser@vm0-e2e.ai"),
    null,
  );
  assert.equal(
    parseClerkTestEmail(
      "pr-123+clerk_test+31500000000-1+browser-deadbeef@vm0-e2e.ai",
    ),
    null,
  );
  assert.equal(
    parseClerkTestOrganizationMetadata({
      vm0CiTest: {
        jobRef: "pr-123",
        generation: "31500000000-1",
        role: "playwright",
        extra: true,
      },
    }),
    null,
  );
  assert.equal(
    parseClerkTestOrganizationMetadata({
      vm0CiTest: {
        jobRef: "pr-123",
        generation: "31500000000-1",
        role: "admin",
      },
    }),
    null,
  );

  withEnvironment(
    {
      JOB_REF: undefined,
      GITHUB_RUN_ID: undefined,
      GITHUB_RUN_ATTEMPT: undefined,
    },
    () => {
      assert.equal(
        generateTestEmail("browser"),
        "local+clerk_test+local-1+browser@vm0-e2e.ai",
      );
    },
  );
});

test("creates a password-backed test identity without skipping its password policy", async () => {
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/users") {
        sendJson(response, 200, { id: "user_password_fixture" });
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const id = await createUser(
        "password-fixture@example.com",
        "Fixture-Password!2026",
      );
      assert.equal(id, "user_password_fixture");
      const request = requests.find((item) => item.url === "/v1/users");
      assert.ok(isRecord(request?.body));
      assert.equal(request.body.password, "Fixture-Password!2026");
      assert.equal(request.body.skip_password_requirement, undefined);
    },
  );
});

test("creates organizations with exact ownership metadata and retries a 5xx membership update", async () => {
  await withClerkServer(
    (request, response, requests) => {
      if (request.method === "POST" && request.url === "/v1/organizations") {
        sendJson(response, 200, { id: "org_test" });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === "/v1/organizations/org_test/memberships/user_test"
      ) {
        const patchCount = countRequests(
          requests,
          "PATCH",
          "/v1/organizations/org_test/memberships/user_test",
        );
        if (patchCount === 1) {
          sendJson(response, 503, { errors: [] }, { "retry-after": "0" });
        } else {
          sendJson(response, 200, { role: "org:admin" });
        }
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const organizationId = await createOrganization(
        "E2E Test Org",
        "user_test",
        "playwright",
      );

      assert.equal(organizationId, "org_test");
      const createRequest = requests.find(
        (request) =>
          request.method === "POST" && request.url === "/v1/organizations",
      );
      assert.deepEqual(createRequest?.body, {
        name: "E2E Test Org",
        created_by: "user_test",
        private_metadata: {
          vm0CiTest: {
            jobRef: "test-job",
            generation: "4000-2",
            role: "playwright",
          },
        },
      });
      assert.deepEqual(
        parseClerkTestOrganizationMetadata(
          isRecord(createRequest?.body)
            ? createRequest.body.private_metadata
            : undefined,
        ),
        {
          jobRef: "test-job",
          generation: "4000-2",
          role: "playwright",
        },
      );
      assert.equal(
        countRequests(
          requests,
          "PATCH",
          "/v1/organizations/org_test/memberships/user_test",
        ),
        2,
      );
    },
  );
});

test("does not retry rate-limited Clerk lookups", async () => {
  await withClerkServer(
    (_request, response) => {
      sendJson(response, 429, { errors: [] }, { "retry-after": "0" });
    },
    async (requests) => {
      await assert.rejects(deleteUserByEmail("limited@example.com"), /429/);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.method, "GET");
    },
  );
});

test("does not retry rate-limited Clerk deletions", async () => {
  await withClerkServer(
    (_request, response) => {
      sendJson(response, 429, { errors: [] }, { "retry-after": "0" });
    },
    async (requests) => {
      await assert.rejects(deleteOrganizationById("org_limited"), /429/);
      assert.equal(
        countRequests(requests, "DELETE", "/v1/organizations/org_limited"),
        1,
      );
    },
  );
});

test("removes a newly created organization when membership setup fails", async () => {
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/organizations") {
        sendJson(response, 200, { id: "org_partial" });
        return;
      }
      if (
        request.method === "PATCH" &&
        request.url === "/v1/organizations/org_partial/memberships/user_test"
      ) {
        sendJson(response, 400, { errors: [] });
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/organizations/org_partial"
      ) {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const error = await captureError(async () => {
        await createOrganization("E2E Test Org", "user_test", "playwright");
      });
      assert.match(
        error.message,
        /update Clerk organization membership failed with HTTP 400 \(json\)/,
      );
      assert.equal(
        countRequests(requests, "DELETE", "/v1/organizations/org_partial"),
        1,
      );
    },
  );
});

test("reconciles owner resources when setup loses the organization ID", async () => {
  const email = "test-job+clerk_test+4000-2+playwright-deadbeef@vm0-e2e.ai";
  await withClerkServer(
    (request, response) => {
      const url = new URL(request.url, "http://clerk.test");
      if (request.method === "GET" && url.pathname === "/v1/users") {
        sendJson(response, 200, [clerkUser("user_partial", email)]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/organizations") {
        sendJson(response, 200, {
          data: [
            clerkOrganization(
              "org_partial",
              clerkOwner("test-job", "4000-2", "playwright"),
            ),
          ],
          total_count: 1,
        });
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      await deleteClerkTestOwnerResources(email, undefined, "playwright");

      assert.deepEqual(
        requests
          .filter((request) => request.method === "DELETE")
          .map((request) => request.url),
        ["/v1/organizations/org_partial", "/v1/users/user_partial"],
      );
    },
  );
});

test("does not replay non-idempotent user creation", async () => {
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/users") {
        sendJson(response, 503, { errors: [] });
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const error = await captureError(async () => {
        await createUser("single-attempt@example.com");
      });

      assert.match(
        error.message,
        /create Clerk user failed with HTTP 503 \(json\)/,
      );
      assert.equal(countRequests(requests, "POST", "/v1/users"), 1);
    },
  );
});

test("does not replay a create whose response is lost after it was sent", async () => {
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/users") {
        requestSocketFailure(response);
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const error = await captureError(async () => {
        await createUser("lost-response@example.com");
      });

      assert.match(
        error.message,
        /^create Clerk user request failed after 1 attempt: /,
      );
      assert.match(error.message, /UND_ERR_SOCKET/);
      assert.equal(countRequests(requests, "POST", "/v1/users"), 1);
    },
  );
});

test("reissues a create whose connection was never established", async () => {
  await withUnreachableClerkServer(async () => {
    const error = await captureError(async () => {
      await createUser("unreachable@example.com");
    });

    assert.match(
      error.message,
      /^create Clerk user request failed after 4 attempts: /,
    );
    assert.match(error.message, /ECONNREFUSED/);
  });
});

test("collects all pages before generation cleanup and isolates roles", async () => {
  const currentPlaywrightEmail =
    "test-job+clerk_test+4000-2+playwright-deadbeef@vm0-e2e.ai";
  const currentPaidEmail =
    "test-job+clerk_test+4000-2+paid-onboarding-0123abcd@vm0-e2e.ai";
  const firstUserPage = Array.from({ length: 500 }, (_, index) =>
    clerkUser(
      index === 499 ? "user_playwright" : `foreign_user_${index}`,
      index === 499 ? currentPlaywrightEmail : `person-${index}@example.com`,
    ),
  );
  const firstOrganizationPage = Array.from({ length: 500 }, (_, index) =>
    clerkOrganization(
      index === 499 ? "org_playwright" : `foreign_org_${index}`,
      index === 499
        ? clerkOwner("test-job", "4000-2", "playwright")
        : undefined,
    ),
  );

  await withClerkServer(
    (request, response, requests) => {
      const url = new URL(request.url, "http://clerk.test");
      if (request.method === "GET" && url.pathname === "/v1/users") {
        const offset = url.searchParams.get("offset");
        sendJson(
          response,
          200,
          offset === "0"
            ? firstUserPage
            : [clerkUser("user_paid", currentPaidEmail)],
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/organizations") {
        const offset = url.searchParams.get("offset");
        sendJson(response, 200, {
          data:
            offset === "0"
              ? firstOrganizationPage
              : [
                  clerkOrganization(
                    "org_paid",
                    clerkOwner("test-job", "4000-2", "paid-onboarding"),
                  ),
                ],
          total_count: 501,
        });
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/organizations/org_playwright"
      ) {
        const attempt = countRequests(
          requests,
          "DELETE",
          "/v1/organizations/org_playwright",
        );
        if (attempt === 1) {
          sendJson(response, 503, { errors: [] }, { "retry-after": "0" });
        } else {
          sendJson(response, 404, { errors: [] });
        }
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/users/user_playwright"
      ) {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 500, { unexpected: request.url });
    },
    async (requests) => {
      const result = await cleanupCurrentClerkTestGeneration(["playwright"]);

      assert.deepEqual(result, {
        scannedOrganizations: 501,
        selectedOrganizations: 1,
        deletedOrganizations: 0,
        alreadyAbsentOrganizations: 1,
        skippedOrganizations: 500,
        scannedUsers: 501,
        selectedUsers: 1,
        deletedUsers: 1,
        alreadyAbsentUsers: 0,
        skippedUsers: 500,
      });
      const listRequests = requests.filter(
        (request) =>
          request.method === "GET" &&
          (request.url.startsWith("/v1/users?") ||
            request.url.startsWith("/v1/organizations?")),
      );
      assert.ok(listRequests.length >= 4);
      for (const request of listRequests) {
        const listUrl = new URL(request.url, "http://clerk.test");
        assert.equal(listUrl.searchParams.get("order_by"), "+created_at");
      }
      assert.equal(
        countRequests(requests, "DELETE", "/v1/organizations/org_playwright"),
        2,
      );
      assert.equal(
        countRequests(requests, "DELETE", "/v1/organizations/org_paid"),
        0,
      );
      assert.equal(countRequests(requests, "DELETE", "/v1/users/user_paid"), 0);
      const firstDeleteIndex = requests.findIndex(
        (request) => request.method === "DELETE",
      );
      const lastCollectionIndex = requests
        .map((request) => request.method)
        .lastIndexOf("GET");
      assert.ok(firstDeleteIndex > lastCollectionIndex);
      const deletePaths = requests
        .filter((request) => request.method === "DELETE")
        .map((request) => request.url);
      assert.deepEqual(deletePaths.slice(-2), [
        "/v1/organizations/org_playwright",
        "/v1/users/user_playwright",
      ]);
    },
  );
});

test("job-ref cleanup rejects fuzzy lookalikes and deletes organizations first", async () => {
  const targetEmail = "pr-123+clerk_test+4000-2+runner@vm0-e2e.ai";
  await withClerkServer(
    (request, response) => {
      const url = new URL(request.url, "http://clerk.test");
      if (request.method === "GET" && url.pathname === "/v1/users") {
        sendJson(response, 200, [
          clerkUser("user_target", targetEmail),
          clerkUser(
            "user_other_pr",
            "pr-1234+clerk_test+4000-2+runner@vm0-e2e.ai",
          ),
          clerkUser(
            "user_lookalike",
            "pr-123+clerk_test+4000-2+runner@vm0-e2e.ai.example",
          ),
        ]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/organizations") {
        sendJson(response, 200, {
          data: [
            clerkOrganization(
              "org_target",
              clerkOwner("pr-123", "4000-2", "runner"),
            ),
            clerkOrganization(
              "org_other_pr",
              clerkOwner("pr-1234", "4000-2", "runner"),
            ),
            clerkOrganization("org_unmarked"),
          ],
          total_count: 3,
        });
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const result = await cleanupClerkTestJobRef("pr-123");
      assert.equal(result.selectedOrganizations, 1);
      assert.equal(result.selectedUsers, 1);
      const userListRequest = requests.find(
        (request) =>
          request.method === "GET" && request.url.startsWith("/v1/users?"),
      );
      assert.ok(userListRequest);
      const userListUrl = new URL(userListRequest.url, "http://clerk.test");
      assert.equal(userListUrl.searchParams.has("query"), false);
      assert.deepEqual(userListUrl.searchParams.getAll("email_address[]"), []);
      assert.deepEqual(
        requests
          .filter((request) => request.method === "DELETE")
          .map((request) => request.url),
        ["/v1/organizations/org_target", "/v1/users/user_target"],
      );
    },
  );
});

test("stale cleanup isolates roles, requires strict markers, and supports dry-run", async () => {
  const cutoff = new Date(10_000);
  await withClerkServer(
    (request, response) => {
      const url = new URL(request.url, "http://clerk.test");
      if (request.method === "GET" && url.pathname === "/v1/users") {
        sendJson(response, 200, [
          clerkUser(
            "user_old",
            "staging+clerk_test+3000-1+browser@vm0-e2e.ai",
            1_000,
          ),
          clerkUser(
            "user_new",
            "staging+clerk_test+3000-1+playwright-deadbeef@vm0-e2e.ai",
            20_000,
          ),
          clerkUser(
            "user_legacy",
            "staging+clerk_test+browser@vm0-e2e.ai",
            1_000,
          ),
          clerkUser(
            "user_at_cutoff",
            "staging+clerk_test+3000-1+runner@vm0-e2e.ai",
            10_000,
          ),
          clerkUser(
            "user_old_runner",
            "staging+clerk_test+3000-1+runner-real-codex@vm0-e2e.ai",
            1_000,
          ),
          clerkUser(
            "user_before_owned_org_cutoff",
            "staging+clerk_test+3000-1+paid-onboarding-deadbeef@vm0-e2e.ai",
            9_000,
          ),
          {
            id: "user_with_unowned_email",
            created_at: 1_000,
            email_addresses: [
              {
                email_address: "staging+clerk_test+3000-1+browser@vm0-e2e.ai",
              },
              { email_address: "owner@example.com" },
            ],
          },
        ]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/organizations") {
        sendJson(response, 200, {
          data: [
            clerkOrganization(
              "org_old",
              clerkOwner("staging", "3000-1", "browser"),
              1_000,
            ),
            clerkOrganization(
              "org_new",
              clerkOwner("staging", "3000-1", "playwright"),
              20_000,
            ),
            clerkOrganization("org_unmarked", undefined, 1_000),
            clerkOrganization(
              "org_at_cutoff",
              clerkOwner("staging", "3000-1", "runner"),
              10_000,
            ),
            clerkOrganization(
              "org_old_runner",
              clerkOwner("staging", "3000-1", "runner-real-codex"),
              1_000,
            ),
            clerkOrganization(
              "org_after_user_cutoff",
              clerkOwner("staging", "3000-1", "paid-onboarding"),
              11_000,
            ),
          ],
          total_count: 6,
        });
        return;
      }
      sendJson(response, 500, { unexpected: request.url });
    },
    async (requests) => {
      const result = await cleanupStaleClerkTestResources(
        ["browser", "paid-onboarding"],
        cutoff,
        { dryRun: true },
      );
      assert.equal(result.selectedOrganizations, 1);
      assert.equal(result.selectedUsers, 1);
      assert.equal(result.deletedOrganizations, 0);
      assert.equal(result.deletedUsers, 0);
      assert.equal(
        requests.filter((request) => request.method === "DELETE").length,
        0,
      );
    },
  );
});

test("stale cleanup removes example.com browser QA resources without shared organizations", async () => {
  const cutoff = new Date(10_000);
  await withClerkServer(
    (request, response) => {
      const url = new URL(request.url, "http://clerk.test");
      if (request.method === "GET" && url.pathname === "/v1/users") {
        sendJson(response, 200, [
          clerkUser("user_example", "qa+clerk_test@example.com", 1_000),
          clerkUser("user_fallback", "fallback@example.com", 1_000),
          clerkUser(
            "user_without_org",
            "walkthrough+clerk_test@example.com",
            1_000,
          ),
          clerkUser(
            "user_shared_creator",
            "shared+clerk_test@example.com",
            1_000,
          ),
          clerkUser(
            "user_recent_org_creator",
            "recent-org+clerk_test@example.com",
            1_000,
          ),
          clerkUser("user_recent", "active+clerk_test@example.com", 20_000),
          clerkUser("user_team", "member@vm0.ai", 1_000),
          {
            id: "user_multiple_emails",
            created_at: 1_000,
            email_addresses: [
              { email_address: "multiple+clerk_test@example.com" },
              { email_address: "member@vm0.ai" },
            ],
          },
        ]);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/organizations") {
        sendJson(response, 200, {
          data: [
            clerkOwnedOrganization("org_example", "user_example", 1_000),
            clerkOwnedOrganization("org_stale_members", "user_fallback", 1_000),
            clerkOwnedOrganization(
              "org_shared_member",
              "user_shared_creator",
              1_000,
            ),
            clerkOwnedOrganization(
              "org_recent",
              "user_recent_org_creator",
              20_000,
            ),
            clerkOwnedOrganization("org_unrelated", "user_team", 1_000),
          ],
          total_count: 5,
        });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/organizations/org_example/memberships"
      ) {
        sendJson(response, 200, clerkMemberships("user_example"));
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/organizations/org_stale_members/memberships"
      ) {
        sendJson(
          response,
          200,
          clerkMemberships("user_example", "user_fallback"),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/organizations/org_shared_member/memberships"
      ) {
        sendJson(
          response,
          200,
          clerkMemberships("user_shared_creator", "user_team"),
        );
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 500, { unexpected: request.url });
    },
    async (requests) => {
      const result = await cleanupStaleClerkTestResources(["browser"], cutoff, {
        stagingBrowserCreatedBefore: cutoff,
      });
      assert.equal(result.selectedOrganizations, 2);
      assert.equal(result.selectedUsers, 3);
      assert.deepEqual(
        requests
          .filter((request) => request.method === "DELETE")
          .map((request) => request.url),
        [
          "/v1/organizations/org_example",
          "/v1/organizations/org_stale_members",
          "/v1/users/user_example",
          "/v1/users/user_fallback",
          "/v1/users/user_without_org",
        ],
      );
      assert.equal(
        requests.some((request) =>
          request.url.startsWith("/v1/organizations/org_recent/memberships?"),
        ),
        false,
      );
    },
  );
});

test("retries exact deletion and surfaces permanent HTTP failures", async () => {
  const email = "cleanup@example.com";
  await withClerkServer(
    (request, response, requests) => {
      if (request.method === "GET" && request.url.startsWith("/v1/users?")) {
        const attempt = requests.filter(
          (observed) =>
            observed.method === "GET" && observed.url.startsWith("/v1/users?"),
        ).length;
        if (attempt === 1) {
          requestSocketFailure(response);
        } else {
          sendJson(response, 200, [clerkUser("user_cleanup", email)]);
        }
        return;
      }
      if (
        request.method === "DELETE" &&
        request.url === "/v1/users/user_cleanup"
      ) {
        sendJson(response, 400, { sensitive: "must-not-be-logged" });
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async (requests) => {
      const error = await captureError(async () => {
        await deleteUserByEmail(email);
      });
      assert.match(
        error.message,
        /delete Clerk test user failed with HTTP 400 \(json\)/,
      );
      assert.doesNotMatch(error.message, /must-not-be-logged/);
      const lookup = requests.find(
        (request) =>
          request.method === "GET" && request.url.startsWith("/v1/users?"),
      );
      assert.ok(lookup);
      const lookupUrl = new URL(lookup.url, "http://clerk.test");
      assert.deepEqual(lookupUrl.searchParams.getAll("email_address[]"), [
        email,
      ]);
      assert.equal(lookupUrl.searchParams.has("query"), false);
    },
  );

  await withClerkServer(
    (request, response) => {
      if (
        request.method === "DELETE" &&
        request.url === "/v1/organizations/org_missing"
      ) {
        sendJson(response, 404, { errors: [] });
        return;
      }
      sendJson(response, 500, { unexpected: request.url });
    },
    async () => {
      assert.equal(await deleteOrganizationById("org_missing"), false);
    },
  );
});

test("rejects non-JSON success and non-loopback test endpoints", async () => {
  const responseMarker = "sensitive-external-response-marker";
  await withClerkServer(
    (request, response) => {
      if (request.method === "POST" && request.url === "/v1/users") {
        sendText(response, 200, responseMarker, "text/html; charset=utf-8");
        return;
      }
      sendJson(response, 404, { errors: [] });
    },
    async () => {
      const error = await captureError(async () => {
        await createUser("invalid-response@example.com");
      });
      assert.match(
        error.message,
        /create Clerk user returned invalid JSON: HTTP 200 \(html\)/,
      );
      assert.doesNotMatch(error.message, new RegExp(responseMarker));
    },
  );

  await withEnvironmentAsync(
    {
      CLERK_API_TEST_BASE_URL: "https://example.com/v1",
      CLERK_SECRET_KEY: "sk_test_fixture",
    },
    async () => {
      const error = await captureError(async () => {
        await createUser("invalid-endpoint@example.com");
      });
      assert.equal(
        error.message,
        "CLERK_API_TEST_BASE_URL must use an HTTP 127.0.0.1 URL",
      );
    },
  );
});

function clerkUser(id: string, email: string, createdAt?: number): object {
  return {
    id,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    email_addresses: [{ email_address: email }],
  };
}

function clerkOwner(jobRef: string, generation: string, role: string): object {
  return { vm0CiTest: { jobRef, generation, role } };
}

function clerkOrganization(
  id: string,
  privateMetadata?: object,
  createdAt?: number,
): object {
  return {
    id,
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(privateMetadata === undefined
      ? {}
      : { private_metadata: privateMetadata }),
  };
}

function clerkOwnedOrganization(
  id: string,
  createdBy: string,
  createdAt: number,
): object {
  return {
    id,
    created_by: createdBy,
    created_at: createdAt,
  };
}

function clerkMemberships(...userIds: readonly string[]): object {
  return {
    data: userIds.map((userId) => ({ public_user_data: { user_id: userId } })),
    total_count: userIds.length,
  };
}

async function withClerkServer(
  handler: ClerkServerHandler,
  run: (requests: readonly ObservedRequest[]) => Promise<void>,
): Promise<void> {
  const requests: ObservedRequest[] = [];
  const server = createServer((incomingRequest, response) => {
    observeRequest(incomingRequest)
      .then((request) => {
        requests.push(request);
        handler(request, response, requests);
      })
      .catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined);
      });
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
    throw new Error("Expected Clerk test server to listen on a TCP port");
  }

  await withEnvironmentAsync(
    {
      CLERK_API_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      CLERK_SECRET_KEY: "sk_test_fixture",
      JOB_REF: "test-job",
      GITHUB_RUN_ID: "4000",
      GITHUB_RUN_ATTEMPT: "2",
    },
    async () => {
      try {
        await run(requests);
      } finally {
        await closeServer(server);
      }
    },
  );
}

/**
 * Binds and releases a loopback port so the Clerk base URL points at a port
 * nothing listens on. Every connection is then refused before a request byte
 * can be written, which is the failure the create path is allowed to reissue.
 */
async function withUnreachableClerkServer(
  run: () => Promise<void>,
): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string") {
    throw new Error("Expected Clerk test server to listen on a TCP port");
  }

  await withEnvironmentAsync(
    {
      CLERK_API_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      CLERK_SECRET_KEY: "sk_test_fixture",
      JOB_REF: "test-job",
      GITHUB_RUN_ID: "4000",
      GITHUB_RUN_ATTEMPT: "2",
    },
    run,
  );
}

async function observeRequest(
  request: IncomingMessage,
): Promise<ObservedRequest> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", resolve);
    request.on("error", reject);
  });
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body: unknown = bodyText ? JSON.parse(bodyText) : undefined;
  return {
    method: request.method ?? "",
    url: request.url ?? "",
    body,
  };
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
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

function withEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  action: () => void,
): void {
  const previousValues = applyEnvironment(values);
  try {
    action();
  } finally {
    restoreEnvironment(previousValues);
  }
}

async function withEnvironmentAsync(
  values: Readonly<Record<string, string | undefined>>,
  action: () => Promise<void>,
): Promise<void> {
  const previousValues = applyEnvironment(values);
  try {
    await action();
  } finally {
    restoreEnvironment(previousValues);
  }
}

function applyEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const previousValues: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previousValues[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return previousValues;
}

function restoreEnvironment(
  previousValues: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of Object.entries(previousValues)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

function countRequests(
  requests: readonly ObservedRequest[],
  method: string,
  url: string,
): number {
  return requests.filter(
    (request) => request.method === method && request.url === url,
  ).length;
}

async function captureError(action: () => Promise<void>): Promise<Error> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught;
}

function requestSocketFailure(response: ServerResponse): void {
  response.destroy();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
