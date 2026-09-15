import { seedLegacyMissingDefaultAgentFixture } from "../../../test-fixtures/legacy-default-agent";
import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import {
  createAuthOrgAgentsBddApi,
  type ApiTestUser,
} from "./helpers/api-bdd-auth-org";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { expectApiError } from "./helpers/api-bdd";

/*
ORG-01/02/03, TEAM, and AGENT-02 integration chains:
- Org/member/Slack-connection state is asserted through follow-up
  GET /org, listMembers, listOrgs, Slack connect-status reads, and response
  messages; onboarding state through onboarding status and agents list.
- Boundary-call asserts are kept only where contract-critical: the Clerk
  `updateOrganizationLogo(orgId, {file})` shape, the `updateOrganization`
  call shape and the membership_requests REST call-count 0 for non-admin
  callers (security guarantee).
- Per-route 401 / no-org / sandbox-token-rejection matrices are consolidated:
  one representative per distinct inner-handler statement, plus two
  representative sandbox rejections in the run-scoped token chain.
- A missing billing:read case is not constructible because
  `generateOkouToken` grants that capability unconditionally.
*/

const context = testContext();
const api = createAuthOrgAgentsBddApi(context);
const DEFAULT_AGENT_AVATAR_URL =
  "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg";

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";

  constructor(
    readonly retryAfter: number,
    readonly status = 429,
  ) {
    super(`Clerk Backend API request failed with status ${status}`);
  }
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function slug(prefix: string): string {
  return `${prefix}-${shortId()}`;
}

function orgIdOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected actor to have an organization");
  }
  return actor.orgId;
}

async function onboardAdmin(
  admin: ApiTestUser,
  options: {
    readonly displayName?: string;
    readonly slug?: string;
    readonly name?: string;
  } = {},
): Promise<string> {
  const orgState: { slug?: string; name?: string } = {};
  if (options.slug !== undefined) {
    orgState.slug = options.slug;
  }
  if (options.name !== undefined) {
    orgState.name = options.name;
  }
  api.mockClerkOrg(admin, orgState);
  const bootstrap = await api.bootstrapLimitedFreeOnboarding(admin, {
    displayName: options.displayName ?? "BDD Org Team Agent",
    sound: "calm",
  });
  if (bootstrap.status !== 200) {
    throw new Error(
      `Expected onboarding bootstrap to succeed, got ${bootstrap.status}`,
    );
  }
  return bootstrap.body.agentId;
}

function pngLogoFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], "logo.png", {
    type: "image/png",
  });
}

function logoForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file);
  return form;
}

describe("ORG-00: user-level organization creation count", () => {
  it("counts owned workspaces independently of the active workspace", async () => {
    const actor = api.user();
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          organization: {
            id: orgIdOf(actor),
            createdBy: "other-user",
          },
        },
        {
          organization: {
            id: "org_owned",
            createdBy: actor.userId,
          },
        },
      ],
      totalCount: 2,
    });

    await expect(api.readCreatedOrganizationsCount(actor)).resolves.toBe(1);
  });
});

