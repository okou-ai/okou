import {
  browserUserActionsContract,
  type BrowserUserActionApplyRequest,
  type BrowserUserActionResponse,
  type BrowserUserActionState,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import type { ChatEventSendBody } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const context = testContext();

const REQUEST_TOKEN = `vm0_browser_user_action_${"Q7".repeat(21)}x`;
const AGENT_ID = "a1000000-0000-4000-8000-000000000001";
const THREAD_ID = "b1000000-0000-4000-8000-000000000001";
const CALLBACK_PROMPT = "Continue the checkout with the entered details.";
const SUCCESS_EVENT_ID = "c1000000-0000-4000-8000-000000000001";
const SUCCESS_SORT_EVENT_ID = "c1000000-0000-4000-8000-000000000002";
const CANCELLATION_EVENT_ID = "c1000000-0000-4000-8000-000000000003";
const CANCELLATION_SORT_EVENT_ID = "c1000000-0000-4000-8000-000000000004";
const FORM_TITLE = "Complete the order form";
const SHOP_ORIGIN = "https://shop.example.com";
const UPLOADS_ORIGIN = "https://uploads.example.com";
const UPLOAD_URL = "https://storage.example.net/browser-input/upload-1";
const FINGERPRINT = "a".repeat(64);
const SUBMIT = "Add to browser";
const CONFIRM_CURRENT = "Use current value";

type BrowserInputField = BrowserUserActionResponse["fields"][number];
type BrowserInputControl = BrowserInputField["control"];
type SubmittedValues = BrowserUserActionApplyRequest["values"];

function inputField(
  key: string,
  label: string,
  fieldKind: BrowserInputField["fieldKind"],
  required: boolean,
  control: BrowserInputControl,
): BrowserInputField {
  return { key, label, fieldKind, required, control };
}

function browserInput(
  fields: readonly BrowserInputField[],
  state: BrowserUserActionState,
  siteOrigin: string,
): BrowserUserActionResponse {
  return {
    kind: "input",
    requestToken: REQUEST_TOKEN,
    state,
    completedAt: state === "pending" ? null : "2026-11-20T08:00:00.000Z",
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    callbackIds: {
      success: {
        clientEventId: SUCCESS_EVENT_ID,
        chatThreadSortEventId: SUCCESS_SORT_EVENT_ID,
      },
      cancellation: {
        clientEventId: CANCELLATION_EVENT_ID,
        chatThreadSortEventId: CANCELLATION_SORT_EVENT_ID,
      },
    },
    title: FORM_TITLE,
    reason: "The checkout page needs these details before it can continue.",
    siteOrigin,
    fields: [...fields],
  };
}

interface BrowserInputStory {
  readonly applied: SubmittedValues[];
  readonly callbacks: ChatEventSendBody[];
  readonly preflights: () => number;
}

function mockBrowserInput(args: {
  readonly fields: readonly BrowserInputField[];
  readonly requestedFields?: readonly BrowserInputField[];
  readonly siteOrigin?: string;
}): BrowserInputStory {
  const siteOrigin = args.siteOrigin ?? SHOP_ORIGIN;
  const applied: SubmittedValues[] = [];
  const callbacks: ChatEventSendBody[] = [];
  let preflights = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(
      200,
      browserInput(args.requestedFields ?? args.fields, "pending", siteOrigin),
    );
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    preflights += 1;
    return respond(200, browserInput(args.fields, "pending", siteOrigin));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    applied.push(body.values);
    return respond(200, browserInput(args.fields, "succeeded", siteOrigin));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callbacks.push(body);
    return respond(201, {
      threadId: THREAD_ID,
      createdAt: "2026-11-20T08:00:01.000Z",
    });
  });
  return {
    applied,
    callbacks,
    preflights: () => {
      return preflights;
    },
  };
}

async function openBrowserInput(): Promise<HTMLFormElement> {
  const query = new URLSearchParams({
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    callbackPrompt: CALLBACK_PROMPT,
  });
  await setupPage({
    context,
    path: `/browser/actions/${REQUEST_TOKEN}?${query.toString()}`,
  });
  const form = await screen.findByRole("form", { name: FORM_TITLE });
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected the Browser input form");
  }
  return form;
}

async function waitForWebsiteCheck(story: BrowserInputStory): Promise<void> {
  await waitFor(() => {
    expect(story.preflights()).toBe(1);
    expect(
      screen.queryByRole("status", { name: "Checking this request…" }),
    ).not.toBeInTheDocument();
  });
}

function formButton(form: HTMLFormElement, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", form).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Expected the ${name} button`);
  }
  return button;
}

function submitButton(form: HTMLFormElement): HTMLElement {
  return formButton(form, SUBMIT);
}

