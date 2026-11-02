import {
  paidToolsContract,
  type PaidToolId,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  FeatureSwitchKey,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@okouai/core";
import { jobsContract } from "@okouai/api-contracts/contracts/jobs";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor, tabByText } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const HOME_PATH = `/agents/${AGENT_ID}/chat`;
const PEOPLE_PROMPT =
  "Find 5 speakers for an AI marketing event, with reasons they fit and public sources";

function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
}

function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryButton(name, container);
  if (!result) {
    throw new Error(`Expected button named "${name}"`);
  }
  return result;
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected composer card");
  }
  return card;
}

function directory(): HTMLElement {
  return screen.getByRole("region", { name: "Explore what Okou can do" });
}

async function setupDiscovery(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: HOME_PATH,
    featureSwitches: { [FeatureSwitchKey.HomeTaskDiscovery]: true },
  });
  return await findComposerEditor();
}

async function searchIdeas(title: string): Promise<HTMLElement> {
  const ideas = await screen.findByRole("region", {
    name: "Ideas to get started",
  });
  expect(
    within(ideas).getByRole("heading", { level: 3, name: title }),
  ).toBeInTheDocument();
  return ideas;
}

function mockResearchSources(
  options: {
    readonly updateResponse?: () => Promise<200 | 500>;
    readonly beforeRefresh?: () => Promise<void>;
  } = {},
) {
  let disabledTools: PaidToolId[] = ["web-search", "people-search"];
  let saved = false;
  const updates: { toolId: PaidToolId; disabled: boolean }[] = [];
  context.mocks.api(paidToolsContract.get, async ({ respond }) => {
    if (saved) {
      await options.beforeRefresh?.();
    }
    return respond(200, { disabledTools });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond }) => {
      updates.push({ toolId: params.toolId, disabled: body.disabled });
      if ((await options.updateResponse?.()) === 500) {
        return respond(500, {
          error: {
            message: "Sources temporarily unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      saved = true;
      disabledTools = disabledTools.filter((id) => {
        return id !== params.toolId;
      });
      if (body.disabled) {
        disabledTools.push(params.toolId);
      }
      return respond(200, { toolId: params.toolId, disabled: body.disabled });
    },
  );
  for (const url of [
    "https://data.okou.ai/mcp",
    "https://okou-data-router-staging.vm0.workers.dev/mcp",
  ]) {
    context.mocks.http.post(url, async ({ request }) => {
      const message = (await request.json()) as { id: string | number };
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "web_search",
              inputSchema: { type: "object" },
              _meta: { "ai.okou/data": { family: "web-search" } },
            },
            {
              name: "people_search",
              inputSchema: { type: "object" },
              _meta: { "ai.okou/data": { family: "people-search" } },
            },
          ],
          _meta: {
            "ai.okou/data": {
              families: [
                {
                  id: "web-search",
                  title: { "en-US": "Router web search" },
                  description: { "en-US": "Find current public information." },
                },
                {
                  id: "people-search",
                  title: { "en-US": "Professional profiles" },
                  description: {
                    "en-US": "Find public professional profiles.",
                  },
                },
              ],
            },
          },
        },
      });
    });
  }
  return updates;
}

test("The default-off homepage retains the legacy task entry", async () => {
  mockTemplateChat();
  await setupPage({ context, path: HOME_PATH });
  const tasks = await screen.findByRole("group", { name: "Choose a task" });
  expect(button("Workflow", tasks)).toBeInTheDocument();
  expect(button("Presentation", tasks)).toBeInTheDocument();

  click(button("Presentation", tasks));

  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(templates).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toBeInTheDocument();
});