describe("ORG-01: org logo lifecycle through the Clerk boundary", () => {
  it("serves, uploads, and removes the org logo across auth, validation, and clerk error arms [ORG-LOGO-A]", async () => {
    const admin = api.user();
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const noOrg = api.user({ orgId: null });
    const orgId = orgIdOf(admin);

    // GET happy path + ""→null arm. First test in the file: install the
    // Clerk logo boundary explicitly before any call.
    api.mockClerkOrgLogo("get", {
      imageUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    const logo = await api.requestReadOrgLogo(admin, [200]);
    expect(logo.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledWith({ organizationId: orgId });

    api.mockClerkOrgLogo("get", { imageUrl: "", hasImage: false });
    const clearedLogo = await api.requestReadOrgLogo(admin, [200]);
    expect(clearedLogo.body).toStrictEqual({ logoUrl: null, hasImage: false });

    // GET auth arms.
    const unauthenticatedGet = await api.requestReadOrgLogo(null, [401]);
    expectApiError(unauthenticatedGet.body);
    expect(unauthenticatedGet.body.error.code).toBe("UNAUTHORIZED");
    const noOrgGet = await api.requestReadOrgLogo(noOrg, [404]);
    expect(noOrgGet.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });

    // GET Clerk lookup failures map to the same 404.
    api.mockClerkLogoError("get", "NotFoundError");
    const getNotFound = await api.requestReadOrgLogo(admin, [404]);
    expect(getNotFound.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("get", "BadRequestError");
    const getBadRequest = await api.requestReadOrgLogo(admin, [404]);
    expect(getBadRequest.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });

    // POST happy path asserts the Clerk boundary call shape.
    api.mockClerkOrgLogo("upload", {
      imageUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    const file = pngLogoFile();
    const uploaded = await api.requestUploadOrgLogo(
      admin,
      logoForm(file),
      [200],
    );
    expect(uploaded.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/new-logo.png",
      hasImage: true,
    });
    expect(
      context.mocks.clerk.organizations.updateOrganizationLogo,
    ).toHaveBeenCalledWith(orgId, {
      file: expect.objectContaining({
        name: file.name,
        size: file.size,
        type: file.type,
      }),
    });
    api.mockClerkOrgLogo("upload", { imageUrl: "", hasImage: false });
    const uploadedCleared = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [200],
    );
    expect(uploadedCleared.body).toStrictEqual({
      logoUrl: null,
      hasImage: false,
    });

    // POST auth arms.
    const unauthenticatedPost = await api.requestUploadOrgLogo(
      null,
      logoForm(pngLogoFile()),
      [401],
    );
    expect(unauthenticatedPost.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    const noOrgPost = await api.requestUploadOrgLogo(
      noOrg,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(noOrgPost.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    const memberPost = await api.requestUploadOrgLogo(
      member,
      logoForm(pngLogoFile()),
      [403],
    );
    expect(memberPost.body).toStrictEqual({
      error: {
        message: "Only admins can upload the logo",
        code: "BAD_REQUEST",
      },
    });

    // POST file validation arms.
    const emptyForm = await api.requestUploadOrgLogo(
      admin,
      new FormData(),
      [400],
    );
    expect(emptyForm.body).toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    const stringForm = new FormData();
    stringForm.append("file", "not-a-file");
    const stringField = await api.requestUploadOrgLogo(
      admin,
      stringForm,
      [400],
    );
    expect(stringField.body).toStrictEqual({
      error: { message: "No file provided", code: "BAD_REQUEST" },
    });
    const oversized = new File(
      [new Uint8Array(2 * 1024 * 1024 + 1)],
      "logo.png",
      { type: "image/png" },
    );
    const tooLarge = await api.requestUploadOrgLogo(
      admin,
      logoForm(oversized),
      [400],
    );
    expect(tooLarge.body).toStrictEqual({
      error: { message: "File too large (max 2 MB)", code: "BAD_REQUEST" },
    });
    const textFile = new File(["plain"], "logo.txt", { type: "text/plain" });
    const unsupported = await api.requestUploadOrgLogo(
      admin,
      logoForm(textFile),
      [400],
    );
    expect(unsupported.body).toStrictEqual({
      error: {
        message: "Unsupported file type: text/plain",
        code: "BAD_REQUEST",
      },
    });

    // POST Clerk failures.
    api.mockClerkLogoError("upload", "NotFoundError");
    const postNotFound = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(postNotFound.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("upload", "BadRequestError");
    const postBadRequest = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [404],
    );
    expect(postBadRequest.body).toStrictEqual({
      error: { message: "Org not found", code: "BAD_REQUEST" },
    });
    api.mockClerkLogoError("upload", "ForbiddenError");
    const postForbidden = await api.requestUploadOrgLogo(
      admin,
      logoForm(pngLogoFile()),
      [403],
    );
    expect(postForbidden.body).toStrictEqual({
      error: { message: "Access denied", code: "BAD_REQUEST" },
    });
  });
});

describe("ORG-01: org update and delete error matrix", () => {
  it("maps no-org, legacy slug body, rename, admin-leave, and delete failure arms [ORG-UPDATE-B]", async () => {
    const noOrg = api.user({ orgId: null });
    const noOrgUpdate = await api.requestUpdateOrg(
      noOrg,
      { name: "No Org Rename" },
      [400],
    );
    expectApiError(noOrgUpdate.body);
    expect(noOrgUpdate.body.error.message).toBe(
      "No organization is selected for this request",
    );

    const admin = api.user();
    const baseSlug = slug("bdd-r5-org");
    api.acceptAgentStorageWrites();
    await onboardAdmin(admin, { slug: baseSlug, name: "BDD R5 Org" });
    api.mockClerkOrg(admin, { slug: baseSlug, name: "BDD R5 Org" });

    // An old CLI still sending the removed slug rename body must fail loudly
    // instead of silently succeeding as an empty update.
    context.mocks.clerk.organizations.updateOrganization.mockClear();
    const legacySlugBody = await api.requestRawJson(
      admin,
      "/api/org",
      "PUT",
      { slug: slug("bdd-r5-next"), force: true },
      [400],
    );
    expect(legacySlugBody.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).not.toHaveBeenCalled();
    const unchanged = await api.readOrg(admin);
    expect(unchanged).toMatchObject({ name: "BDD R5 Org" });
    expect(unchanged).not.toHaveProperty("slug");

    // A name update reaches Clerk and returns the refreshed org.
    api.mockClerkOrg(admin, { slug: baseSlug, name: "BDD R5 Org Renamed" });
    const renamed = await api.requestUpdateOrg(
      admin,
      { name: "BDD R5 Org Renamed" },
      [200],
    );
    expect(renamed.body).toMatchObject({
      id: admin.orgId,
      name: "BDD R5 Org Renamed",
    });
    expect(renamed.body).not.toHaveProperty("slug");
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledWith(admin.orgId, { name: "BDD R5 Org Renamed" });

    const adminLeave = await api.requestLeaveOrg(admin, [403]);
    expectApiError(adminLeave.body);
    expect(adminLeave.body.error.message).toBe(
      "Admins cannot leave the organization",
    );

    // Delete failure arms: member caller, CLI PAT caller, a confirmation that
    // is not the literal, and an org whose identity is gone on the Clerk side.
    const memberCaller = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
    });
    const memberDelete = await api.requestDeleteOrg(memberCaller, [403]);
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe(
      "Only admins can delete the organization",
    );

    // Deleting a workspace is session-only. A CLI PAT was the one credential
    // that still reached this route, so an admin's PAT must now be refused
    // before the handler runs.
    const adminCliToken = await api.createCliToken(admin);
    api.mockClerkOrg(admin, { slug: baseSlug, name: "BDD R5 Org" });
    const patDelete = await api.requestDeleteOrgWithBearer(
      adminCliToken.token,
      [403],
    );
    expect(patDelete.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    const wrongConfirm = await api.requestRawJson(
      admin,
      "/api/org/delete",
      "POST",
      { confirm: "delete" },
      [400],
    );
    expect(wrongConfirm.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    const rawDelete = await api.requestRawJson(
      admin,
      "/api/org/delete",
      "POST",
      {},
      [400],
    );
    expect(rawDelete.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const stillThere = await api.readOrg(admin);
    expect(stillThere.name).toBe("BDD R5 Org Renamed");

    const orphanAdmin = api.user();
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue({
      statusCode: 404,
    });
    const missingIdentity = await api.requestDeleteOrg(orphanAdmin, [404]);
    expect(missingIdentity.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("does not retry Clerk mutation failures", async () => {
    const admin = api.user();
    const baseSlug = slug("bdd-r5-org-mutation");
    api.acceptAgentStorageWrites();
    await onboardAdmin(admin, { slug: baseSlug, name: "BDD R5 Org" });
    context.mocks.clerk.organizations.updateOrganization.mockClear();
    context.mocks.clerk.organizations.updateOrganization.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );

    const response = await api.requestUpdateOrg(
      admin,
      { name: "Unavailable Rename" },
      [500],
    );

    expect(response.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.updateOrganization,
    ).toHaveBeenCalledOnce();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
  });
});

describe("ORG-02: membership admin matrix", () => {
  it("retries Clerk 5xx reads and immediately exposes rate limits", async () => {
    const admin = api.user();
    const orgId = orgIdOf(admin);
    api.mockClerkOrg(admin);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);

    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2))
      .mockResolvedValue({
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: admin.userId },
            createdAt: now(),
          },
        ],
      });

    const rateLimited = await api.requestListMembers(admin, [503]);
    expect(rateLimited.headers.get("Retry-After")).toBe("2");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.signalTimers.delay.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(1, 521))
      .mockResolvedValue({
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: admin.userId },
            createdAt: now(),
          },
        ],
      });

    const recoveredUnavailable = await api.requestListMembers(admin, [200]);
    expect(recoveredUnavailable.body.members).toHaveLength(1);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledOnce();
    const [providerWaitMs, providerDelayOptions] =
      context.mocks.signalTimers.delay.mock.calls[0] ?? [];
    expect(providerWaitMs).toBeGreaterThanOrEqual(1000);
    expect(providerWaitMs).toBeLessThanOrEqual(1250);
    expect(providerDelayOptions).toMatchObject({
      signal: expect.any(AbortSignal),
    });

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockReset();
    context.mocks.signalTimers.delay.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );

    const unavailable = await api.requestListMembers(admin, [500]);
    expect(unavailable.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(3);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(2);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ClerkReadUnavailableError",
        message: "Clerk read is temporarily unavailable",
        providerStatus: 521,
      }),
    );

    api.mockClerkOrg(admin);
    context.mocks.signalTimers.delay.mockClear();
    const requests = api.mockClerkMembershipRequestHandlers(orgId, {
      listStatus: 429,
      retryAfterSeconds: 7,
    });
    const exhausted = await api.requestListMembers(admin, [503]);

    expect(exhausted.body).toStrictEqual({
      error: {
        message: "Organization members are temporarily unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(exhausted.headers.get("Retry-After")).toBe("7");
    expect(exhausted.headers.get("Cache-Control")).toBe("no-store");
    expect(requests.listCalls()).toBe(1);
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
  });

  it("does not retry Clerk 4xx or malformed read failures", async () => {
    const admin = api.user();
    api.mockClerkOrg(admin);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 404),
    );

    const response = await api.requestListMembers(admin, [500]);

    expect(response.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledOnce();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();

    api.mockClerkOrg(admin);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockClear();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      { status: 521 },
    );

    const malformed = await api.requestListMembers(admin, [500]);

    expect(malformed.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledOnce();
    expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
  });

  it("stops sibling Clerk work on the first directory rate limit", async () => {
    const admin = api.user();
    api.mockClerkOrg(admin);
    const invitationPage = createDeferredPromise<{
      readonly data: readonly {
        readonly id: string;
        readonly emailAddress: string;
        readonly role: string;
        readonly createdAt: number;
      }[];
    }>(context.signal);
    const retryStarted = createDeferredPromise<void>(context.signal);
    let siblingDelayAborted = false;
    context.mocks.signalTimers.delay.mockImplementation((_ms, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("Expected retry delay to receive an abort signal");
      }
      signal.throwIfAborted();
      const deferred = createDeferredPromise<void>(signal);
      signal.addEventListener(
        "abort",
        () => {
          siblingDelayAborted = true;
        },
        { once: true },
      );
      retryStarted.resolve();
      return deferred.promise;
    });
    context.mocks.clerk.organizations.getOrganization.mockRejectedValueOnce(
      new ClerkApiResponseTestError(1, 521),
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      async () => {
        await retryStarted.promise;
        throw new ClerkApiResponseTestError(1);
      },
    );
    context.mocks.clerk.organizations.getOrganizationInvitationList.mockReturnValueOnce(
      invitationPage.promise,
    );

    const exhausted = await api.requestListMembers(admin, [503]);

    expect(exhausted.headers.get("Retry-After")).toBe("1");
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.mocks.clerk.organizations.getOrganization,
    ).toHaveBeenCalledTimes(1);
    expect(siblingDelayAborted).toBeTruthy();

    invitationPage.resolve({
      data: Array.from({ length: 100 }, (_, index) => {
        return {
          id: `inv_${index}`,
          emailAddress: `pending-${index}@example.com`,
          role: "org:member",
          createdAt: now(),
        };
      }),
    });
    await invitationPage.promise;
    expect(
      context.mocks.clerk.organizations.getOrganizationInvitationList,
    ).toHaveBeenCalledTimes(1);
  });

  it("shares the 5xx retry deadline across organization member reads", async () => {
    const admin = api.user();
    api.mockClerkOrg(admin);
    context.mocks.signalTimers.delay.mockImplementation(() => {
      // Scheduling can resume later than the requested backoff.
      mockNow(now() + 14_500);
      return Promise.resolve();
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(1, 521))
      .mockResolvedValue({
        data: [
          {
            role: "org:admin",
            publicUserData: { userId: admin.userId },
            createdAt: now(),
          },
        ],
      });
    context.mocks.clerk.users.getUserList.mockRejectedValue(
      new ClerkApiResponseTestError(1, 521),
    );

    const exhausted = await api.requestListMembers(admin, [500]);

    expect(exhausted.status).toBe(500);
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).toHaveBeenCalledTimes(2);
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(1);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(1);
    expect(context.mocks.sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ClerkReadUnavailableError",
        providerStatus: 521,
      }),
    );
  });

  it("rejects Clerk member records without required user identifiers", async () => {
    const admin = api.user();
    const orgId = orgIdOf(admin);
    api.mockClerkOrg(admin);

    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValueOnce(
      {
        data: [
          {
            role: "org:admin",
            publicUserData: {},
            createdAt: now(),
          },
        ],
      },
    );
    const missingMemberId = await api.requestListMembers(admin, [500]);
    expect(missingMemberId.status).toBe(500);

    server.use(
      http.get(
        "https://api.clerk.com/v1/organizations/:orgId/membership_requests",
        ({ params }) => {
          if (params.orgId !== orgId) {
            return HttpResponse.json({ data: [] });
          }
          return HttpResponse.json({
            data: [
              {
                id: `request-${shortId()}`,
                public_user_data: {},
                created_at: now(),
              },
            ],
          });
        },
      ),
    );
    const missingRequestUserId = await api.requestListMembers(admin, [500]);
    expect(missingRequestUserId.status).toBe(500);
  });

  it("enforces role, self, unknown-target, invalid-body, and clerk-failure arms across member routes [ORG-MEMBERS-C]", async () => {
    const admin = api.user();
    const orgId = orgIdOf(admin);
    const member = api.user({
      orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const secondAdmin = api.user({
      orgId,
      email: `second-admin-${shortId()}@example.test`,
    });
    const requester = api.user({
      orgId,
      orgRole: "org:member",
      email: `requester-${shortId()}@example.test`,
    });
    const ghostEmail = `ghost-${shortId()}@example.test`;
    api.acceptAgentStorageWrites();
    await onboardAdmin(admin, { slug: slug("bdd-r5-members") });

    const orgMembers = [
      { actor: admin, role: "org:admin" as const },
      { actor: member, role: "org:member" as const },
    ];
    api.mockClerkOrg(admin, { members: orgMembers });

    // updateRole arms.
    const memberRole = await api.requestUpdateMemberRole(
      member,
      { email: admin.email, role: "member" },
      [403],
    );
    expect(memberRole.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const unknownRole = await api.requestUpdateMemberRole(
      admin,
      { email: ghostEmail, role: "admin" },
      [404],
    );
    expect(unknownRole.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const soloDemote = await api.requestUpdateMemberRole(
      admin,
      { email: admin.email, role: "member" },
      [400],
    );
    expect(soloDemote.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: secondAdmin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    const demoted = await api.updateMemberRole(admin, {
      email: admin.email,
      role: "member",
    });
    expect(demoted).toStrictEqual({
      message: `Updated role for ${admin.email}`,
    });
    const invalidRoleBody = await api.requestUpdateMemberRole(
      admin,
      { email: "not-an-email", role: "member" },
      [400],
    );
    expectApiError(invalidRoleBody.body);
    expect(invalidRoleBody.body.error.code).toBe("BAD_REQUEST");

    // removeMember arms.
    const memberRemove = await api.requestRemoveMember(
      member,
      { email: admin.email },
      [403],
    );
    expect(memberRemove.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const unknownRemove = await api.requestRemoveMember(
      admin,
      { email: ghostEmail },
      [404],
    );
    expect(unknownRemove.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const selfRemove = await api.requestRemoveMember(
      admin,
      { email: admin.email },
      [400],
    );
    expect(selfRemove.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    const stranger = api.user({
      email: `stranger-${shortId()}@example.test`,
    });
    api.mockClerkUsers([admin, secondAdmin, member, stranger]);
    const notMember = await api.requestRemoveMember(
      admin,
      { email: stranger.email },
      [404],
    );
    expect(notMember.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
    const invalidRemoveBody = await api.requestRemoveMember(
      admin,
      { email: "not-an-email" },
      [400],
    );
    expectApiError(invalidRemoveBody.body);
    expect(invalidRemoveBody.body.error.code).toBe("BAD_REQUEST");

    // invite arms.
    const memberRevoke = await api.requestRevokeInvitation(
      member,
      `inv_${shortId()}`,
      [403],
    );
    expect(memberRevoke.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const invalidInvite = await api.requestInviteMember(
      admin,
      { email: "not-an-email", role: "member" },
      [400],
    );
    expectApiError(invalidInvite.body);
    expect(invalidInvite.body.error.code).toBe("BAD_REQUEST");
    const rawRevoke = await api.requestRawJson(
      admin,
      "/api/org/invite",
      "DELETE",
      {},
      [400],
    );
    expect(rawRevoke.body).toMatchObject({ error: { code: "BAD_REQUEST" } });

    // membership-request arms with REST call counters: non-admin callers and
    // invalid bodies must never reach the Clerk REST API.
    const requestId = `req_${shortId()}`;
    const failingActions = api.mockClerkMembershipRequestHandlers(orgId, {
      acceptStatus: 404,
      rejectStatus: 404,
    });
    const memberAccept = await api.requestAcceptMembershipRequest(
      member,
      { requestId },
      [403],
    );
    expect(memberAccept.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    const memberReject = await api.requestRejectMembershipRequest(
      member,
      { requestId },
      [403],
    );
    expect(memberReject.body).toStrictEqual({
      error: { message: "Access denied", code: "FORBIDDEN" },
    });
    expect(failingActions.acceptCalls()).toBe(0);
    expect(failingActions.rejectCalls()).toBe(0);

    const failedAccept = await api.requestAcceptMembershipRequest(
      admin,
      { requestId },
      [400],
    );
    expect(failedAccept.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    const failedReject = await api.requestRejectMembershipRequest(
      admin,
      { requestId },
      [400],
    );
    expect(failedReject.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    expect(failingActions.acceptCalls()).toBe(1);
    expect(failingActions.rejectCalls()).toBe(1);

    const rawAccept = await api.requestRawJson(
      admin,
      "/api/org/membership-requests",
      "POST",
      {},
      [400],
    );
    expect(rawAccept.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    const rawReject = await api.requestRawJson(
      admin,
      "/api/org/membership-requests",
      "DELETE",
      {},
      [400],
    );
    expect(rawReject.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(failingActions.acceptCalls()).toBe(1);
    expect(failingActions.rejectCalls()).toBe(1);

    // listMembers tolerates a Clerk org without the membership_requests
    // feature (REST 404 → empty list).
    const inviteId = `inv_${shortId()}`;
    api.mockClerkOrg(admin, {
      members: orgMembers,
      pendingInvitations: [
        { id: inviteId, email: `invitee-${shortId()}@example.test` },
      ],
      membershipRequests: [{ id: requestId, actor: requester }],
    });
    const featureDisabled = api.mockClerkMembershipRequestHandlers(orgId, {
      listStatus: 404,
    });
    const adminList = await api.listMembers(admin);
    expect(adminList.role).toBe("admin");
    expect(adminList.pendingInvitations?.[0]?.id).toBe(inviteId);
    expect(adminList.membershipRequests).toStrictEqual([]);
    expect(featureDisabled.listCalls()).toBe(1);

    // Members never see invitations or membership requests, and the REST
    // membership_requests endpoint is never called for them.
    const memberView = api.mockClerkMembershipRequestHandlers(orgId, {
      requests: [{ id: requestId, actor: requester }],
    });
    const memberList = await api.listMembers(member);
    expect(memberList.role).toBe("member");
    expect(memberList.pendingInvitations).toStrictEqual([]);
    expect(memberList.membershipRequests).toStrictEqual([]);
    expect(memberView.listCalls()).toBe(0);
  });
});

describe("ORG-02: member cleanup detaches Slack connections", () => {
  it("disconnects slack-linked members on leave, removal, and org deletion [ORG-SLACK-D]", async () => {
    const integrations = createBddIntegrationApi(context);
    const admin = api.user();
    const member = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member-${shortId()}@example.test`,
    });
    const secondMember = api.user({
      orgId: admin.orgId,
      orgRole: "org:member",
      email: `member2-${shortId()}@example.test`,
    });
    api.acceptAgentStorageWrites();
    integrations.configureSlackAppMocks();
    await onboardAdmin(admin, { slug: slug("bdd-r5-slack") });
    const install = await integrations.installSlackWorkspace(admin);

    await integrations.connectSlackUser(member, {
      workspaceId: install.teamId,
      slackUserId: `U_LEAVE_${shortId().toUpperCase()}`,
    });
    const connected = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(connected.body).toMatchObject({ isConnected: true });

    api.mockClerkOrg(member, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    await expect(api.leaveOrg(member)).resolves.toStrictEqual({
      message: "Left org",
    });
    const afterLeave = await integrations.requestSlackConnectStatus(
      member,
      [200],
    );
    expect(afterLeave.body).toMatchObject({ isConnected: false });

    await integrations.connectSlackUser(secondMember, {
      workspaceId: install.teamId,
      slackUserId: `U_REMOVE_${shortId().toUpperCase()}`,
    });
    const secondConnected = await integrations.requestSlackConnectStatus(
      secondMember,
      [200],
    );
    expect(secondConnected.body).toMatchObject({ isConnected: true });
    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: secondMember, role: "org:member" },
      ],
    });
    await expect(
      api.removeMember(admin, { email: secondMember.email }),
    ).resolves.toStrictEqual({
      message: `Removed ${secondMember.email} from org`,
    });
    const afterRemove = await integrations.requestSlackConnectStatus(
      secondMember,
      [200],
    );
    expect(afterRemove.body).toMatchObject({ isConnected: false });

    // Deleting an org sweeps every member's Slack connection.
    const secondAdmin = api.user();
    const thirdMember = api.user({
      orgId: secondAdmin.orgId,
      orgRole: "org:member",
      email: `member3-${shortId()}@example.test`,
    });
    const secondInstall = await integrations.installSlackWorkspace(secondAdmin);
    await integrations.connectSlackUser(thirdMember, {
      workspaceId: secondInstall.teamId,
      slackUserId: `U_DELETE_${shortId().toUpperCase()}`,
    });
    const thirdConnected = await integrations.requestSlackConnectStatus(
      thirdMember,
      [200],
    );
    expect(thirdConnected.body).toMatchObject({ isConnected: true });
    api.mockClerkOrg(secondAdmin, {
      slug: slug("bdd-r5-del"),
      members: [
        { actor: secondAdmin, role: "org:admin" },
        { actor: thirdMember, role: "org:member" },
      ],
    });
    await expect(api.deleteOrg(secondAdmin)).resolves.toStrictEqual({
      message: "Organization deleted",
    });
    const afterDelete = await integrations.requestSlackConnectStatus(
      thirdMember,
      [200],
    );
    expect(afterDelete.body).toMatchObject({ isConnected: false });
  });
});

describe("ORG-01/AGENT-02: agent listing and default-agent recovery", () => {
  it("lists org-visible agents only and restores a deleted default agent [TEAM-E]", async () => {
    const unauthenticated = await api.requestListAgents(null, [401]);
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noOrg = api.user({ orgId: null });
    const noOrgAgents = await api.requestListAgents(noOrg, [401]);
    expect(noOrgAgents.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    const crossOrgAdmin = api.user();
    await expect(api.listAgents(crossOrgAdmin)).resolves.toStrictEqual([]);

    const admin = api.user();
    const peerAdmin = api.user({
      orgId: admin.orgId,
      email: `peer-admin-${shortId()}@example.test`,
    });
    api.acceptAgentStorageWrites();
    const defaultAgentId = await onboardAdmin(admin, {
      slug: slug("bdd-r5-team"),
      displayName: "BDD Team Default",
    });

    const listedAgents = await api.listAgents(admin);
    const defaultEntry = listedAgents.find((entry) => {
      return entry.agentId === defaultAgentId;
    });
    expect(defaultEntry).toMatchObject({
      agentId: defaultAgentId,
      ownerId: admin.userId,
      displayName: "Okou",
      description: null,
      sound: "calm",
      avatarUrl: DEFAULT_AGENT_AVATAR_URL,
      visibility: "public",
    });
    // Private agents are visible to their owner only; public agents to the
    // whole org; nothing leaks across orgs.
    const ownPrivate = await api.createAgent(admin, {
      displayName: "BDD Own Private",
      visibility: "private",
    });
    const peerPrivate = await api.createAgent(peerAdmin, {
      displayName: "BDD Peer Private",
      visibility: "private",
    });
    const adminAgentIds = (await api.listAgents(admin)).map((entry) => {
      return entry.agentId;
    });
    expect(adminAgentIds).toContain(defaultAgentId);
    expect(adminAgentIds).toContain(ownPrivate.agentId);
    expect(adminAgentIds).not.toContain(peerPrivate.agentId);
    const peerAgentIds = (await api.listAgents(peerAdmin)).map((entry) => {
      return entry.agentId;
    });
    expect(peerAgentIds).toContain(defaultAgentId);
    expect(peerAgentIds).toContain(peerPrivate.agentId);
    expect(peerAgentIds).not.toContain(ownPrivate.agentId);
    await expect(api.listAgents(crossOrgAdmin)).resolves.toStrictEqual([]);

    // Deleting the default agent clears the FK, then onboarding status lazily
    // restores a usable org default for admins.
    await seedLegacyMissingDefaultAgentFixture(defaultAgentId);
    const restored = await api.readOnboardingStatus(admin);
    expect(restored.defaultAgentId).toBeTruthy();
    expect(restored.defaultAgentId).not.toBe(defaultAgentId);
  });
});

describe("AUTH-02/ORG-01: run-scoped agent tokens on org routes", () => {
  it("serves the org read to a claimed run's agent token and rejects member reads and org writes [ORG-TOKEN-G]", async () => {
    const runs = createRunsApi(context);
    const admin = api.user();
    api.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    await runs.grantProEntitlement(admin);
    await runs.ensureOrgModelProvider(admin);
    const agent = await api.createAgent(admin, {
      displayName: "BDD Org Token Agent",
      visibility: "private",
    });

    const created = await runs.createRun(admin, {
      agentId: agent.agentId,
      prompt: "exercise org reads with the run Okou token",
      modelProvider: "anthropic-api-key",
    });
    await runs.heartbeatRunner(runnerGroup);
    const poll = await runs.pollRunner(runnerGroup);
    expect(poll.body.job?.runId).toBe(created.runId);
    const claim = await runs.claimRunnerJob(created.runId);
    const okouToken = claim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error(
        "Expected claim.platformEnvironment.OKOU_TOKEN to carry the run-scoped Okou token",
      );
    }
    expect(okouToken).toMatch(/^vm0_sandbox_/);

    const orgSlug = slug("bdd-r5-token");
    api.mockClerkOrg(admin, { slug: orgSlug, name: "BDD Token Org" });
    const orgRead = await api.requestReadOrgWithBearer(okouToken, [200]);
    expect(orgRead.body).toMatchObject({
      id: admin.orgId,
      role: "admin",
    });

    // Member listing is deliberately not an agent surface (#25011): the route
    // declares no capability, so a sandbox token is rejected like the writes.
    const membersRejected = await api.requestListMembersWithBearer(
      okouToken,
      [403],
    );
    expect(membersRejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });

    // Representative sandbox-token write rejections (the remaining org
    // routes share the same authRoute statement).
    const updateRejected = await api.requestUpdateOrgWithBearer(
      okouToken,
      { name: "Token Rename" },
      [403],
    );
    expect(updateRejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });
    const logoRejected = await api.requestUploadOrgLogo(
      { bearerToken: okouToken },
      logoForm(pngLogoFile()),
      [403],
    );
    expect(logoRejected.body).toStrictEqual({
      error: {
        message: "This endpoint is not available for sandbox tokens",
        code: "FORBIDDEN",
      },
    });

    await runs.requestCancelRun(admin, created.runId, [200]);
    const cancelled = await runs.readRun(admin, created.runId);
    expect(cancelled.status).toBe("cancelled");
  });
});