async function submitWhenReady(form: HTMLFormElement): Promise<void> {
  await waitFor(() => {
    expect(submitButton(form)).toBeEnabled();
  });
  click(submitButton(form));
}

async function expectAgentNotified(story: BrowserInputStory): Promise<void> {
  await waitFor(() => {
    expect(story.callbacks).toHaveLength(1);
  });
  expect(story.applied).toHaveLength(1);
  expect(story.callbacks[0]).toMatchObject({
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    prompt: CALLBACK_PROMPT,
    clientEventId: SUCCESS_EVENT_ID,
    chatThreadSortEventId: SUCCESS_SORT_EVENT_ID,
  });
}

function shownValue(control: HTMLElement): HTMLElement {
  const row = control.parentElement;
  if (!row) {
    throw new Error("Expected the control row");
  }
  return within(row).getByRole("status");
}

function rangeField(
  required: boolean,
  constraints: { readonly step?: string },
): BrowserInputField {
  return inputField("volume", "Volume", "range", required, {
    tagName: "INPUT",
    inputType: "range",
    rangeValue: "19",
    min: "10",
    max: "20",
    ...constraints,
  });
}

function colorField(required: boolean): BrowserInputField {
  return inputField("accent", "Accent color", "color", required, {
    tagName: "INPUT",
    inputType: "color",
    colorValue: "#123abc",
    colorMode: "opaque-srgb",
  });
}

function fileField(
  required: boolean,
  files: NonNullable<BrowserInputControl["files"]>,
): BrowserInputField {
  return inputField("attachments", "Attachments", "file", required, {
    tagName: "INPUT",
    inputType: "file",
    accept: ".txt",
    multiple: true,
    fileSetFingerprint: FINGERPRINT,
    files,
  });
}

function quantityField(required: boolean): BrowserInputField {
  return inputField("quantity", "Quantity", "number", required, {
    tagName: "INPUT",
    inputType: "number",
    min: "10",
    max: "20",
    step: "0.5",
  });
}

function arrivalField(): BrowserInputField {
  return inputField("arrival", "Arrival", "date_time", false, {
    tagName: "INPUT",
    inputType: "date",
  });
}

test("A required native slider starts at the website position and needs deliberate confirmation", async () => {
  const story = mockBrowserInput({
    fields: [rangeField(true, { step: "any" })],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  const slider = within(form).getByRole("slider", { name: "Volume" });
  expect(slider).toHaveValue("19");
  expect(shownValue(slider)).toHaveTextContent("19");
  expect(submitButton(form)).toBeDisabled();

  click(formButton(form, CONFIRM_CURRENT));
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "volume",
      observedValue: "19",
      observedMin: "10",
      observedMax: "20",
      observedStep: "any",
      value: "19",
    },
  ]);
});

