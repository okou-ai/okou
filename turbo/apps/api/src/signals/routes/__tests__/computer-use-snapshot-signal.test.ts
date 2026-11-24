import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { mockEnv } from "../../../lib/env";
import { aroundEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const clock = now();
aroundEach((runTest) => {
  return withMockNowForTest(clock, runTest);
});
const staffOrg = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const switchKey = FeatureSwitchKey.ComputerUseWebRtcSnapshots;
const capabilities = ["app.state", "snapshots.webrtc.v1"] as const;
const capture = {
  kind: "app.state",
  app: "Safari",
  snapshotReceiver: "relay",
} as const;
const offer = [
  "v=0",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=mid:0",
  "a=ice-ufrag:abcd",
  "a=ice-pwd:" + "x".repeat(24),
  "a=setup:actpass",
  "a=sctp-port:5000",
  "a=fingerprint:sha-256 " + "AB:".repeat(31) + "AB",
  "a=candidate:1 1 udp 3000 192.168.1.1 5000 typ host",
  "a=candidate:2 1 udp 2000 8.8.8.8 5000 typ srflx raddr 192.168.1.1 rport 5000",
  "a=candidate:3 1 udp 1000 1.1.1.1 5000 typ relay raddr 192.168.1.1 rport 5000",
].join("\r\n");

describe("Computer Use snapshot signaling", () => {
  it("keeps old peers on ordinary completion and honors a switch change before claim", async () => {
    const scenario = createPublicComputerUseScenario(context);
    await scenario.run(async () => {
      const actor = { ...scenario.user({ orgId: staffOrg }), orgId: staffOrg };
      const api = scenario.computerUse;
      const { connection } = await api.startComputerUseHost(actor, {
        supportedCapabilities: ["app.state"],
      });
      const guest = {
        bearer: (await scenario.launchRun(actor, connection.hostId)).token,
      };
      await updateFeatureSwitchesForUser(context, actor, { [switchKey]: true });
      const oldHost = await api.createComputerUseReadCommand(guest, capture);
      expect(oldHost.snapshotSession).toBeUndefined();
      await api.claimNextComputerUseCommand(connection, capabilities);
      await api.completeComputerUseCommandWith(connection, oldHost.commandId, {
        status: "succeeded",
        result: {},
      });
      const oldCli = await api.createComputerUseReadCommand(guest, {
        kind: "app.state",
        app: "Safari",
      });
      expect(oldCli.snapshotSession).toBeUndefined();
      await api.claimNextComputerUseCommand(connection, capabilities);
      await api.completeComputerUseCommandWith(connection, oldCli.commandId, {
        status: "succeeded",
        result: {},
      });
      const optedIn = await api.createComputerUseReadCommand(guest, capture);
      expect(optedIn.snapshotSession).toBeDefined();
      await updateFeatureSwitchesForUser(context, actor, {
        [switchKey]: false,
      });
      const claim = await api.claimNextComputerUseCommand(
        connection,
        capabilities,
      );
      expect(claim).toMatchObject({
        status: "command",
        command: { id: optedIn.commandId },
      });
      expect(claim).not.toHaveProperty("command.payload.snapshotSession");
      expect(
        (
          await api.requestSnapshotHostSignal(connection, optedIn.commandId, {
            ice: true,
          })
        ).status,
      ).toBe(404);
    });
  }, 60_000);

  it("keeps negotiation off by default and scopes the optional relay and capture key to the authorized peers", async () => {
    mockEnv("COMPUTER_USE_TURN_KEY_ID", "test-key");
    mockEnv("COMPUTER_USE_TURN_API_TOKEN", "test-token");
    let issues = 0;
    server.use(
      http.post(
        "https://rtc.live.cloudflare.com/v1/turn/keys/test-key/credentials/generate-ice-servers",
        async ({ request }) => {
          issues++;
          expect(request.headers.get("Authorization")).toBe(
            "Bearer test-token",
          );
          await expect(request.json()).resolves.toStrictEqual({ ttl: 120 });
          return HttpResponse.json({
            iceServers: [
              {
                urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
                username: "temporary-user",
                credential: "temporary-password",
              },
            ],
          });
        },
      ),
    );
    const scenario = createPublicComputerUseScenario(context);
    await scenario.run(async () => {
      const actor = { ...scenario.user({ orgId: staffOrg }), orgId: staffOrg };
      const mac = await scenario.computerUse.startComputerUseHost(actor, {
        supportedCapabilities: capabilities,
      });
      const host = mac.connection;
      const run = await scenario.launchRun(actor, host.hostId);
      const guest = { bearer: run.token };
      const api = scenario.computerUse;
      const baseline = await api.createComputerUseReadCommand(guest, capture);
      expect(baseline.snapshotSession).toBeUndefined();
      expect(
        (await api.requestSnapshotReceiverSignal(guest, baseline.commandId))
          .status,
      ).toBe(404);
      await api.claimNextComputerUseCommand(host, capabilities);
      await api.completeComputerUseCommandWith(host, baseline.commandId, {
        status: "succeeded",
        result: {},
      });

      await updateFeatureSwitchesForUser(context, actor, { [switchKey]: true });
      const created = await api.createComputerUseReadCommand(guest, capture);
      expect(created.snapshotSession).toBe(
        [run.runId, host.hostId, host.connectionGeneration, "relay"].join("."),
      );
      await expect(
        api.claimNextComputerUseCommand(host, capabilities),
      ).resolves.toMatchObject({
        status: "command",
        command: {
          id: created.commandId,
          payload: { snapshotSession: created.snapshotSession },
        },
      });
      const id = created.commandId;
      expect(issues).toBe(0);
      expect(
        (
          await api.requestSnapshotHostSignal(
            { ...host, connectionGeneration: host.connectionGeneration + 1 },
            id,
            { ice: true },
          )
        ).status,
      ).toBe(409);
      expect((await api.requestSnapshotReceiverSignal(actor, id)).status).toBe(
        403,
      );
      expect(
        (await api.requestSnapshotHostSignal(host, id, { ice: true })).body,
      ).toMatchObject({
        relayOnly: true,
        iceServers: [
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "temporary-user",
            credential: "temporary-password",
          },
        ],
      });
      expect(
        (await api.requestSnapshotHostSignal(host, id, { ice: true })).status,
      ).toBe(404);
      expect(
        (await api.requestSnapshotHostSignal(host, id, { offer })).status,
      ).toBe(200);
      expect(issues).toBe(1);
      const signal = await api.requestSnapshotReceiverSignal(guest, id);
      expect(signal.body).toStrictEqual({
        description: expect.stringContaining("1.1.1.1 5000 typ relay"),
      });
      expect(JSON.stringify(signal.body)).not.toMatch(
        /192\.168|8\.8\.8\.8|iceServers/,
      );
      const answer = offer.replace("actpass", "active");
      expect(
        (
          await api.requestSnapshotReceiverSignal(
            guest,
            id,
            answer + "\r\nm=video 0 RTP/AVP 0",
          )
        ).status,
      ).toBe(404);
      expect(
        (await api.requestSnapshotReceiverSignal(guest, id, answer)).status,
      ).toBe(200);
      expect(
        (
          await api.requestSnapshotReceiverSignal(
            guest,
            id,
            answer.replace("abcd", "efgh"),
          )
        ).status,
      ).toBe(404);
      expect(
        (await api.requestSnapshotHostSignal(host, id, {})).body,
      ).toMatchObject({
        description: expect.stringContaining("a=setup:active"),
      });

      api.installComputerUseS3Fake();
      await api.completeComputerUseCommandWith(host, id, {
        status: "succeeded",
        result: {
          screenshot: "data:image/png;base64,YQ==",
          snapshotKey: Buffer.alloc(32, 1).toString("base64"),
        },
      });
      expect(
        (await api.readComputerUseCommand(guest, id)).result,
      ).toMatchObject({
        screenshot: { type: "s3" },
        snapshotKey: Buffer.alloc(32, 1).toString("base64"),
        snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await updateFeatureSwitchesForUser(context, actor, {
        [switchKey]: false,
      });
      expect((await api.requestSnapshotReceiverSignal(guest, id)).status).toBe(
        404,
      );
      expect(
        (await api.readComputerUseCommand(guest, id)).result,
      ).not.toHaveProperty("snapshotKey");
      expect(
        (await api.resolveComputerUseScreenshot(guest, id)).contentType,
      ).toBe("image/png");
      await scenario.cancelRun(actor, run.runId);
      expect(
        (await api.requestReadComputerUseCommand(guest, id, [403, 404])).status,
      ).not.toBe(200);
    });
  }, 60_000);
});