test("The existing Tasks surface returns keyboard focus to its directory entry", async () => {
  mockTemplateChat();
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  context.mocks.api(proactiveJobsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
  });
  context.mocks.api(jobsContract.list, ({ respond }) => {
    return respond(200, { jobs: [], nextAfter: null });
  });
  await setupPage({
    context,
    path: HOME_PATH,
    featureSwitches: {
      [FeatureSwitchKey.HomeTaskDiscovery]: true,
      [FeatureSwitchKey.ProactiveAgent]: true,
    },
  });
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await waitFor(() => {
    expect(button("Tasks", directory())).toBeInTheDocument();
  });
  click(button("Tasks", directory()));
  await screen.findByText(
    "No tasks in this view. Give Okou a task. It keeps working and comes back when it needs your input or has a result.",
  );
  click(button("All entries"));
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  expect(button("Tasks", directory())).toHaveFocus();
});

test("The enabled homepage exposes Search, Create and Automate as one directory", async () => {
  mockTemplateChat();
  const editor = await setupDiscovery();
  const entries = await screen.findByRole("region", {
    name: "Explore what Okou can do",
  });
  for (const name of ["Search", "Create", "Automate"]) {
    expect(within(entries).getByRole("heading", { name })).toBeInTheDocument();
  }
  for (const name of [
    "Find people",
    "Find information",
    "General search",
    "Image",
    "PPT",
    "Document",
    "Website",
    "Chart",
    "Briefs",
    "Monitor",
    "Workflows",
  ]) {
    expect(button(name, entries)).toBeInTheDocument();
  }
  expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
});

test("Search exploration and All entries preserve the draft and an uploaded attachment", async () => {
  mockTemplateChat();
  context.mocks.upload.success({
    id: "81000000-0000-4000-a000-000000000051",
    filename: "discovery-brief.txt",
    contentType: "text/plain",
    size: 5,
    url: "https://cdn.example.test/discovery-brief.txt",
  });
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await fill(editor, "Keep my research context");
  const input = composerCard(editor).querySelector<HTMLInputElement>(
    'input[type="file"][multiple]',
  );
  if (!input) {
    throw new Error("Expected composer upload input");
  }
  const user = userEvent.setup({ delay: null });
  await user.upload(
    input,
    new File(["brief"], "discovery-brief.txt", { type: "text/plain" }),
  );
  await screen.findByText("discovery-brief.txt");

  for (const [entry, title] of [
    ["Find people", "Who are you looking for?"],
    ["Find information", "What would you like to research?"],
    ["General search", "What would you like to find out?"],
  ] as const) {
    click(button(entry, directory()));

    const ideas = await searchIdeas(title);
    expect(queryAllByRoleFast("button", ideas)).toHaveLength(3);
    expect(
      screen.queryByRole("region", { name: "Explore what Okou can do" }),
    ).toBeNull();
    expect(button("Search sources", composerCard(editor))).toBeInTheDocument();
    expect(editor).toHaveTextContent("Keep my research context");
    expect(screen.getByText("discovery-brief.txt")).toBeInTheDocument();

    click(button("All entries"));

    await screen.findByRole("region", { name: "Explore what Okou can do" });
    expect(button(entry, directory())).toHaveFocus();
    expect(editor).toHaveTextContent("Keep my research context");
    expect(screen.getByText("discovery-brief.txt")).toBeInTheDocument();
    expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
  }
  expect(window.location.pathname).toBe(HOME_PATH);
});

