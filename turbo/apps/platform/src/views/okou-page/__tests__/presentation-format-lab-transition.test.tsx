import {
  featureSwitchesContract,
  type FeatureSwitchesResponse,
} from "@okouai/api-contracts/contracts/feature-switches";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatComposerHelpers,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const formatKey = FeatureSwitchKey.PresentationOutputFormat;
const setupTitle = "Pick a default format to start";
const ordinaryAuth = Object.freeze({
  user: Object.freeze({
    id: "presentation-transition-ordinary-user",
    fullName: "Format Tester",
    email: "format-tester@example.test",
  }),
  organization: Object.freeze({
    activeOrg: Object.freeze({
      id: "org_format_transition",
      name: "Format Test Workspace",
    }),
    memberships: [{ id: "org_format_transition" }],
  }),
});

function button(name: string, container: ParentNode = document.body) {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!result) {
    throw new Error(`Expected button ${name}`);
  }
  return result;
}

/** The Settings pair of format toggles, and which one is pressed. */
async function settingsFormats(settings: HTMLElement) {
  const group = await within(settings).findByRole("group", {
    name: "Default presentation format",
  });
  return {
    html: button("Web slides", group),
    pptx: button("PowerPoint", group),
  };
}

function expectPressed(
  formats: { readonly html: HTMLElement; readonly pptx: HTMLElement },
  format: "html" | "pptx",
) {
  expect(formats.html).toHaveAttribute(
    "aria-pressed",
    String(format === "html"),
  );
  expect(formats.pptx).toHaveAttribute(
    "aria-pressed",
    String(format === "pptx"),
  );
}

function formatSwitch() {
  const row = screen.getByText("Presentation output format").closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Presentation output format Lab row not found");
  }
  return within(row).getByRole("switch");
}

function homeLink() {
  const result = queryAllByRoleFast("link").find((candidate) => {
    return (
      candidate.getAttribute("href") === "/" &&
      candidate.getAttribute("aria-label") === "Okou"
    );
  });
  if (!result) {
    throw new Error("Okou home link not found");
  }
  return result;
}

function mockServer({
  format = null,
  initiallyEnabled = false,
  omitEffectiveFormat = false,
  formatAfterReenable,
  preferenceWriteGate,
}: {
  readonly format?: "html" | "pptx" | null;
  readonly initiallyEnabled?: boolean;
  readonly omitEffectiveFormat?: boolean;
  readonly formatAfterReenable?: "html" | "pptx";
  readonly preferenceWriteGate?: Promise<void>;
} = {}) {
  let switches: Record<string, boolean> = initiallyEnabled
    ? { [formatKey]: true }
    : {};
  let storedFormat = format;
  let disabledSinceBoot = false;
  let stored: UserPreferencesResponse = {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: "enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: false,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  const preferenceReads: UserPreferencesResponse[] = [];
  const preferenceWrites: UpdateUserPreferencesRequest[] = [];
  const featureReads: FeatureSwitchesResponse[] = [];

  function featureResponse(): FeatureSwitchesResponse {
    return {
      switches: { ...switches },
      effectiveSwitches: {
        [FeatureSwitchKey.Lab]: true,
        ...(!omitEffectiveFormat && {
          [formatKey]: switches[formatKey] ?? false,
        }),
      },
    };
  }

  function preferences(): UserPreferencesResponse {
    const response = { ...stored };
    if (switches[formatKey]) {
      response.presentationFormat = storedFormat;
    } else {
      delete response.presentationFormat;
    }
    return response;
  }

  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    const response = featureResponse();
    featureReads.push(response);
    return respond(200, response);
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    if (body.switches[formatKey] === false) {
      disabledSinceBoot = true;
    }
    if (
      body.switches[formatKey] === true &&
      disabledSinceBoot &&
      formatAfterReenable !== undefined
    ) {
      // Another client changed the stored default while this page was opted out.
      storedFormat = formatAfterReenable;
    }
    return respond(200, featureResponse());
  });
  context.mocks.api(featureSwitchesContract.delete, ({ respond }) => {
    switches = {};
    return respond(200, { deleted: true });
  });
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    const response = preferences();
    preferenceReads.push(response);
    return respond(200, response);
  });
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      preferenceWrites.push(body);
      if (preferenceWriteGate) {
        await withSignal(preferenceWriteGate);
      }
      stored = { ...stored, ...body };
      if (body.presentationFormat !== undefined) {
        storedFormat = body.presentationFormat;
      }
      return respond(200, preferences());
    },
  );
  return { preferenceReads, preferenceWrites, featureReads };
}

