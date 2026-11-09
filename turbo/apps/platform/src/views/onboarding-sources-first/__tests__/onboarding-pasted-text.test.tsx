import type {
  PersistedAttachment,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import {
  marketingHandoffsContract,
  type MarketingHandoffFile,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  MARKETING_HANDOFF_MAX_FILE_BYTES,
  MARKETING_HANDOFF_MAX_FILES,
  MARKETING_HANDOFF_PROMPT_MAX_CHARS,
} from "@okouai/api-contracts/validators/marketing-handoffs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { HttpResponse } from "msw";
import deDECommonUrl from "../../../i18n/locales/de-DE/common.json?url";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { mockChatLifecycle } from "../../okou-page/__tests__/chat-test-helpers.ts";

const context = testContext();
const TASK = "What is 1 + 2? Reply with only the number.";
const ORIGINAL_HASH = "a".repeat(12);
const EDITED_HASH = "b".repeat(12);
const FIRST_FILENAME = "Pasted text-1.txt";
const SECOND_FILENAME = "Pasted text-2.txt";
const DOCUMENT =
  "Create a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.";

function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!element) {
    throw new Error(`Expected button named "${name}"`);
  }
  return element;
}

function clipboard(text: string, files: readonly File[] = []): DataTransfer {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  for (const file of files) {
    transfer.items.add(file);
  }
  return transfer;
}

function uploadedFile(
  filename: string,
  text: string,
  hash = "c",
): MarketingHandoffFile {
  return {
    filename,
    hash: hash.repeat(64),
    contentType: "text/plain",
    size: new Blob([text]).size,
  };
}

function uploadText(data: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(data), (character) => {
      return character.charCodeAt(0);
    }),
  );
}

async function openPrompt({
  prompt = TASK,
  files = [],
  legacy = false,
  mobile = false,
  host,
}: {
  readonly prompt?: string;
  readonly files?: MarketingHandoffFile[];
  readonly legacy?: boolean;
  readonly mobile?: boolean;
  readonly host?: string;
} = {}): Promise<HTMLTextAreaElement> {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  if (mobile) {
    context.mocks.browser.matchMedia((query) => {
      return query === "(width < 640px)";
    });
  }
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(200, { version: 1, prompt, files, options: {} });
  });
  await setupPage({
    context,
    path: legacy
      ? `/onboarding?prompt=${encodeURIComponent(prompt)}`
      : `/onboarding?handoff=${ORIGINAL_HASH}`,
    locale: "en-US",
    host,
  });
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error("Expected the onboarding prompt textarea");
  }
  return input;
}

function captureSavedHandoff(): { manifests: MarketingHandoffManifest[] } {
  const manifests: MarketingHandoffManifest[] = [];
  context.mocks.api(marketingHandoffsContract.create, ({ body, respond }) => {
    manifests.push(body);
    return respond(200, { hash: "b".repeat(64), shortHash: EDITED_HASH });
  });
  context.mocks.api(onboardingCompleteContract.complete, async ({ never }) => {
    return await never();
  });
  return { manifests };
}

test.each(["a".repeat(10_000), "😀".repeat(5000)])(
  "A paste at the UTF-16 threshold stays editable text",
  async (text) => {
    const user = userEvent.setup({ delay: null });
    const input = await openPrompt();
    await fill(input, "Keep this draft. ");
    expect(input).toHaveValue("Keep this draft. ");

    await user.paste(clipboard(text));

    expect(input).toHaveValue(`Keep this draft. ${text}`);
    expect(button("Next")).toBeEnabled();
    expect(
      screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
    ).not.toBeInTheDocument();
  },
);

test.each([false, true])(
  "Oversized Unicode pastes keep the selected draft and save only current attachments (legacy: %s)",
  async (legacy) => {
    const user = userEvent.setup({ delay: null });
    const text = `\n\t${"😀".repeat(5000)} \r\n`;
    const original = uploadedFile("original.txt", "Original notes", "d");
    const uploaded = uploadedFile(FIRST_FILENAME, text);
    let received:
      { filename: string; contentType: string; text: string } | undefined;
    context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
      received = {
        filename: body.filename,
        contentType: body.contentType,
        text: uploadText(body.data),
      };
      return respond(200, uploaded);
    });
    const capture = captureSavedHandoff();
    const input = await openPrompt({ legacy, files: legacy ? [] : [original] });
    expect(input).toHaveValue(TASK);
    if (!legacy) {
      click(button("Remove original.txt"));
    }
    expect(screen.queryByText("original.txt")).not.toBeInTheDocument();
    await user.click(input);
    await user.keyboard("{Control>}a{/Control}");

    await user.paste(clipboard(text));

    await waitFor(() => {
      expect(button("Next")).toBeEnabled();
      expect(screen.getByText(FIRST_FILENAME)).toBeInTheDocument();
    });
    expect(input).toHaveValue(TASK);
    expect(received).toStrictEqual({
      filename: FIRST_FILENAME,
      contentType: "text/plain",
      text,
    });
    click(button("Next"));

    await waitFor(() => {
      expect(new URLSearchParams(search()).get("handoff")).toBe(EDITED_HASH);
    });
    expect(capture.manifests).toStrictEqual([
      { version: 1, prompt: TASK, files: [uploaded], options: {} },
    ]);
    expect(new URLSearchParams(search()).has("prompt")).toBeFalsy();
  },
);