test("PPT opens real Presentation templates and retains its selection while exploring Search", async () => {
  const capture = mockTemplateChat();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0];
  if (!template) {
    throw new Error("Expected a presentation template");
  }
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await fill(editor, "Keep my presentation context");

  click(button("PPT", directory()));

  const templates = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(
    button("Remove Presentation", composerCard(editor)),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Explore what Okou can do" }),
  ).toBeNull();
  expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
  click(button(template.title, templates));
  await waitFor(() => {
    expect(editor).toHaveTextContent(template.title);
  });
  click(screen.getByRole("combobox", { name: "Slide count" }));
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: "Slide count" }),
    ).toHaveTextContent("16–20 slides");
  });

  click(button("All entries"));

  await screen.findByRole("region", { name: "Explore what Okou can do" });
  expect(
    button("Remove Presentation", composerCard(editor)),
  ).toBeInTheDocument();
  click(button("Find information", directory()));

  await searchIdeas("What would you like to research?");
  expect(
    button("Remove Presentation", composerCard(editor)),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toHaveTextContent("16–20 slides");
  expect(button("Search sources", composerCard(editor))).toBeInTheDocument();
  expect(editor).toHaveTextContent("Keep my presentation context");
  expect(editor).toHaveTextContent(template.title);

  click(button("All entries"));

  await screen.findByRole("region", { name: "Explore what Okou can do" });
  expect(
    button("Remove Presentation", composerCard(editor)),
  ).toBeInTheDocument();
  click(button("Send", composerCard(editor)));

  await waitFor(() => {
    expect(capture.selectedTemplates).toContainEqual(
      expect.objectContaining({
        type: "presentation",
        selection: expect.objectContaining({ templateId: template.templateId }),
      }),
    );
  });
  expect(capture.sentMessages[0]?.parts).toContainEqual({
    type: "additional_info",
    text: expect.stringContaining("- Slide count: 16-20"),
  });
});

test("A people example appends to the editor and waits for an explicit send", async () => {
  const capture = mockTemplateChat();
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await fill(editor, "Keep my launch context");
  click(button("Find people", directory()));
  const ideas = await searchIdeas("Who are you looking for?");

  click(button(PEOPLE_PROMPT, ideas));

  const expectedDraft = `Keep my launch context\n${PEOPLE_PROMPT}`;
  await waitFor(() => {
    expect(editor.textContent).toBe(expectedDraft);
  });
  expect(
    screen.queryByRole("region", { name: "Ideas to get started" }),
  ).toBeNull();
  expect(button("All entries")).toBeInTheDocument();
  expect(button("Search sources", composerCard(editor))).toBeInTheDocument();
  expect(button("Send", composerCard(editor))).toBeEnabled();
  expect(window.location.pathname).toBe(HOME_PATH);

  click(button("All entries"));

  await screen.findByRole("region", { name: "Explore what Okou can do" });
  expect(editor.textContent).toBe(expectedDraft);
  click(button("Send", composerCard(editor)));

  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([expectedDraft]);
  });
});

test("Briefs and Monitor offer their own ideas without changing the draft on entry", async () => {
  mockTemplateChat();
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await fill(editor, "Keep my business context");
  click(button("Briefs", directory()));

  const briefs = await searchIdeas("What brief would you like to receive?");
  const briefPrompts = queryAllByRoleFast("button", briefs).map((item) => {
    return item.textContent?.trim();
  });
  expect(briefPrompts).toHaveLength(3);
  expect(editor).toHaveTextContent("Keep my business context");
  expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
  expect(
    screen.queryByRole("region", { name: "Explore what Okou can do" }),
  ).toBeNull();

  click(button("All entries"));

  await screen.findByRole("region", { name: "Explore what Okou can do" });
  click(button("Monitor", directory()));

  const monitor = await searchIdeas("What changes would you like to follow?");
  const monitorButtons = queryAllByRoleFast("button", monitor);
  expect(monitorButtons).toHaveLength(3);
  expect(
    monitorButtons.map((item) => {
      return item.textContent?.trim();
    }),
  ).not.toStrictEqual(briefPrompts);
  expect(editor).toHaveTextContent("Keep my business context");
  expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
  const first = monitorButtons[0];
  const prompt = first?.textContent?.trim();
  if (!first || !prompt) {
    throw new Error("Expected a Monitor example prompt");
  }
  click(first);

  await waitFor(() => {
    expect(editor.textContent).toBe(`Keep my business context\n${prompt}`);
  });
  expect(button("All entries")).toBeInTheDocument();
  expect(window.location.pathname).toBe(HOME_PATH);
});