function mockSubmission() {
  const { mockPersonalModelRoutes, mockBillingCapabilities } =
    createChatComposerHelpers(context);
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  const threads: (string | undefined)[] = [];
  const inputs: string[] = [];
  const runs: string[] = [];
  const messages: UserMessageDocument[] = [];
  mockChatLifecycle(context, {
    selectedModel: "claude-sonnet-5",
    onThreadCreate(body) {
      threads.push(body.clientThreadId);
    },
    onSendRequest(body) {
      inputs.push(body.prompt);
    },
    onRunCreate(body) {
      runs.push(body.prompt ?? "");
      if (body.userMessage) {
        messages.push(body.userMessage);
      }
    },
  });
  return { threads, inputs, runs, messages };
}

function observedHttp(server: ReturnType<typeof mockServer>) {
  return {
    preferenceGetCount: server.preferenceReads.length,
    preferenceReads: server.preferenceReads,
    featureReads: server.featureReads,
  };
}

async function toggleFormat(
  enabled: boolean,
  server: ReturnType<typeof mockServer>,
) {
  const control = formatSwitch();
  expect(control).toHaveAttribute("aria-checked", String(!enabled));
  const user = userEvent.setup({ delay: null });
  await user.click(control);
  await waitFor(() => {
    expect(server.featureReads.at(-1)?.effectiveSwitches[formatKey]).toBe(
      enabled,
    );
    expect(formatSwitch()).toHaveAttribute("aria-checked", String(enabled));
    expect(formatSwitch()).toBeEnabled();
    expect(formatSwitch()).not.toHaveAttribute("aria-disabled", "true");
  });
}

async function submitPresentation(prompt: string) {
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(button("Presentation", discovery));
  await screen.findByRole("combobox", { name: "Slide count" });
  await fill(await findComposerEditor(), prompt);
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
}

