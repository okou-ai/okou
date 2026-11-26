import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { slackConnectRoutes } from "../slack-connect";
import { expectApiError, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthOrgBddApi } from "./helpers/api-bdd-auth-org";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

function logoFormData(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  type: string,
): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type }));
  return form;
}

describe("org-team.bdd", () => {
  const context = testContext();

  async function onboardedOrgWithMember(
    api: ReturnType<typeof createAuthOrgBddApi>,
  ): Promise<{
    readonly admin: ApiTestUser;
    readonly member: ApiTestUser;
    readonly orgId: string;
  }> {
    const admin = api.user({ orgRole: "org:admin" });
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await api.bootstrapLimitedFreeOnboarding(admin);
    api.mockClerkOrg(admin, {
      name: "BDD R5 Org",
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
    });
    await api.listMembers(admin);
    return { admin, member, orgId };
  }

  function mockClerkOrgRename(
    admin: ApiTestUser,
    orgId: string,
    onRename: (nextName: string) => void,
  ): void {
    context.mocks.clerk.organizations.updateOrganization.mockImplementation(
      (targetOrgId: unknown, payload: unknown) => {
        const nextName =
          typeof payload === "object" &&
          payload !== null &&
          "name" in payload &&
          typeof payload.name === "string"
            ? payload.name
            : "";
        onRename(nextName);
        return Promise.resolve({
          id: typeof targetOrgId === "string" ? targetOrgId : orgId,
          slug: `bdd-${orgId.slice(-8).toLowerCase()}`,
          name: nextName,
          createdBy: admin.userId,
        });
      },
    );
  }

  it("org-team.bdd-001 counts owned workspaces independently of the active workspace", async () => {
    const api = createAuthOrgBddApi(context);
    const activeOrgId = "org_active_owned_by_other";
    const ownedOrgId = "org_second_owned_by_user";
    const user = api.user({ orgId: activeOrgId, orgRole: "org:member" });
    const otherCreator = api.user({ orgId: activeOrgId, orgRole: "org:admin" });

    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: "org:member",
          organization: {
            id: activeOrgId,
            slug: "active-other",
            name: "Active Other Org",
            createdBy: otherCreator.userId,
          },
          publicUserData: { userId: user.userId },
        },
        {
          role: "org:admin",
          organization: {
            id: ownedOrgId,
            slug: "owned-second",
            name: "Owned Second Org",
            createdBy: user.userId,
          },
          publicUserData: { userId: user.userId },
        },
      ],
    });

    const count = await api.readCreatedOrganizationsCount(user);
    expect(count).toBe(1);
  });

  it("org-team.bdd-002 (1/2) serves the org logo across image, empty, auth, and not-found read arms", async () => {
    const api = createAuthOrgBddApi(context);
    const admin = api.user({ orgRole: "org:admin" });
    const noOrgUser = api.user({ orgId: null });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    let lookedUpOrgId: string | undefined;
    context.mocks.clerk.organizations.getOrganization.mockImplementation(
      (args: unknown) => {
        if (
          typeof args === "object" &&
          args !== null &&
          "organizationId" in args &&
          typeof args.organizationId === "string"
        ) {
          lookedUpOrgId = args.organizationId;
        }
        return Promise.resolve({
          imageUrl: "https://img.clerk.test/org-logo.png",
          hasImage: true,
        });
      },
    );

    const readWithImage = await api.requestReadOrgLogo(admin, [200]);
    expect(readWithImage.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/org-logo.png",
      hasImage: true,
    });
    expect(lookedUpOrgId).toBe(orgId);

    api.mockClerkOrgLogo("get", { imageUrl: "", hasImage: false });
    const readEmpty = await api.requestReadOrgLogo(admin, [200]);
    expect(readEmpty.body).toStrictEqual({ logoUrl: null, hasImage: false });

    const readAnon = await api.requestReadOrgLogo(null, [401]);
    expectApiError(readAnon.body);
    expect(readAnon.body.error.code).toBe("UNAUTHORIZED");

    const readNoOrg = await api.requestReadOrgLogo(noOrgUser, [404]);
    expectApiError(readNoOrg.body);
    expect(readNoOrg.body.error.message).toBe("Org not found");

    api.mockClerkLogoError("get", "NotFoundError");
    const readNotFound = await api.requestReadOrgLogo(admin, [404]);
    expectApiError(readNotFound.body);
    expect(readNotFound.body.error.message).toBe("Org not found");
  });

  it("org-team.bdd-002 (2/2) uploads and clears the org logo across auth, validation, and clerk error arms", async () => {
    const api = createAuthOrgBddApi(context);
    const admin = api.user({ orgRole: "org:admin" });
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const noOrgUser = api.user({ orgId: null });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    let uploadedOrgId: string | undefined;
    let uploadedFile:
      | { readonly name: string; readonly size: number; readonly type: string }
      | undefined;
    const captureLogoUpload = (imageUrl: string, hasImage: boolean) => {
      context.mocks.clerk.organizations.updateOrganizationLogo.mockImplementation(
        (targetOrgId: unknown, payload: unknown) => {
          if (typeof targetOrgId === "string") {
            uploadedOrgId = targetOrgId;
          }
          if (
            typeof payload === "object" &&
            payload !== null &&
            "file" in payload &&
            payload.file instanceof File
          ) {
            uploadedFile = {
              name: payload.file.name,
              size: payload.file.size,
              type: payload.file.type,
            };
          }
          return Promise.resolve({ imageUrl, hasImage });
        },
      );
    };

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    captureLogoUpload("https://img.clerk.test/uploaded.png", true);
    const pngUpload = await api.requestUploadOrgLogo(
      admin,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [200],
    );
    expect(pngUpload.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/uploaded.png",
      hasImage: true,
    });
    expect(uploadedOrgId).toBe(orgId);
    expect(uploadedFile).toStrictEqual({
      name: "brand.png",
      size: pngBytes.byteLength,
      type: "image/png",
    });

    const webpBytes = new Uint8Array([82, 73, 70, 70, 12, 0, 0, 0]);
    captureLogoUpload("https://img.clerk.test/uploaded.webp", true);
    const webpUpload = await api.requestUploadOrgLogo(
      admin,
      logoFormData(webpBytes, "brand.webp", "image/webp"),
      [200],
    );
    expect(webpUpload.body).toStrictEqual({
      logoUrl: "https://img.clerk.test/uploaded.webp",
      hasImage: true,
    });
    expect(uploadedOrgId).toBe(orgId);
    expect(uploadedFile).toStrictEqual({
      name: "brand.webp",
      size: webpBytes.byteLength,
      type: "image/webp",
    });

    captureLogoUpload("", false);
    const clearUpload = await api.requestUploadOrgLogo(
      admin,
      logoFormData(pngBytes, "clear.png", "image/png"),
      [200],
    );
    expect(clearUpload.body).toStrictEqual({ logoUrl: null, hasImage: false });

    const anonUpload = await api.requestUploadOrgLogo(
      null,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [401],
    );
    expectApiError(anonUpload.body);
    expect(anonUpload.body.error.message).toBe("Not authenticated");

    const noOrgUpload = await api.requestUploadOrgLogo(
      noOrgUser,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [404],
    );
    expectApiError(noOrgUpload.body);
    expect(noOrgUpload.body.error.message).toBe("Org not found");

    const memberUpload = await api.requestUploadOrgLogo(
      member,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [403],
    );
    expectApiError(memberUpload.body);
    expect(memberUpload.body.error.message).toBe(
      "Only admins can upload the logo",
    );

    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    const oversizeUpload = await api.requestUploadOrgLogo(
      admin,
      logoFormData(oversized, "huge.png", "image/png"),
      [400],
    );
    expectApiError(oversizeUpload.body);
    expect(oversizeUpload.body.error.message).toBe("File too large (max 2 MB)");

    const textBytes = new Uint8Array([104, 101, 108, 108, 111]);
    const textUpload = await api.requestUploadOrgLogo(
      admin,
      logoFormData(textBytes, "notes.txt", "text/plain"),
      [400],
    );
    expectApiError(textUpload.body);
    expect(textUpload.body.error.message).toBe(
      "Unsupported file type: text/plain",
    );

    api.mockClerkLogoError("upload", "NotFoundError");
    const uploadNotFound = await api.requestUploadOrgLogo(
      admin,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [404],
    );
    expectApiError(uploadNotFound.body);
    expect(uploadNotFound.body.error.message).toBe("Org not found");

    api.mockClerkLogoError("upload", "ForbiddenError");
    const uploadForbidden = await api.requestUploadOrgLogo(
      admin,
      logoFormData(pngBytes, "brand.png", "image/png"),
      [403],
    );
    expectApiError(uploadForbidden.body);
    expect(uploadForbidden.body.error.message).toBe("Access denied");
  });

  it("org-team.bdd-003 (1/2) maps no-org update, admin rename, and admin leave failure arms", async () => {
    const api = createAuthOrgBddApi(context);
    const noOrgUser = api.user({ orgId: null });
    const { admin, orgId } = await onboardedOrgWithMember(api);

    const noOrgUpdate = await api.requestUpdateOrg(
      noOrgUser,
      { name: "No Org Rename" },
      [400],
    );
    expectApiError(noOrgUpdate.body);
    expect(noOrgUpdate.body.error.message).toBe(
      "No organization is selected for this request",
    );

    let updatedClerkName: string | undefined;
    mockClerkOrgRename(admin, orgId, (nextName) => {
      updatedClerkName = nextName;
    });

    const renamed = await api.updateOrg(admin, { name: "BDD R5 Org Renamed" });
    expect(renamed.id).toBe(orgId);
    expect(renamed.name).toBe("BDD R5 Org Renamed");
    expect(updatedClerkName).toBe("BDD R5 Org Renamed");

    const adminLeave = await api.requestLeaveOrg(admin, [403]);
    expectApiError(adminLeave.body);
    expect(adminLeave.body.error.message).toBe(
      "Admins cannot leave the organization",
    );
  });

  it("org-team.bdd-003 (2/2) maps member, CLI token, bad confirmation, and orphaned org delete failure arms", async () => {
    const api = createAuthOrgBddApi(context);
    const { admin, member, orgId } = await onboardedOrgWithMember(api);
    const orphanedAdmin = api.user({ orgRole: "org:admin" });

    mockClerkOrgRename(admin, orgId, () => {
      // Name verified through GET /api/org after rejected delete attempts.
    });
    await api.updateOrg(admin, { name: "BDD R5 Org Renamed" });
    const { token: cliToken } = await api.createCliToken(admin);

    const memberDelete = await api.requestDeleteOrg(member, [403]);
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe(
      "Only admins can delete the organization",
    );

    const cliDelete = await api.requestDeleteOrgWithBearer(cliToken, [403]);
    expectApiError(cliDelete.body);
    expect(cliDelete.body.error.code).toBe("FORBIDDEN");

    const wrongConfirm = await api.requestRawJson(
      admin,
      "/api/org/delete",
      "POST",
      { confirm: "delete" },
      [400],
    );
    expectApiError(wrongConfirm.body);
    expect(wrongConfirm.body.error.code).toBe("BAD_REQUEST");

    const currentOrg = await api.readOrg(admin);
    expect(currentOrg.name).toBe("BDD R5 Org Renamed");

    const notFoundError = new Error("Clerk org missing");
    notFoundError.name = "NotFoundError";
    context.mocks.clerk.organizations.getOrganization.mockRejectedValue(
      notFoundError,
    );
    const orphanedDelete = await api.requestDeleteOrg(orphanedAdmin, [404]);
    expect(orphanedDelete.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });
  });

  it("org-team.bdd-010 enforces role, self, nonmember, and clerk-failure arms across member routes", async () => {
    const api = createAuthOrgBddApi(context);
    const admin = api.user({ orgRole: "org:admin" });
    const member = api.user({ orgId: admin.orgId, orgRole: "org:member" });
    const secondAdmin = api.user({ orgId: admin.orgId, orgRole: "org:admin" });
    const stranger = api.user({ orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected admin orgId");
    }

    await api.bootstrapLimitedFreeOnboarding(admin);
    const pendingInvitation = {
      id: "inv_pending_1",
      email: "invitee@example.test",
      role: "org:member" as const,
    };
    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
      pendingInvitations: [pendingInvitation],
    });
    api.mockClerkUsers([admin, member, secondAdmin, stranger]);

    const counters = api.mockClerkMembershipRequestHandlers(orgId, {
      listStatus: 404,
      acceptStatus: 404,
      rejectStatus: 404,
    });

    const memberRoleUpdate = await api.requestUpdateMemberRole(
      member,
      { email: admin.email, role: "member" },
      [403],
    );
    expectApiError(memberRoleUpdate.body);
    expect(memberRoleUpdate.body.error.message).toBe("Access denied");

    const memberRemove = await api.requestRemoveMember(
      member,
      { email: admin.email },
      [403],
    );
    expectApiError(memberRemove.body);
    expect(memberRemove.body.error.message).toBe("Access denied");

    const memberRevoke = await api.requestRevokeInvitation(
      member,
      pendingInvitation.id,
      [403],
    );
    expectApiError(memberRevoke.body);
    expect(memberRevoke.body.error.message).toBe("Access denied");

    const memberAccept = await api.requestAcceptMembershipRequest(
      member,
      { requestId: "req_1" },
      [403],
    );
    expectApiError(memberAccept.body);
    expect(memberAccept.body.error.message).toBe("Access denied");

    const memberReject = await api.requestRejectMembershipRequest(
      member,
      { requestId: "req_1" },
      [403],
    );
    expectApiError(memberReject.body);
    expect(memberReject.body.error.message).toBe("Access denied");

    expect(counters.acceptCalls()).toBe(0);
    expect(counters.rejectCalls()).toBe(0);

    const soleAdminDemote = await api.requestUpdateMemberRole(
      admin,
      { email: admin.email, role: "member" },
      [400],
    );
    expectApiError(soleAdminDemote.body);
    expect(soleAdminDemote.body.error.message).toBe("Invalid request");

    const selfRemove = await api.requestRemoveMember(
      admin,
      { email: admin.email },
      [400],
    );
    expectApiError(selfRemove.body);
    expect(selfRemove.body.error.message).toBe("Invalid request");

    const strangerRemove = await api.requestRemoveMember(
      admin,
      { email: stranger.email },
      [404],
    );
    expectApiError(strangerRemove.body);
    expect(strangerRemove.body.error.message).toBe("Resource not found");

    const adminAccept = await api.requestAcceptMembershipRequest(
      admin,
      { requestId: "req_missing" },
      [400],
    );
    expectApiError(adminAccept.body);
    expect(adminAccept.body.error.message).toBe("Invalid request");

    const adminReject = await api.requestRejectMembershipRequest(
      admin,
      { requestId: "req_missing" },
      [400],
    );
    expectApiError(adminReject.body);
    expect(adminReject.body.error.message).toBe("Invalid request");

    const adminListing = await api.listMembers(admin);
    expect(adminListing.role).toBe("admin");
    expect(adminListing.pendingInvitations).toStrictEqual([
      expect.objectContaining({
        id: pendingInvitation.id,
        email: pendingInvitation.email,
      }),
    ]);
    expect(adminListing.membershipRequests).toStrictEqual([]);

    const memberListCounters = api.mockClerkMembershipRequestHandlers(orgId, {
      listStatus: 404,
    });
    const memberListing = await api.listMembers(member);
    expect(memberListing.role).toBe("member");
    expect(memberListing.pendingInvitations).toStrictEqual([]);
    expect(memberListing.membershipRequests).toStrictEqual([]);
    expect(memberListCounters.listCalls()).toBe(0);

    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: secondAdmin, role: "org:admin" },
        { actor: member, role: "org:member" },
      ],
      pendingInvitations: [pendingInvitation],
    });
    const demoted = await api.updateMemberRole(admin, {
      email: admin.email,
      role: "member",
    });
    expect(demoted.message).toBe(`Updated role for ${admin.email}`);
  });

  const slackConnectApi = setupApp({ context, routes: slackConnectRoutes })(
    slackConnectContract,
  );

  async function readSlackConnected(actor: ApiTestUser): Promise<boolean> {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const response = await accept(
      slackConnectApi.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    return response.body.isConnected;
  }

  it("org-team.bdd-011 (1/3) disconnects a slack-linked member on org deletion", async () => {
    const api = createAuthOrgBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const slackOrg = createPublicSlackOrgApi(context);
    integrations.configureSlackAppMocks();

    const admin = api.user({ orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected orgId");
    }

    await Promise.all([
      api.bootstrapLimitedFreeOnboarding(admin),
      slackOrg.installForOrg({ orgId, installer: admin }),
    ]);

    await expect(readSlackConnected(admin)).resolves.toBeTruthy();

    api.mockClerkOrg(admin, {
      members: [{ actor: admin, role: "org:admin" }],
    });
    const deleted = await api.deleteOrg(admin);
    expect(deleted.message).toBe("Organization deleted");

    await expect(readSlackConnected(admin)).resolves.toBeFalsy();
  });

  it("org-team.bdd-011 (2/3) disconnects a slack-linked member on admin removal", async () => {
    const api = createAuthOrgBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const slackOrg = createPublicSlackOrgApi(context);
    integrations.configureSlackAppMocks();

    const admin = api.user({ orgRole: "org:admin" });
    const targetAdmin = api.user({ orgId: admin.orgId, orgRole: "org:admin" });
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected orgId");
    }

    await Promise.all([
      api.bootstrapLimitedFreeOnboarding(targetAdmin),
      slackOrg.installForOrg({ orgId, installer: targetAdmin }),
    ]);

    await expect(readSlackConnected(targetAdmin)).resolves.toBeTruthy();

    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: targetAdmin, role: "org:admin" },
      ],
    });
    const removed = await api.removeMember(admin, { email: targetAdmin.email });
    expect(removed.message).toBe(`Removed ${targetAdmin.email} from org`);

    await expect(readSlackConnected(targetAdmin)).resolves.toBeFalsy();
  });

  it("org-team.bdd-011 (3/3) disconnects a slack-linked member on org leave", async () => {
    const api = createAuthOrgBddApi(context);
    const integrations = createBddIntegrationApi(context);
    const slackOrg = createPublicSlackOrgApi(context);
    integrations.configureSlackAppMocks();

    const admin = api.user({ orgRole: "org:admin" });
    const installer = api.user({
      orgId: admin.orgId,
      orgRole: "org:admin",
    });
    const leavingMember: ApiTestUser = { ...installer, orgRole: "org:member" };
    const orgId = admin.orgId;
    if (!orgId) {
      throw new Error("Expected orgId");
    }

    await Promise.all([
      api.bootstrapLimitedFreeOnboarding(installer),
      slackOrg.installForOrg({ orgId, installer }),
    ]);

    await expect(readSlackConnected(leavingMember)).resolves.toBeTruthy();

    api.mockClerkOrg(admin, {
      members: [
        { actor: admin, role: "org:admin" },
        { actor: leavingMember, role: "org:member" },
      ],
    });
    const left = await api.leaveOrg(leavingMember);
    expect(left.message).toBe("Left org");

    await expect(readSlackConnected(leavingMember)).resolves.toBeFalsy();
  });
});
