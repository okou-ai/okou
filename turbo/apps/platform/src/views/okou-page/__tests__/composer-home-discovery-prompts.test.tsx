import { FeatureSwitchKey } from "@okouai/core";
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
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  chatListEvent,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const HOME_PATH = `/agents/${AGENT_ID}/chat`;
const DRAFT = "Help me prepare for our launch.";
const HOME_ENTRIES = [
  {
    label: "People",
    title: "Who are you looking for?",
    instruction: "Find people who match the user's criteria.",
  },
  {
    label: "Information",
    title: "What would you like to research?",
    instruction:
      "Find information and materials relevant to the user's request.",
  },
  {
    label: "General",
    title: "What would you like to find out?",
    instruction: "Answer the user's question through search.",
  },
  {
    label: "Briefs",
    title: "What brief would you like to receive?",
    instruction: "Prepare a brief on the topic specified by the user.",
  },
  {
    label: "Monitor",
    title: "What changes would you like to follow?",
    instruction:
      "Help the user track changes to the specified subject or topic.",
  },
] as const;

type HomeEntry = (typeof HOME_ENTRIES)[number];

function button(name: string, container: ParentNode): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
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

async function setupHomepage(enabled: boolean): Promise<HTMLElement> {
  await setupPage({
    context,
    path: HOME_PATH,
    featureSwitches: { [FeatureSwitchKey.HomeTaskDiscovery]: enabled },
  });
  return await findComposerEditor();
}

async function selectEntry(
  editor: HTMLElement,
  entry: HomeEntry,
): Promise<HTMLElement> {
  const directory = await screen.findByRole("region", {
    name: "Explore what Okou can do",
  });
  click(button(entry.label, directory));

  const ideas = await screen.findByRole("region", {
    name: "Ideas to get started",
  });
  expect(
    within(ideas).getByRole("heading", { level: 3, name: entry.title }),
  ).toBeInTheDocument();
  expect(
    button(`Remove ${entry.label}`, composerCard(editor)),
  ).toBeInTheDocument();
  return ideas;
}

test.each(HOME_ENTRIES)(
  "$label adds exactly its approved instruction only when the user sends",
  async (entry) => {
    const capture = mockTemplateChat();
    const editor = await setupHomepage(true);
    await fill(editor, DRAFT);

    await selectEntry(editor, entry);

    expect(editor.textContent).toBe(DRAFT);
    expect(capture.runPrompts).toStrictEqual([]);
    expect(window.location.pathname).toBe(HOME_PATH);
    expect(button("Send", composerCard(editor))).toBeEnabled();

    click(button("Send", composerCard(editor)));

    await waitFor(() => {
      expect(capture.runPrompts).toStrictEqual([DRAFT]);
    });
    const parts = capture.sentMessages[0]?.parts;
    expect(
      parts?.filter((part) => {
        return part.type === "additional_info";
      }),
    ).toStrictEqual([{ type: "additional_info", text: entry.instruction }]);
    expect(
      parts?.filter((part) => {
        return part.type !== "additional_info";
      }),
    ).toStrictEqual([{ type: "text", text: DRAFT }]);
    await waitFor(() => {
      const message = document.querySelector<HTMLElement>('[data-role="user"]');
      expect(message).toHaveTextContent(DRAFT);
      expect(message).not.toHaveTextContent(entry.instruction);
    });
  },
);

test.each(HOME_ENTRIES)(
  "Removing $label drops its instruction without changing the submitted draft",
  async (entry) => {
    const capture = mockTemplateChat();
    const editor = await setupHomepage(true);
    await fill(editor, DRAFT);
    await selectEntry(editor, entry);

    click(button(`Remove ${entry.label}`, composerCard(editor)));

    await screen.findByRole("region", { name: "Explore what Okou can do" });
    expect(editor.textContent).toBe(DRAFT);
    click(button("Send", composerCard(editor)));

    await waitFor(() => {
      expect(capture.runPrompts).toStrictEqual([DRAFT]);
    });
    expect(capture.sentMessages[0]?.parts).toStrictEqual([
      { type: "text", text: DRAFT },
    ]);
  },
);

test.each([
  { label: "Direct homepage input", enabled: true },
  { label: "The explicitly disabled homepage", enabled: false },
])("$label sends no discovery context", async ({ enabled }) => {
  const capture = mockTemplateChat();
  const editor = await setupHomepage(enabled);
  if (enabled) {
    await screen.findByRole("region", { name: "Explore what Okou can do" });
  } else {
    await screen.findByRole("group", { name: "Choose a task" });
  }
  await fill(editor, DRAFT);

  click(button("Send", composerCard(editor)));

  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([DRAFT]);
  });
  expect(capture.sentMessages[0]?.parts).toStrictEqual([
    { type: "text", text: DRAFT },
  ]);
});