test("Workflows opens the existing recommendations and Workflow catalog", async () => {
  mockTemplateChat();
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  await fill(editor, "Keep my workflow context");
  click(button("Workflows", directory()));

  const workflows = await screen.findByRole("group", { name: "Workflows" });
  expect(
    button("Start your day with a clear plan", workflows),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "Explore what Okou can do" }),
  ).toBeNull();
  expect(queryButton("Search sources", composerCard(editor))).toBeUndefined();
  click(button("Browse workflows", workflows));

  const picker = await screen.findByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    button("Select workflow template Morning brief", picker),
  ).toBeInTheDocument();
  click(button("Close", picker));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(editor.textContent).toBe("Keep my workflow context");
});

test("Search sources uses catalog families and only an explicit switch saves a preference", async () => {
  mockTemplateChat();
  const updates = mockResearchSources();
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  click(button("Find people", directory()));
  const ideas = await searchIdeas("Who are you looking for?");
  click(button(PEOPLE_PROMPT, ideas));
  await waitFor(() => {
    expect(editor).toHaveTextContent(PEOPLE_PROMPT);
  });
  click(button("Search sources", composerCard(editor)));

  const sources = await screen.findByRole("dialog", { name: "Search sources" });
  const web = await within(sources).findByRole("switch", {
    name: "Web search",
  });
  const profiles = await within(sources).findByRole("switch", {
    name: "Professional profiles",
  });
  await waitFor(() => {
    expect(web).not.toHaveAttribute("aria-disabled", "true");
    expect(profiles).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(web).not.toBeChecked();
  expect(profiles).not.toBeChecked();
  expect(
    within(sources)
      .getAllByRole("switch")
      .map((item) => {
        return item.getAttribute("aria-label");
      }),
  ).toStrictEqual(["Web search", "Professional profiles"]);
  expect(within(sources).queryByRole("combobox", { name: "Model" })).toBeNull();
  click(web);

  await waitFor(() => {
    expect(web).toBeChecked();
    expect(web).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(profiles).not.toBeChecked();
  // This is the public preference request, not a callback invocation count.
  expect(updates).toStrictEqual([{ toolId: "web-search", disabled: false }]);
  expect(editor).toHaveTextContent(PEOPLE_PROMPT);
  expect(window.location.pathname).toBe(HOME_PATH);
});

test("A source save stays pending across disclosure and All entries remounts until confirmed", async () => {
  mockTemplateChat();
  const patchRequested = context.mocks.deferred<void>();
  const releasePatch = context.mocks.deferred<void>();
  const refreshRequested = context.mocks.deferred<void>();
  const releaseRefresh = context.mocks.deferred<void>();
  const updates = mockResearchSources({
    updateResponse: async () => {
      patchRequested.resolve();
      await releasePatch.promise;
      return 200;
    },
    beforeRefresh: async () => {
      refreshRequested.resolve();
      await releaseRefresh.promise;
    },
  });
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  click(button("Find people", directory()));
  await searchIdeas("Who are you looking for?");
  click(button("Search sources", composerCard(editor)));
  const sources = await screen.findByRole("dialog", { name: "Search sources" });
  const profiles = await within(sources).findByRole("switch", {
    name: "Professional profiles",
  });
  await waitFor(() => {
    expect(profiles).not.toHaveAttribute("aria-disabled", "true");
  });
  click(profiles);
  await patchRequested.promise;
  try {
    await within(sources).findByText("Saving…");
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Search sources" }),
      ).toBeNull();
    });
    click(button("Search sources", composerCard(editor)));
    const reopened = await screen.findByRole("dialog", {
      name: "Search sources",
    });
    const pending = await within(reopened).findByRole("switch", {
      name: "Professional profiles",
    });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).not.toBeChecked();
    expect(within(reopened).getByText("Saving…")).toBeInTheDocument();
    click(pending);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Search sources" }),
      ).toBeNull();
    });
    click(button("All entries"));
    await screen.findByRole("region", { name: "Explore what Okou can do" });
    click(button("Find people", directory()));
    await searchIdeas("Who are you looking for?");
    click(button("Search sources", composerCard(editor)));
    const returned = await screen.findByRole("dialog", {
      name: "Search sources",
    });
    const saving = await within(returned).findByRole("switch", {
      name: "Professional profiles",
    });
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(within(returned).getByText("Saving…")).toBeInTheDocument();
    expect(updates).toStrictEqual([
      { toolId: "people-search", disabled: false },
    ]);

    releasePatch.resolve();
    await refreshRequested.promise;
    const web = within(returned).getByRole("switch", { name: "Web search" });
    expect(web).not.toBeChecked();
    expect(web).not.toHaveAttribute("aria-disabled", "true");
    expect(saving).not.toBeChecked();
    expect(saving).toHaveAttribute("aria-disabled", "true");
    expect(within(returned).getByText("Saving…")).toBeInTheDocument();
    releaseRefresh.resolve();
    await waitFor(() => {
      expect(saving).toBeChecked();
      expect(saving).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(within(returned).queryByText("Saving…")).toBeNull();
    expect(updates).toStrictEqual([
      { toolId: "people-search", disabled: false },
    ]);
  } finally {
    if (!releasePatch.settled()) {
      releasePatch.resolve();
    }
    if (!releaseRefresh.settled()) {
      releaseRefresh.resolve();
    }
  }
});