test("A 25,000-character paste reaches the first task as a private attachment after onboarding", async () => {
  const user = userEvent.setup({ delay: null });
  const text = "a".repeat(25_000);
  const uploaded = uploadedFile(FIRST_FILENAME, text);
  const importedFileId = "bc3125d1-dc3f-4422-955c-f69f1d077608";
  const manifests = new Map<string, MarketingHandoffManifest>([
    [ORIGINAL_HASH, { version: 1, prompt: TASK, files: [], options: {} }],
  ]);
  const importedFiles = new Map<string, PersistedAttachment>();
  let receivedUpload:
    { filename: string; contentType: string; text: string } | undefined;
  let importedHash: string | undefined;
  let sentRequest:
    | {
        readonly prompt: string;
        readonly threadId?: string;
        readonly userMessage?: UserMessageDocument;
      }
    | undefined;
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.api(
    marketingHandoffsContract.resolve,
    ({ params, respond }) => {
      const manifest = manifests.get(params.hash);
      return manifest
        ? respond(200, manifest)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Handoff not found" },
          });
    },
  );
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    const decoded = uploadText(body.data);
    receivedUpload = {
      filename: body.filename,
      contentType: body.contentType,
      text: decoded,
    };
    return respond(200, uploadedFile(body.filename, decoded));
  });
  context.mocks.api(marketingHandoffsContract.create, ({ body, respond }) => {
    manifests.set(EDITED_HASH, body);
    return respond(200, { hash: "b".repeat(64), shortHash: EDITED_HASH });
  });
  context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    return respond(200, { needsOnboarding: false, onboardingComplete: true });
  });
  context.mocks.api(marketingHandoffsContract.import, ({ params, respond }) => {
    const manifest = manifests.get(params.hash);
    if (!manifest) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Handoff not found" },
      });
    }
    importedHash = params.hash;
    const files = manifest.files.map((file): PersistedAttachment => {
      const imported = {
        id: importedFileId,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        url: "https://app.okou.ai/artifacts/abcdefgh12.txt",
      };
      importedFiles.set(imported.id, imported);
      return imported;
    });
    return respond(200, { files });
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    const file = importedFiles.get(query.file_id);
    if (!file) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "File not found" },
      });
    }
    const url = `https://storage.example.test/onboarding/${file.id}.txt`;
    return respond(200, {
      url,
      downloadUrl: `${url}?download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      publicUrl: null,
    });
  });
  mockChatLifecycle(context, {
    onSendRequest: (body) => {
      sentRequest = body;
    },
  });
  await setupPage({
    context,
    path: `/onboarding?handoff=${ORIGINAL_HASH}`,
    locale: "en-US",
  });
  const input = await screen.findByRole("textbox", {
    name: "Onboarding prompt",
  });
  expect(input).toHaveValue(TASK);
  await user.click(input);
  await user.paste(clipboard(text));

  await waitFor(() => {
    expect(screen.getByText(FIRST_FILENAME)).toBeInTheDocument();
    expect(button("Next")).toBeEnabled();
  });
  expect(input).toHaveValue(TASK);
  expect(receivedUpload).toStrictEqual({
    filename: FIRST_FILENAME,
    contentType: "text/plain",
    text,
  });
  click(button("Next"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByText(TASK)).resolves.toBeInTheDocument();
  expect(screen.getByText(FIRST_FILENAME)).toBeInTheDocument();
  await waitFor(() => {
    expect(sentRequest?.prompt).toBe(TASK);
    expect(pathname()).toBe(`/chats/${sentRequest?.threadId}`);
  });
  expect(manifests.get(EDITED_HASH)).toStrictEqual({
    version: 1,
    prompt: TASK,
    files: [uploaded],
    options: {},
  });
  expect(importedHash).toBe(EDITED_HASH);
  expect(sentRequest?.userMessage?.parts).toContainEqual({
    type: "text",
    text: TASK,
  });
  expect(
    sentRequest?.userMessage?.parts.filter((part) => {
      return part.type === "file";
    }),
  ).toStrictEqual([
    {
      type: "file",
      fileId: importedFileId,
      filenameSnapshot: FIRST_FILENAME,
      contentType: "text/plain",
    },
  ]);
  expect(search()).toBe("");
});

test("Finishing a later paste does not enable Run while an earlier upload is pending", async () => {
  const user = userEvent.setup({ delay: null });
  const first = "First note\n" + "a".repeat(10_001);
  const second = "Second note\n" + "b".repeat(10_001);
  const firstGate = context.mocks.deferred<void>();
  const secondGate = context.mocks.deferred<void>();
  context.mocks.api(
    marketingHandoffsContract.upload,
    async ({ body, respond, withSignal }) => {
      await withSignal(
        body.filename === FIRST_FILENAME
          ? firstGate.promise
          : secondGate.promise,
      );
      return respond(
        200,
        uploadedFile(
          body.filename,
          uploadText(body.data),
          body.filename === FIRST_FILENAME ? "c" : "d",
        ),
      );
    },
  );
  const capture = captureSavedHandoff();
  const input = await openPrompt();
  await user.click(input);
  await user.paste(clipboard(first));
  await expect(
    screen.findByText(`Loading ${FIRST_FILENAME}`),
  ).resolves.toBeInTheDocument();
  expect(button("Next")).toBeDisabled();

  await user.paste(clipboard(second));
  await expect(
    screen.findByText(`Loading ${SECOND_FILENAME}`),
  ).resolves.toBeInTheDocument();
  secondGate.resolve();
  await waitFor(() => {
    expect(
      screen.queryByText(`Loading ${SECOND_FILENAME}`),
    ).not.toBeInTheDocument();
    expect(button(`Remove ${SECOND_FILENAME}`)).toBeInTheDocument();
  });
  expect(button("Next")).toBeDisabled();
  expect(input).toHaveValue(TASK);
  expect(screen.getByText(`Loading ${FIRST_FILENAME}`)).toBeInTheDocument();

  firstGate.resolve();
  await waitFor(() => {
    expect(button("Next")).toBeEnabled();
  });
  click(button("Next"));
  await waitFor(() => {
    expect(new URLSearchParams(search()).get("handoff")).toBe(EDITED_HASH);
  });
  expect(capture.manifests[0]?.files).toStrictEqual([
    uploadedFile(SECOND_FILENAME, second, "d"),
    uploadedFile(FIRST_FILENAME, first),
  ]);
});

test("A failed pasted attachment retains its contents for retry or explicit removal", async () => {
  const user = userEvent.setup({ delay: null });
  const text = "Retry these exact notes\n" + "a".repeat(10_001);
  let unavailable = true;
  const bodies: string[] = [];
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    bodies.push(uploadText(body.data));
    return unavailable
      ? respond(503, {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Upload temporarily unavailable",
          },
        })
      : respond(200, uploadedFile(body.filename, uploadText(body.data)));
  });
  const input = await openPrompt();
  await user.click(input);
  await user.paste(clipboard(text));
  const attachments = await screen.findByRole("list", { name: "Attachments" });
  await expect(
    within(attachments).findByRole("alert"),
  ).resolves.toHaveTextContent(`Could not upload ${FIRST_FILENAME}`);
  expect(input).toHaveValue(TASK);
  expect(button("Next")).toBeDisabled();
  expect(button(`Remove ${FIRST_FILENAME}`, attachments)).toBeEnabled();

  unavailable = false;
  click(button("Retry", attachments));
  await waitFor(() => {
    expect(button("Next")).toBeEnabled();
  });
  expect(bodies).toStrictEqual([text, text]);
  click(button(`Remove ${FIRST_FILENAME}`, attachments));
  await waitFor(() => {
    expect(
      screen.queryByRole("list", { name: "Attachments" }),
    ).not.toBeInTheDocument();
  });
  expect(input).toHaveValue(TASK);

  unavailable = true;
  await user.click(input);
  await user.paste(clipboard(text));
  const failedAttachments = await screen.findByRole("list", {
    name: "Attachments",
  });
  await expect(
    within(failedAttachments).findByRole("alert"),
  ).resolves.toHaveTextContent(`Could not upload ${SECOND_FILENAME}`);
  expect(button("Next")).toBeDisabled();
  click(button(`Remove ${SECOND_FILENAME}`, failedAttachments));
  await waitFor(() => {
    expect(button("Next")).toBeEnabled();
  });
  expect(
    screen.queryByRole("list", { name: "Attachments" }),
  ).not.toBeInTheDocument();
  expect(input).toHaveValue(TASK);
});

test("Clipboard file items keep their oversized plain-text fallback in the prompt", async () => {
  const user = userEvent.setup({ delay: null });
  const text = "m".repeat(10_001);
  const input = await openPrompt();
  await fill(input, "Keep this draft. ");
  expect(input).toHaveValue("Keep this draft. ");

  await user.paste(
    clipboard(text, [new File(["image"], "image.png", { type: "image/png" })]),
  );

  expect(input).toHaveValue(`Keep this draft. ${text}`);
  expect(button("Next")).toBeEnabled();
  expect(
    screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
  ).not.toBeInTheDocument();
});

test("The attachment cap includes uploads still in progress and preserves a rejected paste as text", async () => {
  const user = userEvent.setup({ delay: null });
  const files = Array.from(
    { length: MARKETING_HANDOFF_MAX_FILES - 1 },
    (_, index) => {
      return uploadedFile(`original-${String(index)}.txt`, "Original notes");
    },
  );
  context.mocks.api(marketingHandoffsContract.upload, async ({ never }) => {
    return await never();
  });
  const input = await openPrompt({ files });
  await user.click(input);
  await user.paste(clipboard("a".repeat(10_001)));
  await expect(
    screen.findByText(`Loading ${FIRST_FILENAME}`),
  ).resolves.toBeInTheDocument();

  const rejected = "b".repeat(10_001);
  await user.paste(clipboard(rejected));

  await expect(
    screen.findByText(
      `You can attach up to ${String(MARKETING_HANDOFF_MAX_FILES)} files. Your pasted text remains in the prompt.`,
    ),
  ).resolves.toBeInTheDocument();
  expect(input).toHaveValue(TASK + rejected);
  expect(button("Next")).toBeDisabled();
  click(button(`Remove ${FIRST_FILENAME}`));
  await waitFor(() => {
    expect(button("Next")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText(`Remove ${SECOND_FILENAME}`),
  ).not.toBeInTheDocument();
});

test("A paste at the 10 MB upload limit preserves every UTF-8 byte", async () => {
  const user = userEvent.setup({ delay: null });
  const text = "中\n" + "x".repeat(MARKETING_HANDOFF_MAX_FILE_BYTES - 4);
  let received: { contentType: string; text: string; size: number } | undefined;
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    const decoded = uploadText(body.data);
    received = {
      contentType: body.contentType,
      text: decoded,
      size: new Blob([decoded]).size,
    };
    return respond(200, uploadedFile(body.filename, decoded));
  });
  const input = await openPrompt();
  await user.click(input);
  await user.paste(clipboard(text));

  await waitFor(() => {
    expect(button("Next")).toBeEnabled();
    expect(screen.getByText(FIRST_FILENAME)).toBeInTheDocument();
  });
  expect(input).toHaveValue(TASK);
  expect(received).toStrictEqual({
    contentType: "text/plain",
    text,
    size: MARKETING_HANDOFF_MAX_FILE_BYTES,
  });
});

test("A paste above 10 MB remains text rather than disappearing into a rejected upload", async () => {
  const user = userEvent.setup({ delay: null });
  const text = "x".repeat(MARKETING_HANDOFF_MAX_FILE_BYTES + 1);
  const input = await openPrompt();
  await user.click(input);
  await user.keyboard("{Control>}a{/Control}");

  await user.paste(clipboard(text));

  await expect(
    screen.findByText(
      `${FIRST_FILENAME} exceeds the 10 MB limit. Your pasted text remains in the prompt.`,
    ),
  ).resolves.toBeInTheDocument();
  expect(input).toHaveValue(text);
  expect(button("Next")).toBeDisabled();
  expect(
    screen.queryByLabelText(`Remove ${FIRST_FILENAME}`),
  ).not.toBeInTheDocument();
});

test.each([false, true])(
  "The final prompt limit includes output instructions and can be corrected without losing text (mobile: %s)",
  async (mobile) => {
    const prompt =
      TASK + "x".repeat(MARKETING_HANDOFF_PROMPT_MAX_CHARS - TASK.length);
    const capture = captureSavedHandoff();
    const input = await openPrompt({ prompt, mobile });
    const action = mobile ? "Start task" : "Next";
    expect(input).toHaveValue(prompt);
    expect(button(action)).toBeEnabled();
    click(button("Document"));

    await expect(
      screen.findByText(
        `${String(prompt.length + DOCUMENT.length + 2)} / ${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} characters (including output instructions)`,
      ),
    ).resolves.toBeInTheDocument();
    expect(button(action)).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(capture.manifests).toStrictEqual([]);
    click(button("Clear selection"));
    await waitFor(() => {
      expect(button(action)).toBeEnabled();
    });
    // This models typed/edited input, not a paste that should become a File.
    fireEvent.change(input, { target: { value: prompt + "x" } });
    await expect(
      screen.findByText(
        `${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS + 1)} / ${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} characters (including output instructions)`,
      ),
    ).resolves.toBeInTheDocument();
    expect(button(action)).toBeDisabled();
    expect(input).toHaveValue(prompt + "x");
    fireEvent.change(input, { target: { value: prompt } });
    expect(button(action)).toBeEnabled();
    click(button(action));

    await waitFor(() => {
      expect(new URLSearchParams(search()).get("handoff")).toBe(EDITED_HASH);
    });
    expect(capture.manifests[0]?.prompt).toBe(prompt);
  },
);

test("Changing language refreshes the selected suffix and its exact submission count", async () => {
  // Only the resource URL is imported. This fixture sentinel is not translated
  // copy; the single flat key leaves the rest of the UI on en-US fallback.
  const instruction = "Current-locale document instruction fixture.";
  context.mocks.http.get(deDECommonUrl, () => {
    return HttpResponse.json({
      "onboarding.sourcesFirst.outputFormats.options.report.instruction":
        instruction,
    });
  });
  const originalPrompt =
    TASK +
    "x".repeat(
      MARKETING_HANDOFF_PROMPT_MAX_CHARS - DOCUMENT.length - 2 - TASK.length,
    );
  const capture = captureSavedHandoff();
  const input = await openPrompt({ prompt: originalPrompt });
  click(button("Document"));
  await expect(
    screen.findByText(
      `${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} / ${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} characters (including output instructions)`,
    ),
  ).resolves.toBeInTheDocument();
  expect(button("Next")).toBeEnabled();

  click(await screen.findByLabelText("Test User"));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(await within(settings).findByRole("combobox", { name: "Language" }));
  click(screen.getByRole("option", { name: "Deutsch" }));
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("lang", "de-DE");
    expect(
      screen.getByRole("combobox", { name: "Language" }),
    ).toHaveTextContent("Deutsch");
  });
  click(button("Close", settings));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  expect(input).toHaveValue(originalPrompt);
  expect(button("Document")).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByText(
      `${String(originalPrompt.length + instruction.length + 2)} / ${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} characters (including output instructions)`,
    ),
  ).toBeInTheDocument();

  const currentPrompt =
    TASK +
    "x".repeat(
      MARKETING_HANDOFF_PROMPT_MAX_CHARS - instruction.length - 2 - TASK.length,
    );
  fireEvent.change(input, { target: { value: currentPrompt } });
  expect(
    screen.getByText(
      `${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} / ${String(MARKETING_HANDOFF_PROMPT_MAX_CHARS)} characters (including output instructions)`,
    ),
  ).toBeInTheDocument();
  expect(button("Next")).toBeEnabled();
  click(button("Next"));
  await waitFor(() => {
    expect(new URLSearchParams(search()).get("handoff")).toBe(EDITED_HASH);
  });
  expect(capture.manifests[0]?.prompt).toBe(
    `${currentPrompt}\n\n${instruction}`,
  );
  expect(capture.manifests[0]?.prompt.length).toBe(
    MARKETING_HANDOFF_PROMPT_MAX_CHARS,
  );
});

test("Leaving the owning onboarding page aborts an in-flight paste upload", async () => {
  const user = userEvent.setup({ delay: null });
  const cancelled = context.mocks.deferred<void>();
  const uploading = context.mocks.deferred<void>();
  context.mocks.api(
    marketingHandoffsContract.upload,
    async ({ signal, never }) => {
      signal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
        },
        { once: true },
      );
      uploading.resolve();
      return await never();
    },
  );
  const input = await openPrompt({
    host: "pr-45955-app-okou-app-preview.vm0.workers.dev",
  });
  await user.click(input);
  await user.paste(clipboard("a".repeat(10_001)));
  await uploading.promise;
  expect(button("Next")).toBeDisabled();

  click(button("Skip"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  await cancelled.promise;
  expect(input).not.toBeInTheDocument();
});