test("An inserted People example keeps its instruction hidden until an explicit Enter submission", async () => {
  const capture = mockTemplateChat();
  context.mocks.data.userPreferences({ sendMode: "enter" });
  const editor = await setupHomepage(true);
  await fill(editor, DRAFT);
  const ideas = await selectEntry(editor, HOME_ENTRIES[0]);
  const example =
    "Find 5 speakers for an AI marketing event, with reasons they fit and public sources";

  click(button(example, ideas));

  const expectedDraft = `${DRAFT}\n${example}`;
  await waitFor(() => {
    expect(editor.textContent).toBe(expectedDraft);
  });
  expect(capture.runPrompts).toStrictEqual([]);
  expect(window.location.pathname).toBe(HOME_PATH);
  click(editor);
  await userEvent.setup({ delay: null }).keyboard("{Enter}");

  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([expectedDraft]);
  });
  const parts = capture.sentMessages[0]?.parts;
  expect(
    parts?.filter((part) => {
      return part.type === "additional_info";
    }),
  ).toStrictEqual([
    { type: "additional_info", text: HOME_ENTRIES[0].instruction },
  ]);
  expect(
    parts?.filter((part) => {
      return part.type !== "additional_info";
    }),
  ).toStrictEqual([{ type: "text", text: expectedDraft }]);
});

test("A homepage instruction combines with Create and Presentation defaults selected through the slash menu", async () => {
  const capture = mockTemplateChat();
  const editor = await setupHomepage(true);
  await fill(editor, DRAFT);
  await selectEntry(editor, HOME_ENTRIES[1]);
  await fill(editor, `${DRAFT} /`);
  const menu = await screen.findByTestId("slash-workflow-menu");
  const user = userEvent.setup({ delay: null });

  await user.click(button("Presentation", menu));

  const picker = await screen.findByRole("dialog");
  click(button("Close", picker));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(
    button("Remove Information", composerCard(editor)),
  ).toBeInTheDocument();
  expect(
    button("Remove Presentation", composerCard(editor)),
  ).toBeInTheDocument();
  const slideCount = screen.getByRole("combobox", { name: "Slide count" });
  click(slideCount);
  click(await screen.findByRole("option", { name: "16–20 slides" }));
  await waitFor(() => {
    expect(slideCount).toHaveTextContent("16–20 slides");
  });
  expect(editor.textContent?.trim()).toBe(DRAFT);
  expect(capture.runPrompts).toStrictEqual([]);
  click(button("Send", composerCard(editor)));

  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([DRAFT]);
  });
  const parts = capture.sentMessages[0]?.parts;
  const additionalInfo = parts?.filter((part) => {
    return part.type === "additional_info";
  });
  expect(additionalInfo).toHaveLength(1);
  expect(additionalInfo?.[0]?.text).toContain("Create a presentation.");
  expect(additionalInfo?.[0]?.text).toContain("- Slide count: 16-20");
  expect(additionalInfo?.[0]?.text).toContain(
    "Where this run's message asks for a different slide count, the message wins.",
  );
  expect(
    additionalInfo?.[0]?.text.split(HOME_ENTRIES[1].instruction),
  ).toHaveLength(2);
  expect(
    parts
      ?.flatMap((part) => {
        return part.type === "text" ? [part.text] : [];
      })
      .join("")
      .trim(),
  ).toBe(DRAFT);
});

test("The conversation composer does not inherit the homepage instruction on a follow-up", async () => {
  let createdThreadId: string | undefined;
  let createdEventId: string | undefined;
  const capture = mockTemplateChat({
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
      createdEventId = body.eventId;
    },
  });
  const stream = installChatListStream(context, { caseId: 58, snapshot: [] });
  const editor = await setupHomepage(true);
  await fill(editor, DRAFT);
  await selectEntry(editor, HOME_ENTRIES[0]);
  click(button("Send", composerCard(editor)));
  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([DRAFT]);
  });
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//);
  });
  if (!createdThreadId || !createdEventId) {
    throw new Error("Expected the new thread's canonical create identifiers");
  }
  stream.setEvents([
    chatListEvent(58, 2, "created", createdThreadId, {
      id: createdEventId,
      agentId: AGENT_ID,
      title: DRAFT,
    }),
  ]);
  context.mocks.ably.trigger("threadListChanged");
  await waitFor(() => {
    expect(document.title).toBe(`${DRAFT} | Okou`);
  });
  capture.lifecycle.completeRun("The launch research is ready.");
  await screen.findByText("The launch research is ready.");
  const threadEditor = await findComposerEditor();
  const followUp = "Expand on the recommendations.";
  await fill(threadEditor, followUp);
  await waitFor(() => {
    expect(button("Send", composerCard(threadEditor))).toBeEnabled();
  });

  click(button("Send", composerCard(threadEditor)));

  await waitFor(() => {
    expect(capture.runPrompts).toStrictEqual([DRAFT, followUp]);
  });
  expect(capture.sentMessages[1]?.parts).toStrictEqual([
    { type: "text", text: followUp },
  ]);
});
