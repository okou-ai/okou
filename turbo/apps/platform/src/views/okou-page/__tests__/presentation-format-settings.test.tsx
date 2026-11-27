import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const enabledFeatures = Object.freeze({
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});
const failedSave = "Could not save your default format. Try again.";

function preferences(
  presentationFormat: UserPreferencesResponse["presentationFormat"],
): UserPreferencesResponse {
  return {
    timezone: "UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: true,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    presentationFormat,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
}

async function openSettings(runtime: TestContext = context) {
  await setupPage({
    context: runtime,
    path: "/?settings=chat",
    featureSwitches: enabledFeatures,
  });
  return screen.findByRole("group", {
    name: "Default presentation format",
  });
}

function formatButton(name: "Web slides" | "PowerPoint", group: HTMLElement) {
  return getAction("button", name, group);
}

test("An unset member default leaves both presentation formats unselected without saving on open", async () => {
  const writes: UpdateUserPreferencesRequest[] = [];
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences(null));
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    writes.push(body);
    return respond(200, { ...preferences(null), ...body });
  });

  const group = await openSettings();
  await screen.findByText(
    "Choose a default for your presentations in this workspace.",
  );
  for (const name of ["Web slides", "PowerPoint"] as const) {
    expect(formatButton(name, group)).toHaveAttribute("aria-pressed", "false");
    expect(formatButton(name, group)).toBeEnabled();
  }
  expect(writes).toStrictEqual([]);
});

test.each([
  ["Web slides", "html"],
  ["PowerPoint", "pptx"],
] as const)(
  "Choosing %s saves only the member's presentation format and displays its confirmation",
  async (label, format) => {
    let saved = preferences(null);
    const writes: UpdateUserPreferencesRequest[] = [];
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, saved);
    });
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      writes.push(body);
      saved = { ...saved, ...body };
      return respond(200, saved);
    });

    const group = await openSettings();
    const choice = formatButton(label, group);
    await waitFor(() => {
      expect(choice).toBeEnabled();
    });
    click(choice);
    await waitFor(() => {
      expect(choice).toHaveAttribute("aria-pressed", "true");
      expect(choice).toBeEnabled();
    });
    expect(writes).toStrictEqual([{ presentationFormat: format }]);
    expect(
      formatButton(label === "Web slides" ? "PowerPoint" : "Web slides", group),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(`Use ${label} unless you request another format.`),
    ).toBeInTheDocument();
  },
);

test("A failed save keeps the confirmed default and permits retry after the pending operation", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let fail = true;
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences("html"));
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond }) => {
      if (fail) {
        started.resolve();
        await release.promise;
        return respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Save unavailable" },
        });
      }
      return respond(200, { ...preferences("html"), ...body });
    },
  );

  try {
    const group = await openSettings();
    const html = formatButton("Web slides", group);
    const pptx = formatButton("PowerPoint", group);
    await waitFor(() => {
      expect(html).toHaveAttribute("aria-pressed", "true");
    });
    click(pptx);
    await started.promise;
    expect(html).toBeDisabled();
    expect(pptx).toBeDisabled();
    expect(html).toHaveAttribute("aria-pressed", "true");
    release.resolve();
    const error = await screen.findByText(failedSave);
    expect(error).toHaveAttribute("role", "alert");
    expect(html).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(pptx).toBeEnabled();
    });

    fail = false;
    click(pptx);
    await waitFor(() => {
      expect(pptx).toHaveAttribute("aria-pressed", "true");
      expect(pptx).toBeEnabled();
    });
  } finally {
    if (!release.settled()) {
      release.resolve();
    }
  }
});

test.each([
  ["omitted", undefined],
  ["unset", null],
  ["different", "html"],
] as const)(
  "A successful HTTP response whose format is %s does not confirm the requested PowerPoint default",
  async (_label, returnedFormat) => {
    context.mocks.api(userPreferencesContract.get, ({ respond }) => {
      return respond(200, preferences("html"));
    });
    context.mocks.api(userPreferencesContract.update, ({ respond }) => {
      return respond(200, preferences(returnedFormat));
    });

    const group = await openSettings();
    const html = formatButton("Web slides", group);
    const pptx = formatButton("PowerPoint", group);
    await waitFor(() => {
      expect(html).toHaveAttribute("aria-pressed", "true");
    });
    click(pptx);
    await expect(screen.findByText(failedSave)).resolves.toHaveAttribute(
      "role",
      "alert",
    );
    expect(html).toHaveAttribute("aria-pressed", "true");
    expect(pptx).toHaveAttribute("aria-pressed", "false");
    expect(pptx).toBeEnabled();
  },
);

test("An unavailable member format is not presented as an unset default", async () => {
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, preferences(undefined));
  });

  const group = await openSettings();
  await screen.findByText(
    "Your presentation format preference is unavailable.",
  );
  for (const name of ["Web slides", "PowerPoint"] as const) {
    expect(formatButton(name, group)).toBeDisabled();
    expect(formatButton(name, group)).toHaveAttribute("aria-pressed", "false");
  }
});

test("A fresh workspace page reads that member's preference rather than the previous confirmed save", async () => {
  let current = preferences(null);
  const originalRuntime = createTestRuntime(context);
  const nextRuntime = createTestRuntime(context);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, current);
  });
  context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
    current = { ...current, ...body };
    return respond(200, current);
  });

  const group = await openSettings(originalRuntime);
  const html = formatButton("Web slides", group);
  await waitFor(() => {
    expect(html).toBeEnabled();
  });
  click(html);
  await waitFor(() => {
    expect(html).toHaveAttribute("aria-pressed", "true");
  });

  originalRuntime.dispose();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  vi.mocked(window.history.forward).mockRestore();
  current = preferences("pptx");
  await setupPage({
    context: nextRuntime,
    path: "/?settings=chat",
    featureSwitches: enabledFeatures,
    auth: {
      user: { id: "second-member", fullName: "Second Member" },
      organization: {
        activeOrg: { id: "org_second", name: "Second workspace" },
        memberships: [{ id: "org_second" }],
      },
    },
  });
  const nextGroup = await screen.findByRole("group", {
    name: "Default presentation format",
  });
  await waitFor(() => {
    expect(formatButton("PowerPoint", nextGroup)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(formatButton("PowerPoint", nextGroup)).toBeEnabled();
  });
  expect(formatButton("Web slides", nextGroup)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
