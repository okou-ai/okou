import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();
const bdd = createBddApi(context);
const desktops = createComputerUseBddApi(context);

describe("Computer Use host session concurrency", () => {
  it("computer-use-host-session-concurrency-001 lets only one of several concurrent claims start a command on a host", async () => {
    const member = bdd.user();
    const host = await desktops.startComputerUseHost(member);
    const first = await desktops.createComputerUseReadCommand(member, {
      kind: "apps.list",
    });
    const second = await desktops.createComputerUseReadCommand(member, {
      kind: "apps.list",
    });

    const claims = await Promise.all([
      desktops.claimNextComputerUseCommand(host.connection),
      desktops.claimNextComputerUseCommand(host.connection),
      desktops.claimNextComputerUseCommand(host.connection),
    ]);

    const started = claims.flatMap((claim) => {
      return claim.status === "command" ? [claim.command.id] : [];
    });
    expect(started).toStrictEqual([first.commandId]);
    await expect(
      desktops.readComputerUseCommand(member, first.commandId),
    ).resolves.toMatchObject({ status: "running" });
    await expect(
      desktops.readComputerUseCommand(member, second.commandId),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("computer-use-host-session-concurrency-003 records exactly one completion when a host reports the same command concurrently", async () => {
    const member = bdd.user();
    const host = await desktops.startComputerUseHost(member);
    const created = await desktops.createComputerUseWriteCommand(member, {
      kind: "app.open",
      app: "Finder",
      timeoutMs: 60_000,
    });
    const claimed = await desktops.claimNextComputerUseCommand(host.connection);
    expect(claimed).toMatchObject({
      status: "command",
      command: { id: created.commandId },
    });

    const body = {
      connectionGeneration: host.connection.connectionGeneration,
      status: "succeeded",
      result: { app: "Finder", opened: true },
    } as const;
    const completions = await Promise.all([
      desktops.requestCompleteComputerUseCommand(
        host.connection,
        created.commandId,
        body,
        [200],
      ),
      desktops.requestCompleteComputerUseCommand(
        host.connection,
        created.commandId,
        body,
        [200],
      ),
    ]);

    expect(
      completions.map((completion) => {
        return completion.status;
      }),
    ).toStrictEqual([200, 200]);
    await expect(
      desktops.readComputerUseCommand(member, created.commandId),
    ).resolves.toMatchObject({ status: "succeeded" });
    const audit = await desktops.listComputerUseAuditEvents(member, {
      commandId: created.commandId,
    });
    expect(audit.auditEvents).toHaveLength(1);
  });
});