test("An optional native slider stays untouched unless the user changes it", async () => {
  const story = mockBrowserInput({ fields: [rangeField(false, {})] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const slider = within(form).getByRole("slider", { name: "Volume" });

  fireEvent.change(slider, { target: { value: "16" } });
  await waitFor(() => {
    expect(shownValue(slider)).toHaveTextContent("16");
  });
  expect(slider).toHaveValue("16");
  fireEvent.change(slider, { target: { value: "19" } });
  await waitFor(() => {
    expect(shownValue(slider)).toHaveTextContent("19");
  });
  expect(slider).toHaveValue("19");
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([]);
});

test("An optional native slider submits a changed position with its observed snapshot", async () => {
  const story = mockBrowserInput({
    fields: [rangeField(false, { step: "any" })],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const slider = within(form).getByRole("slider", { name: "Volume" });

  fireEvent.change(slider, { target: { value: "16" } });
  await waitFor(() => {
    expect(shownValue(slider)).toHaveTextContent("16");
  });
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "volume",
      observedValue: "19",
      observedMin: "10",
      observedMax: "20",
      observedStep: "any",
      value: "16",
    },
  ]);
});

test("A required native color starts from the website and needs explicit confirmation", async () => {
  const story = mockBrowserInput({ fields: [colorField(true)] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  const picker = within(form).getByLabelText("Accent color");
  expect(picker).toHaveValue("#123abc");
  expect(shownValue(picker)).toHaveTextContent("#123abc");
  expect(submitButton(form)).toBeDisabled();

  click(formButton(form, CONFIRM_CURRENT));
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    { key: "accent", observedColor: "#123abc", value: "#123abc" },
  ]);
});

test("An optional native color remains untouched or submits an explicit change", async () => {
  const story = mockBrowserInput({ fields: [colorField(false)] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const picker = within(form).getByLabelText("Accent color");

  fireEvent.change(picker, { target: { value: "#00ff00" } });
  await waitFor(() => {
    expect(shownValue(picker)).toHaveTextContent("#00ff00");
  });
  expect(picker).toHaveValue("#00ff00");
  fireEvent.change(picker, { target: { value: "#123abc" } });
  await waitFor(() => {
    expect(shownValue(picker)).toHaveTextContent("#123abc");
  });
  expect(picker).toHaveValue("#123abc");
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([]);
});

test("A changed native color submits its observed website snapshot", async () => {
  const story = mockBrowserInput({ fields: [colorField(false)] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const picker = within(form).getByLabelText("Accent color");

  fireEvent.change(picker, { target: { value: "#00ff00" } });
  await waitFor(() => {
    expect(shownValue(picker)).toHaveTextContent("#00ff00");
  });
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    { key: "accent", observedColor: "#123abc", value: "#00ff00" },
  ]);
});

test("A standalone native file input transfers chosen bytes only on confirmed submission", async () => {
  const story = mockBrowserInput({
    fields: [fileField(true, [])],
    siteOrigin: UPLOADS_ORIGIN,
  });
  const prepared: unknown[] = [];
  context.mocks.api(
    browserUserActionsContract.prepareFileUpload,
    ({ body, respond }) => {
      prepared.push(body);
      return respond(200, { uploadUrl: UPLOAD_URL });
    },
  );
  const uploads: {
    readonly credentials: RequestCredentials;
    readonly headers: readonly string[];
    readonly contentType: string | null;
    readonly body: string;
  }[] = [];
  const releaseUpload = context.mocks.deferred<void>();
  context.mocks.http.put(UPLOAD_URL, async ({ request }) => {
    uploads.push({
      credentials: request.credentials,
      headers: [...request.headers.keys()],
      contentType: request.headers.get("content-type"),
      body: await request.text(),
    });
    await releaseUpload.promise;
    return new HttpResponse(null, { status: 200 });
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const fileInput = within(form).getByLabelText("Attachments");
  expect(fileInput).toHaveAttribute("accept", ".txt");
  expect(fileInput).toHaveAttribute("multiple");

  await userEvent
    .setup({ delay: null })
    .upload(fileInput, new File(["note"], "note.txt", { type: "text/plain" }));
  await expect(
    within(form).findByText("(1) note.txt (4 B)"),
  ).resolves.toBeInTheDocument();
  expect(prepared).toStrictEqual([]);
  expect(uploads).toStrictEqual([]);

  await submitWhenReady(form);
  await waitFor(() => {
    expect(uploads).toHaveLength(1);
  });
  expect(prepared).toStrictEqual([{ key: "attachments", index: 0, size: 4 }]);
  expect(uploads[0]).toStrictEqual({
    credentials: "omit",
    headers: ["content-type"],
    contentType: "application/octet-stream",
    body: "note",
  });
  expect(formButton(form, "Adding…")).toBeDisabled();
  expect(formButton(form, "Cancel")).toBeDisabled();
  expect(within(form).getByLabelText("Attachments")).toBeDisabled();
  expect(story.applied).toStrictEqual([]);

  releaseUpload.resolve();
  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "attachments",
      operation: "replace",
      observedFingerprint: FINGERPRINT,
      files: [{ name: "note.txt", type: "text/plain", size: 4 }],
    },
  ]);
});

test("An optional file selection leaves existing website files untouched", async () => {
  const story = mockBrowserInput({
    fields: [
      fileField(false, [{ name: "old.txt", type: "text/plain", size: 3 }]),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  expect(within(form).getByText("(1) old.txt (3 B)")).toBeInTheDocument();
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([]);
});

test("A required file field can retain already selected website files", async () => {
  const story = mockBrowserInput({
    fields: [
      fileField(true, [{ name: "old.txt", type: "text/plain", size: 3 }]),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  expect(within(form).getByText("(1) old.txt (3 B)")).toBeInTheDocument();

  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "attachments",
      operation: "keep",
      observedFingerprint: FINGERPRINT,
      files: [],
    },
  ]);
});

test("The standalone form uses preflight's observed multiline and email controls", async () => {
  const story = mockBrowserInput({
    requestedFields: [
      inputField("emails", "Email addresses", "text", true, {
        tagName: "INPUT",
        inputType: "text",
      }),
      inputField("notes", "Delivery notes", "text", false, {
        tagName: "INPUT",
        inputType: "text",
      }),
    ],
    fields: [
      inputField("emails", "Email addresses", "text", true, {
        tagName: "INPUT",
        inputType: "email",
        multiple: true,
      }),
      inputField("notes", "Delivery notes", "text", false, {
        tagName: "TEXTAREA",
        inputType: "textarea",
        minLength: 3,
      }),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  const email = within(form).getByRole("textbox", { name: "Email addresses" });
  expect(email).toHaveAttribute("type", "email");
  expect(email).toBeRequired();
  expect(email).toHaveAttribute("multiple");
  const notes = within(form).getByRole("textbox", { name: "Delivery notes" });
  expect(notes.tagName).toBe("TEXTAREA");
  expect(notes).toHaveAttribute("minlength", "3");

  await fill(email, "buyer@example.com");
  await fill(notes, "Leave at the door\nRing twice");
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    { key: "emails", value: "buyer@example.com" },
    { key: "notes", value: "Leave at the door\nRing twice" },
  ]);
});

test("The standalone form uses the existing input style with live number constraints", async () => {
  const story = mockBrowserInput({ fields: [quantityField(true)] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  const quantity = within(form).getByRole("spinbutton", { name: "Quantity" });
  expect(quantity).toHaveAttribute("min", "10");
  expect(quantity).toHaveAttribute("max", "20");
  expect(quantity).toHaveAttribute("step", "0.5");
  expect(quantity).toBeRequired();

  await fill(quantity, "12.5");
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([{ key: "quantity", value: "12.5" }]);
});

test("Optional number field can be untouched or cleared using its input (false)", async () => {
  const story = mockBrowserInput({ fields: [quantityField(false)] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  expect(
    within(form).getByRole("spinbutton", { name: "Quantity" }),
  ).toHaveValue(null);

  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([]);
});

test("A native date picker submits its local canonical string", async () => {
  const story = mockBrowserInput({ fields: [arrivalField()] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);

  const arrival = within(form).getByLabelText("Arrival");
  expect(arrival).toHaveAttribute("type", "date");
  fireEvent.change(arrival, { target: { value: "2026-09-25" } });
  await waitFor(() => {
    expect(arrival).toHaveValue("2026-09-25");
  });
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    { key: "arrival", value: "2026-09-25" },
  ]);
});

test("An optional date can be untouched or explicitly cleared (false)", async () => {
  const story = mockBrowserInput({ fields: [arrivalField()] });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  expect(within(form).getByLabelText("Arrival")).toHaveValue("");

  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([]);
});

test("An optional checkbox submits an explicit false rather than the website's true", async () => {
  const story = mockBrowserInput({
    fields: [
      inputField("consent", "Email me order updates", "checkbox", false, {
        tagName: "INPUT",
        inputType: "checkbox",
        checked: true,
      }),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const consent = within(form).getByRole("checkbox", {
    name: "Email me order updates",
  });
  expect(consent).toBeChecked();

  click(consent);
  await waitFor(() => {
    expect(consent).not.toBeChecked();
  });
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    { key: "consent", checked: false, observedChecked: true },
  ]);
});

test("An Agent-required radio group submits its existing valid website choice", async () => {
  const story = mockBrowserInput({
    fields: [
      inputField("shipping", "Shipping speed", "radio", true, {
        tagName: "INPUT",
        inputType: "radio",
        radioGroupFingerprint: FINGERPRINT,
        radioOptions: [
          { index: 0, label: "Standard", disabled: false, selected: true },
          { index: 1, label: "Express", disabled: false, selected: false },
        ],
      }),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const group = within(form).getByRole("radiogroup", {
    name: "Shipping speed",
  });
  expect(
    within(group).getByRole("radio", { name: "Shipping speed 1. Standard" }),
  ).toBeChecked();

  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "shipping",
      memberIndex: 0,
      observedSelectedIndex: 0,
      groupFingerprint: FINGERPRINT,
    },
  ]);
});

test("A required multiple select cannot keep a disabled website choice and drops it on change", async () => {
  const story = mockBrowserInput({
    fields: [
      inputField("sizes", "Sizes", "select", true, {
        tagName: "SELECT",
        inputType: "select-multiple",
        optionSetFingerprint: FINGERPRINT,
        options: [
          {
            index: 0,
            label: "First",
            disabled: false,
            selected: true,
            empty: false,
          },
          {
            index: 1,
            label: "Second",
            disabled: false,
            selected: false,
            empty: false,
          },
          {
            index: 2,
            label: "Unavailable",
            disabled: true,
            selected: true,
            empty: false,
          },
        ],
      }),
    ],
  });
  const form = await openBrowserInput();
  await waitForWebsiteCheck(story);
  const sizes = within(form).getByRole("listbox", { name: "Sizes" });
  expect(submitButton(form)).toBeDisabled();

  await userEvent.setup({ delay: null }).selectOptions(sizes, "Second");
  await submitWhenReady(form);

  await expectAgentNotified(story);
  expect(story.applied[0]).toStrictEqual([
    {
      key: "sizes",
      optionIndexes: [0, 1],
      optionSetFingerprint: FINGERPRINT,
    },
  ]);
});
