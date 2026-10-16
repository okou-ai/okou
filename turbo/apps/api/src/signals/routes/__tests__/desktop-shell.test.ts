import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createPublicComputerUseScenario } from "./helpers/public-computer-use-scenario";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";

const context = testContext();
const permission = "00000000-0000-4000-8000-000000000001";
const capabilities = [
  "apps.list",
  "shell.cmd",
  "shell.list",
  "shell.status",
  "shell.close",
  `shell.permission:${permission}`,
] as const;

describe("Desktop Shell command pipeline", () => {
  it(
    "uses the authorized computer, explicit local capabilities and the existing result channel",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        context.mocks.ably.createTokenRequest.mockResolvedValue({
          keyName: "test.key",
          timestamp: 1,
          nonce: "nonce",
          mac: "signed",
          capability: "{}",
        });
        const api = scenario.computerUse;
        const switches = createAuthDeviceSupportApi(context);
        const host = await api.startComputerUseHost(actor, {
          supportedCapabilities: capabilities,
          permissions: { accessibility: false, screenRecording: false },
        });
        await api.requestCreateDesktopShellCommand(
          actor,
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
        await switches.updateFeatureSwitches(actor, { desktopShell: true });
        const run = await scenario.claim(actor, host.hostId);
        const created = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.cmd", command: "pwd", waitMs: 1000, realtime: true },
          [200],
        );
        if (!("commandId" in created.body)) {
          throw new Error("Expected queued Shell operation");
        }
        expect(context.mocks.ably.publish).toHaveBeenCalledWith(
          "commandsChanged",
          null,
        );
        const claimed = await api.claimNextComputerUseCommand(
          host.connection,
          capabilities,
        );
        expect(claimed).toMatchObject({
          status: "command",
          command: {
            id: created.body.commandId,
            hostId: host.hostId,
            kind: "shell.cmd",
            timeoutMs: 16_000,
            payload: {
              command: "pwd",
              waitMs: 1000,
              shellPermissionId: permission,
            },
          },
        });
        // A transport success may report a still-running foreground command.
        await api.completeComputerUseCommandWith(
          host.connection,
          created.body.commandId,
          {
            status: "succeeded",
            result: {
              session: { id: "local-session", commandState: "running" },
              reason: "wait_elapsed",
            },
          },
        );
        const result = await api.readComputerUseCommand(
          { bearer: run.token },
          created.body.commandId,
        );
        expect(result).toMatchObject({
          status: "succeeded",
          result: { session: { commandState: "running" } },
        });
        const queued = await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [200],
        );
        if (!("commandId" in queued.body)) {
          throw new Error("Expected queued observation");
        }
        await switches.updateFeatureSwitches(actor, { desktopShell: false });
        await expect(
          api.readComputerUseCommand(
            { bearer: run.token },
            queued.body.commandId,
          ),
        ).resolves.toMatchObject({
          status: "failed",
          error: { code: "permission_denied" },
        });
        await switches.updateFeatureSwitches(actor, { desktopShell: true });
        await expect(
          api.claimNextComputerUseCommand(host.connection, capabilities),
        ).resolves.toMatchObject({ status: "idle" });
        await switches.updateFeatureSwitches(actor, { desktopShell: false });
        await api.requestCreateDesktopShellCommand(
          { bearer: run.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
      });
    },
  );

  it(
    "never routes shell work to old hosts with empty capabilities or an unbound run",
    { timeout: 30_000 },
    async () => {
      const scenario = createPublicComputerUseScenario(context);
      await scenario.run(async () => {
        const actor = scenario.user();
        const api = scenario.computerUse;
        await createAuthDeviceSupportApi(context).updateFeatureSwitches(actor, {
          desktopShell: true,
        });
        const old = await api.startComputerUseHost(actor, {
          supportedCapabilities: [],
        });
        await api.requestCreateDesktopShellCommand(
          actor,
          { kind: "shell.list", waitMs: 1000 },
          [409],
        );
        await expect(
          api.claimNextComputerUseCommand(old.connection, []),
        ).resolves.toMatchObject({ status: "idle" });
        const unbound = await scenario.claim(actor);
        await api.requestCreateDesktopShellCommand(
          { bearer: unbound.token },
          { kind: "shell.list", waitMs: 1000 },
          [403],
        );
      });
    },
  );
});