async function expectSubmitted(
  submission: ReturnType<typeof mockSubmission>,
  server: ReturnType<typeof mockServer>,
  prompt: string,
) {
  await waitFor(
    () => {
      expect(submission.inputs).toStrictEqual([prompt]);
      expect(window.location.pathname).toMatch(/^\/chats\//u);
    },
    {
      onTimeout(error) {
        return new Error(
          `${error.message}\nHTTP fixture evidence: ${JSON.stringify(observedHttp(server))}`,
          { cause: error },
        );
      },
    },
  );
  await expect(screen.findByText(prompt)).resolves.toBeInTheDocument();
  expect(submission.runs).toStrictEqual([prompt]);
  expect(screen.queryByRole("menu", { name: setupTitle })).toBeNull();
}

async function optInAndSubmit(format: "pptx" | null) {
  const server = mockServer({ format });
  const submission = mockSubmission();
  await setupPage({ context, path: "/_/lab", auth: ordinaryAuth });
  await screen.findByRole("heading", { name: "Lab" });
  expect(formatSwitch()).toHaveAttribute("aria-checked", "false");
  expect(server.preferenceReads.length).toBeGreaterThan(0);
  for (const response of server.preferenceReads) {
    expect(response).not.toHaveProperty("presentationFormat");
  }

  await toggleFormat(true, server);
  click(homeLink());
  const prompt = "Prepare the launch briefing after opting in";
  await submitPresentation(prompt);
  return { server, submission, prompt };
}

test("Lab opt-in refreshes cached OFF preferences before a tagged send with no server default", async () => {
  const { server, submission } = await optInAndSubmit(null);
  const menu = await screen.findByRole(
    "menu",
    { name: setupTitle },
    {
      onTimeout(error) {
        return new Error(
          `${error.message}\nHTTP fixture evidence: ${JSON.stringify(observedHttp(server))}`,
          {
            cause: error,
          },
        );
      },
    },
  );
  expect(queryAllByRoleFast("menuitem", menu)).toHaveLength(2);
  expect(submission.threads).toStrictEqual([]);
  expect(submission.inputs).toStrictEqual([]);
  expect(submission.runs).toStrictEqual([]);
  expect(server.preferenceWrites).toStrictEqual([]);
  expect(server.preferenceReads).toContainEqual(
    expect.objectContaining({ presentationFormat: null }),
  );
});

test("Lab opt-in refreshes cached OFF preferences before a tagged send with server default PPTX", async () => {
  const { server, submission, prompt } = await optInAndSubmit("pptx");
  await expectSubmitted(submission, server, prompt);
  expect(submission.messages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
  expect(server.preferenceWrites).toStrictEqual([]);
  expect(server.preferenceReads).toContainEqual(
    expect.objectContaining({ presentationFormat: "pptx" }),
  );
});

test("A confirmed local save does not override a fresh server default after OFF then ON", async () => {
  const server = mockServer({
    format: "html",
    initiallyEnabled: true,
    formatAfterReenable: "html",
  });
  const submission = mockSubmission();
  await setupPage({
    context,
    path: "/_/lab?settings=chat",
    auth: ordinaryAuth,
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const formats = await settingsFormats(settings);
  await waitFor(() => {
    expect(formats.pptx).toBeEnabled();
    expectPressed(formats, "html");
  });
  click(formats.pptx);
  await waitFor(() => {
    expect(formats.pptx).toBeEnabled();
    expectPressed(formats, "pptx");
  });
  expect(server.preferenceWrites).toStrictEqual([
    { presentationFormat: "pptx" },
  ]);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  await screen.findByRole("heading", { name: "Lab" });
  await toggleFormat(false, server);
  await toggleFormat(true, server);
  click(homeLink());
  const prompt = "Use the newly stored default for this briefing";
  await submitPresentation(prompt);
  await expectSubmitted(submission, server, prompt);
  expect(submission.messages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: HTML format"),
  });
  expect(server.preferenceWrites).toStrictEqual([
    { presentationFormat: "pptx" },
  ]);
});

test("A format save crossing an OFF then ON baseline refresh uses the committed default", async () => {
  const releaseSave = context.mocks.deferred<void>();
  const server = mockServer({
    format: "html",
    initiallyEnabled: true,
    preferenceWriteGate: releaseSave.promise,
  });
  const submission = mockSubmission();
  await setupPage({
    context,
    path: "/_/lab?settings=chat",
    auth: ordinaryAuth,
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  const formats = await settingsFormats(settings);
  await waitFor(() => {
    expect(formats.pptx).toBeEnabled();
    expectPressed(formats, "html");
  });
  click(formats.pptx);
  await waitFor(() => {
    expect(server.preferenceWrites).toStrictEqual([
      { presentationFormat: "pptx" },
    ]);
    expect(formats.pptx).toBeDisabled();
  });
  expectPressed(formats, "html");

  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  await screen.findByRole("heading", { name: "Lab" });
  await toggleFormat(false, server);
  const readsBeforeReenable = server.preferenceReads.length;
  await toggleFormat(true, server);

  const rail = await screen.findByTestId("labeled-nav-rail");
  click(within(rail).getByLabelText("Format Tester"));
  const accountMenu = await screen.findByRole("menu");
  click(within(accountMenu).getByText("Settings"));
  const reopened = await screen.findByRole("dialog", { name: "Settings" });
  click(button("Chat", reopened));
  const refreshed = await settingsFormats(reopened);
  await waitFor(() => {
    expect(server.preferenceReads.slice(readsBeforeReenable)).toContainEqual(
      expect.objectContaining({ presentationFormat: "html" }),
    );
    expect(refreshed.pptx).toBeEnabled();
    expectPressed(refreshed, "html");
  });

  // The refresh has read pre-commit HTML; only now let the original POST commit.
  releaseSave.resolve();
  await waitFor(() => {
    expect(refreshed.pptx).toBeEnabled();
    expectPressed(refreshed, "pptx");
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
  click(homeLink());
  const prompt = "Use the format committed after the Lab baseline refresh";
  await submitPresentation(prompt);
  await expectSubmitted(submission, server, prompt);
  expect(submission.messages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Output format: PPTX format"),
  });
  expect(server.preferenceWrites).toStrictEqual([
    { presentationFormat: "pptx" },
  ]);
});

test.each([false, true])(
  "Owner email alone cannot enable format setup when the API format key is missing: %s",
  async (omitEffectiveFormat) => {
    const server = mockServer({ omitEffectiveFormat });
    const submission = mockSubmission();
    await setupPage({
      context,
      path: "/",
      auth: {
        ...ordinaryAuth,
        user: { ...ordinaryAuth.user, email: "bingjie@okou.ai" },
      },
    });
    const prompt = "Create a presentation without the backend format feature";
    await submitPresentation(prompt);
    await expectSubmitted(submission, server, prompt);
    expect(submission.messages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("Create a presentation."),
    });
    expect(server.preferenceWrites).toStrictEqual([]);
    expect(server.featureReads[0]?.switches).not.toHaveProperty(formatKey);
    for (const response of server.preferenceReads) {
      expect(response).not.toHaveProperty("presentationFormat");
    }
  },
);