test("A source save rejected while dismissed stays visible on reopen and permits an explicit retry", async () => {
  mockTemplateChat();
  const patchRequested = context.mocks.deferred<void>();
  const releaseFailure = context.mocks.deferred<void>();
  const retryRequested = context.mocks.deferred<void>();
  const releaseRetry = context.mocks.deferred<void>();
  let failed = false;
  const updates = mockResearchSources({
    updateResponse: async () => {
      if (!failed) {
        patchRequested.resolve();
        await releaseFailure.promise;
        failed = true;
        return 500;
      }
      retryRequested.resolve();
      await releaseRetry.promise;
      return 200;
    },
  });
  const editor = await setupDiscovery();
  await screen.findByRole("region", { name: "Explore what Okou can do" });
  click(button("Find people", directory()));
  await searchIdeas("Who are you looking for?");
  click(button("Search sources", composerCard(editor)));
  const sources = await screen.findByRole("dialog", { name: "Search sources" });
  const profiles = await within(sources).findByRole("switch", {
    name: "Professional profiles",
  });
  await waitFor(() => {
    expect(profiles).not.toHaveAttribute("aria-disabled", "true");
  });
  click(profiles);
  await patchRequested.promise;
  try {
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Search sources" }),
      ).toBeNull();
    });
    releaseFailure.resolve();
    await screen.findByText("Sources temporarily unavailable");
    click(button("Search sources", composerCard(editor)));
    const reopened = await screen.findByRole("dialog", {
      name: "Search sources",
    });
    const alert = await within(reopened).findByRole("alert");
    expect(alert).toHaveTextContent("Your change was not saved.");
    const retry = await within(reopened).findByRole("switch", {
      name: "Professional profiles",
    });
    await waitFor(() => {
      expect(retry).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(retry).not.toBeChecked();
    expect(updates).toStrictEqual([
      { toolId: "people-search", disabled: false },
    ]);

    click(retry);
    await retryRequested.promise;
    await within(reopened).findByText("Saving…");
    expect(retry).toHaveAttribute("aria-disabled", "true");
    releaseRetry.resolve();
    await waitFor(() => {
      expect(retry).toBeChecked();
      expect(retry).not.toHaveAttribute("aria-disabled", "true");
    });
    expect(within(reopened).queryByRole("alert")).toBeNull();
    expect(updates).toStrictEqual([
      { toolId: "people-search", disabled: false },
      { toolId: "people-search", disabled: false },
    ]);
  } finally {
    if (!releaseFailure.settled()) {
      releaseFailure.resolve();
    }
    if (!releaseRetry.settled()) {
      releaseRetry.resolve();
    }
  }
});
