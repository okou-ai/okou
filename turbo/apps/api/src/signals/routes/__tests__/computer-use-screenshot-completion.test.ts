import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { computerUseRoutes } from "../computer-use";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Clerk session of the member's desktop host, as the native app presents it. */
function hostSession(actor: ApiTestUser) {
  const sessionId = `sess_${actor.userId}`;
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { ...actor, sessionId };
    },
  });
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId: actor.userId,
    status: "active",
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          organization: { id: actor.orgId ?? "" },
          publicUserData: { userId: actor.userId },
          role: actor.orgRole ?? "org:member",
        },
      ],
      totalCount: 1,
    },
  );
  return { authorization: "Bearer clerk-session" };
}

describe("Computer Use screenshot completion", () => {
  it("computer-use-screenshot-completion-001 keeps a failed screenshot upload recoverable through an ordinary completion retry", async () => {
    const api = createComputerUseBddApi(context);
    const member = createBddApi(context).user({ orgRole: "org:member" });
    const storage = api.installComputerUseS3Fake();
    const host = await api.startComputerUseHost(member);
    const { commandId } = await api.createComputerUseReadCommand(member, {
      kind: "app.state",
      app: "Safari",
    });
    const claimed = await api.claimNextComputerUseCommand(host.connection);
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: commandId },
    });
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(56, 7)]);
    const completion = {
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: `data:image/png;base64,${png.toString("base64")}`,
        screenshotWidth: 1440,
        screenshotHeight: 900,
      },
    } as const;
    storage.failNextPutObject(new Error("Object storage is unavailable"));

    // The completion contract declares no 500 response, so post it raw.
    const failed = await setupRawAppRequest({
      context,
      routes: computerUseRoutes,
    })(
      `/api/computer-use/hosts/${host.hostId}/commands/${commandId}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...hostSession(member),
        },
        body: JSON.stringify({
          ...completion,
          connectionGeneration: host.connectionGeneration,
        }),
      },
    );
    const pending = await api.readComputerUseCommand(member, commandId);
    const missingScreenshot = await api.requestComputerUseScreenshot(
      member,
      commandId,
      [404],
    );

    expect(failed.status).toBe(500);
    expect(pending).toMatchObject({ status: "running", completedAt: null });
    expect(pending).not.toHaveProperty("result");
    expect(missingScreenshot.status).toBe(404);

    await api.completeComputerUseCommandWith(
      host.connection,
      commandId,
      completion,
    );
    const completed = await api.readComputerUseCommand(member, commandId);
    const download = await api.resolveComputerUseScreenshot(member, commandId);

    expect(completed).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: {
          type: "s3",
          mimeType: "image/png",
          sizeBytes: png.length,
          width: 1440,
          height: 900,
        },
      },
    });
    expect(download).toStrictEqual({
      downloadUrl: expect.stringMatching(/^https:\/\//),
      filename: "screenshot.png",
      contentType: "image/png",
      size: png.length,
      cacheControl: "private, no-store",
    });
  });
});
