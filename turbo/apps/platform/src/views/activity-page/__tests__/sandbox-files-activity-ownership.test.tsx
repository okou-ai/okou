import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RunStatus } from "@okouai/api-contracts/contracts/runs";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  applyFeatureSwitches$,
  featureSwitch$,
} from "../../../signals/external/feature-switch.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import {
  FILES_RUN_ID,
  filesButton,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test.each(["queued", "pending"] as const)(
  "Files observes a %s Activity starting without opening another Run",
  async (status) => {
    const fixture = await setupFilesPage(context, { status });
    const panel = await openFiles();
    await expect(
      within(panel).findByText(
        "Files will be available when the queued run starts.",
      ),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(fixture.statusRequests).toHaveLength(1);
    });
    expect(fixture.bootstraps).toHaveLength(0);
    fixture.setStatus("running");
    fireEvent(document, new Event("visibilitychange"));
    await expect(
      within(panel).findByText("workspace"),
    ).resolves.toBeInTheDocument();
    expect(fixture.bootstraps).toStrictEqual([FILES_RUN_ID]);
  },
);

test("Turning Debug off releases the visible Files peer and hides its tab", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  act(() => {
    context.store.set(applyFeatureSwitches$, {
      ...context.store.get(featureSwitch$),
      [FeatureSwitchKey.OkouDebug]: false,
    });
  });
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
    expect(
      queryAllByRoleFast("tab").find((tab) => {
        return tab.textContent?.trim() === "Files";
      }),
    ).toBeUndefined();
    expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  });
  const checked = fixture.statusRequests.length;
  fireEvent(document, new Event("visibilitychange"));
  expect(fixture.statusRequests).toHaveLength(checked);
});

test("Organization change clears the previous owner's Files data and closes its peer", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_files_next", name: "Next workspace" },
      memberships: [{ id: "org_files_next" }],
    });
    clerk.stateChanged();
  });
  await waitFor(() => {
    expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
    expect(panel).not.toBeInTheDocument();
  });
});

test("Status unavailability releases Files until the user retries its existing control", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  fixture.setStatusUnavailable(true);
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(filesButton("Retry", panel)).toBeEnabled();
  });
  expect(within(panel).queryByText("workspace")).toBeNull();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  fixture.setStatusUnavailable(false);
  click(filesButton("Retry", panel));
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  expect(fixture.bootstraps).toStrictEqual([FILES_RUN_ID, FILES_RUN_ID]);
});

test("Concurrent visibility checks share demand and closing Files cancels an outstanding status response", async () => {
  const response = createDeferredPromise<RunStatus>(context.signal);
  let checks = 0;
  const fixture = await setupFilesPage(context, {
    statusHandler: () => {
      return ++checks === 1 ? "running" : response.promise;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => {
    expect(fixture.statusRequests).toHaveLength(2);
  });
  fireEvent(document, new Event("visibilitychange"));
  expect(fixture.statusRequests).toHaveLength(2);
  click(filesButton("Close files", panel));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  response.resolve("running");
  await waitFor(() => {
    expect(fixture.statusResponses).toHaveLength(2);
  });
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps).toHaveLength(1);
});

test("A late status from the previous Activity cannot start a socket for that Run", async () => {
  const response = createDeferredPromise<RunStatus>(context.signal);
  const nextRunId = "d0000000-0000-4000-a000-000000000969";
  const fixture = await setupFilesPage(context, {
    statusHandler: (runId) => {
      return runId === FILES_RUN_ID ? response.promise : "running";
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("Connecting to files…"),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(fixture.statusRequests).toStrictEqual([FILES_RUN_ID]);
  });
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: nextRunId },
    searchParams: new URLSearchParams({ tab: "files" }),
  });
  await expect(screen.findByText("workspace")).resolves.toBeInTheDocument();
  response.resolve("running");
  await waitFor(() => {
    expect(fixture.statusResponses).toContain(FILES_RUN_ID);
  });
  expect(fixture.bootstraps).toStrictEqual([nextRunId]);
  expect(fixture.sockets).toHaveLength(1);
});
