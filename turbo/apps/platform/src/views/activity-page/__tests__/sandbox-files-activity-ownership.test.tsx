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
  filesTab,
  navigationListing,
  openFiles,
  setupFilesPage,
} from "./sandbox-files-test-helpers.ts";

const context = testContext();

test.each(["loading", "unavailable"] as const)(
  "A new Activity starts at home while its status is %s",
  async (status) => {
    const nextRunId = "d0000000-0000-4000-a000-000000000971";
    const response = createDeferredPromise<RunStatus>(context.signal);
    const fixture = await setupFilesPage(context, {
      handler: navigationListing,
      statusHandler: (runId) => {
        return runId === nextRunId ? response.promise : "running";
      },
    });
    const panel = await openFiles();
    await expect(
      within(panel).findByText("home.txt"),
    ).resolves.toBeInTheDocument();
    click(filesButton("Open workspace as current folder", panel));
    await expect(
      within(panel).findByText("workspace.txt"),
    ).resolves.toBeInTheDocument();

    fixture.setStatusUnavailable(status === "unavailable");
    context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
      pathParams: { activityRunId: nextRunId },
      searchParams: new URLSearchParams({ tab: "files" }),
    });
    await expect(
      screen.findByText(
        status === "loading"
          ? "Connecting to files…"
          : "Files are unavailable. Try again.",
      ),
    ).resolves.toBeInTheDocument();
    const nextPanel = screen.getByRole("region", { name: "Files" });
    expect(
      within(nextPanel)
        .getByRole("navigation", { name: "Current folder" })
        .querySelector('[aria-current="location"]'),
    ).toHaveTextContent("user");
    expect(within(nextPanel).queryByText("workspace.txt")).toBeNull();

    response.resolve("running");
    if (status === "unavailable") {
      fixture.setStatusUnavailable(false);
      click(filesButton("Retry", nextPanel));
    }
    await expect(
      within(nextPanel).findByText("home.txt"),
    ).resolves.toBeInTheDocument();
  },
);

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
});

test("Organization change clears the previous owner's Files data and closes its peer", async () => {
  const fixture = await setupFilesPage(context);
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  const clerk = context.mocks.clerk();
  fixture.setStatusUnavailable(true);
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_files_next", name: "Next workspace" },
      memberships: [{ id: "org_files_next" }],
    });
    clerk.stateChanged();
  });
  await expect(
    screen.findByText("Files are unavailable. Try again."),
  ).resolves.toBeInTheDocument();
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(screen.queryByText("workspace")).toBeNull();
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

test("Leaving Files during a foreground status read releases demand despite repeated visibility events", async () => {
  const response = createDeferredPromise<RunStatus>(context.signal);
  const requested = createDeferredPromise<void>(context.signal);
  const returned = createDeferredPromise<void>(context.signal);
  let blockStatus = false;
  const fixture = await setupFilesPage(context, {
    statusHandler: async () => {
      if (!blockStatus) {
        return "running";
      }
      if (!requested.settled()) {
        requested.resolve(undefined);
      }
      const status = await response.promise;
      if (!returned.settled()) {
        returned.resolve(undefined);
      }
      return status;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("workspace"),
  ).resolves.toBeInTheDocument();
  blockStatus = true;
  fireEvent(document, new Event("visibilitychange"));
  await requested.promise;
  fireEvent(document, new Event("visibilitychange"));
  click(filesTab("Steps"));
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });
  response.resolve("running");
  await returned.promise;
  expect(fixture.sockets[0]?.readyState).toBe(WebSocket.CLOSED);
  expect(fixture.bootstraps).toHaveLength(1);
});

test("A late status from the previous Activity cannot start a socket for that Run", async () => {
  const response = createDeferredPromise<RunStatus>(context.signal);
  const requested = createDeferredPromise<void>(context.signal);
  const returned = createDeferredPromise<void>(context.signal);
  const nextRunId = "d0000000-0000-4000-a000-000000000969";
  const fixture = await setupFilesPage(context, {
    statusHandler: async (runId) => {
      if (runId !== FILES_RUN_ID) {
        return "running";
      }
      if (!requested.settled()) {
        requested.resolve(undefined);
      }
      const status = await response.promise;
      if (!returned.settled()) {
        returned.resolve(undefined);
      }
      return status;
    },
  });
  const panel = await openFiles();
  await expect(
    within(panel).findByText("Connecting to files…"),
  ).resolves.toBeInTheDocument();
  await requested.promise;
  context.store.set(detachedNavigateTo$, "/activities/:activityRunId", {
    pathParams: { activityRunId: nextRunId },
    searchParams: new URLSearchParams({ tab: "files" }),
  });
  await expect(screen.findByText("workspace")).resolves.toBeInTheDocument();
  response.resolve("running");
  await returned.promise;
  expect(screen.getByText("workspace")).toBeInTheDocument();
  expect(fixture.bootstraps).toStrictEqual([nextRunId]);
  expect(fixture.sockets).toHaveLength(1);
});
