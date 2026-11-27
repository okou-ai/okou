import {
  browserUserActionsContract,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import {
  callbackPrompt,
  installBrowserRequest,
  siteOrigin,
  threadId,
  type Field,
} from "./browser-input-request-fixture.ts";

const context = testContext();
const fingerprint = "de".repeat(32);
const email = "billing@example.org";

const account = {
  key: "account",
  label: "Invoice email",
  fieldKind: "username",
  required: true,
  control: {
    tagName: "INPUT",
    inputType: "email",
  },
  description: "Use your invoice account",
} satisfies Field;
const password = {
  key: "password",
  label: "Account password",
  fieldKind: "password",
  required: true,
  control: {
    tagName: "INPUT",
    inputType: "password",
  },
} satisfies Field;
const code = {
  key: "code",
  label: "Verification code",
  fieldKind: "one_time_code",
  required: true,
  control: {
    tagName: "INPUT",
    inputType: "text",
  },
} satisfies Field;

function browserRequest(
  fields: Field[],
  initial?: Partial<BrowserUserActionResponse>,
) {
  return installBrowserRequest(context, fields, initial);
}
function addButton() {
  return screen.getByText("Add to browser", { selector: "button" });
}
async function submit(request: ReturnType<typeof browserRequest>) {
  const button = addButton();
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  click(button);
  await expect(
    screen.findByText("Agent notified"),
  ).resolves.toBeInTheDocument();
  return request.applied.promise;
}

test("browser-user-action-page-001 invoice sign-in explains the account and continues its chat after applying the email", async () => {
  const title = "Sign in to view invoices";
  const reason = "The invoice portal requires your company account.";
  const request = browserRequest([account], { title, reason });
  await request.open();
  const form = within(await screen.findByRole("form", { name: title }));
  expect(form.getByText(title, { selector: "h2" })).toBeInTheDocument();
  expect(form.getByText(reason)).toBeInTheDocument();
  expect(form.getByText(account.description)).toBeInTheDocument();
  expect(form.getByText(siteOrigin)).toBeInTheDocument();
  await fill(form.getByLabelText(account.label), email);
  await expect(submit(request)).resolves.toStrictEqual([
    { key: account.key, value: email },
  ]);
  await expect(request.callback.promise).resolves.toMatchObject({
    prompt: callbackPrompt,
    threadId,
  });
});

test("browser-user-action-page-003 opening and closing saved-password instructions preserves the username", async () => {
  const request = browserRequest([account]);
  await request.open();
  const input = await screen.findByLabelText(account.label);
  await fill(input, email);
  const help = screen.getByText("Use a saved password", {
    selector: "summary",
  });
  const instructions = screen.getByText(/Chrome \(desktop\): Right-click/);
  expect(instructions).not.toBeVisible();
  click(help);
  expect(instructions).toBeVisible();
  expect(input).toHaveValue(email);
  expect(screen.getByText(/Safari \(Mac\): Click/)).toBeVisible();
  click(help);
  expect(instructions).not.toBeVisible();
  expect(input).toHaveValue(email);
});

const range = {
  tagName: "INPUT",
  inputType: "range",
  rangeValue: "19",
  min: "10",
  max: "20",
  step: "any",
} as const;
const color = {
  tagName: "INPUT",
  inputType: "color",
  colorValue: "#123abc",
  colorMode: "opaque-srgb",
} as const;
const slider = {
  key: "level",
  label: "Volume",
  fieldKind: "range",
  required: false,
  control: range,
} satisfies Field;
const picker = {
  key: "tint",
  label: "Accent color",
  fieldKind: "color",
  required: false,
  control: color,
} satisfies Field;
function position(value: string) {
  return {
    key: slider.key,
    value,
    observedValue: "19",
    observedMin: "10",
    observedMax: "20",
    observedStep: "any",
  };
}
function tint(value: string) {
  return { key: picker.key, value, observedColor: "#123abc" };
}

test.each([
  { id: "007", control: slider, initial: "19", applied: position("19") },
  { id: "010", control: picker, initial: "#123abc", applied: tint("#123abc") },
])(
  "browser-user-action-page-$id confirming the current $control.label authorizes its observed website value",
  async ({ control, initial, applied }) => {
    const request = browserRequest([{ ...control, required: true }]);
    await request.open();
    const input = await screen.findByLabelText(control.label);
    expect(input).toHaveValue(initial);
    expect(addButton()).toBeDisabled();
    click(screen.getByText("Use current value"));
    await expect(submit(request)).resolves.toStrictEqual([applied]);
  },
);

test.each([
  { id: "008", control: slider, changed: "16", initial: "19" },
  { id: "011", control: picker, changed: "#00ff00", initial: "#123abc" },
])(
  "browser-user-action-page-$id restoring the website's $control.label discards the optional edit",
  async ({ control, changed, initial }) => {
    const request = browserRequest([control]);
    await request.open();
    const input = await screen.findByLabelText(control.label);
    await waitFor(() => {
      expect(addButton()).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: changed } });
    expect(input).toHaveValue(changed);
    fireEvent.change(input, { target: { value: initial } });
    expect(input).toHaveValue(initial);
    await expect(submit(request)).resolves.toStrictEqual([]);
  },
);

test.each([
  { id: "009", control: slider, changed: "16", applied: position("16") },
  { id: "012", control: picker, changed: "#00ff00", applied: tint("#00ff00") },
])(
  "browser-user-action-page-$id applying an edited $control.label carries its original website observation",
  async ({ control, changed, applied }) => {
    const request = browserRequest([control]);
    await request.open();
    const input = await screen.findByLabelText(control.label);
    await waitFor(() => {
      expect(addButton()).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: changed } });
    await expect(submit(request)).resolves.toStrictEqual([applied]);
  },
);

function documentField(required: boolean, populated: boolean) {
  return {
    key: "attachment",
    label: "Invoice attachment",
    fieldKind: "file",
    required: required,
    control: {
      tagName: "INPUT",
      inputType: "file",
      multiple: true,
      accept: ".txt",
      fileSetFingerprint: fingerprint,
      files: populated
        ? [{ name: "old.txt", size: 8, type: "text/plain" }]
        : [],
    },
  } satisfies Field;
}
test("browser-user-action-page-013 picked bytes transfer on confirmation and apply only after the upload finishes", async () => {
  const document = documentField(true, false);
  const request = browserRequest([document], {
    siteOrigin: "https://uploads.example",
  });
  const uploadUrl = "https://storage.example/invoice-note";
  const transfer = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  let confirmed = false;
  let uploaded = false;
  context.mocks.api(
    browserUserActionsContract.prepareFileUpload,
    ({ body, respond }) => {
      expect(confirmed).toBeTruthy();
      expect(body).toStrictEqual({ key: document.key, index: 0, size: 4 });
      return respond(200, { uploadUrl });
    },
  );
  context.mocks.http.put(uploadUrl, async ({ request: put }) => {
    transfer.resolve(put);
    await complete.promise;
    uploaded = true;
    return new Response(null, { status: 200 });
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(uploaded).toBeTruthy();
    request.applied.resolve(body.values);
    return respond(200, request.transition("succeeded"));
  });
  await request.open();
  const input = await screen.findByLabelText(document.label);
  await waitFor(() => {
    expect(input).toHaveAttribute("accept", ".txt");
  });
  expect(input).toHaveAttribute("multiple");
  const file = new File(["note"], "note.txt", { type: "text/plain" });
  await userEvent.upload(input, file);
  await screen.findByText(/note\.txt \(4 B\)/);
  await waitFor(() => {
    expect(addButton()).toBeEnabled();
  });
  expect(transfer.settled()).toBeFalsy();
  confirmed = true;
  click(addButton());
  const put = await transfer.promise;
  expect(put.credentials).toBe("omit");
  expect(
    [...put.headers.keys()].filter((key) => {
      return /checksum|content-md5/i.test(key);
    }),
  ).toStrictEqual([]);
  await expect(put.text()).resolves.toBe("note");
  expect(screen.getByText("Adding…", { selector: "button" })).toBeDisabled();
  expect(screen.getByText("Cancel", { selector: "button" })).toBeDisabled();
  expect(screen.getByLabelText(document.label)).toBeDisabled();
  complete.resolve();
  await screen.findByText("Agent notified");
  await expect(request.applied.promise).resolves.toStrictEqual([
    {
      key: document.key,
      operation: "replace",
      files: [{ name: file.name, size: 4, type: file.type }],
      observedFingerprint: fingerprint,
    },
  ]);
});

test.each([
  { id: "014", required: false, expected: [] },
  {
    id: "015",
    required: true,
    expected: [
      {
        key: "attachment",
        operation: "keep" as const,
        files: [],
        observedFingerprint: fingerprint,
      },
    ],
  },
])(
  "browser-user-action-page-$id submitting a populated file control with required=$required preserves the website file",
  async ({ required, expected }) => {
    const request = browserRequest([documentField(required, true)]);
    await request.open();
    await screen.findByText(/old\.txt \(8 B\)/);
    await expect(submit(request)).resolves.toStrictEqual(expected);
  },
);

test("browser-user-action-page-016 email can be applied and its chat notified during a pending preflight", async () => {
  const request = browserRequest([account]);
  const started = context.mocks.deferred<void>();
  const checked = context.mocks.deferred<void>();
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ respond }) => {
      started.resolve();
      await checked.promise;
      return respond(200, request.record);
    },
  );
  await request.open();
  await started.promise;
  await screen.findByLabelText("Checking this request…");
  try {
    await fill(screen.getByLabelText(account.label), email);
    await expect(submit(request)).resolves.toStrictEqual([
      { key: account.key, value: email },
    ]);
  } finally {
    checked.resolve();
  }
});

test("browser-user-action-page-017 preflight supplies a multiple-address input and preserves line breaks from the notes area", async () => {
  const notes = {
    key: "notes",
    label: "Billing notes",
    fieldKind: "text",
    required: false,
    control: {
      tagName: "INPUT",
      inputType: "text",
    },
  } satisfies Field;
  const request = browserRequest([account, notes]);
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, {
      ...request.record,
      fields: [
        {
          ...account,
          control: { ...account.control, multiple: true, siteRequired: true },
        },
        {
          ...notes,
          control: { tagName: "TEXTAREA", inputType: "textarea", minLength: 3 },
        },
      ],
    });
  });
  await request.open();
  const multiline = await screen.findByLabelText(notes.label, {
    selector: "textarea",
  });
  expect(multiline).toHaveAttribute("minlength", "3");
  const emails = screen.getByLabelText(account.label, {
    selector: 'input[type="email"]',
  });
  expect(emails).toBeRequired();
  expect(emails).toHaveAttribute("multiple");
  await fill(emails, email);
  const value = "Invoice attached\nApprove this month";
  fireEvent.change(multiline, { target: { value } });
  await expect(submit(request)).resolves.toStrictEqual([
    { key: account.key, value: email },
    { key: notes.key, value },
  ]);
});

const quantity = {
  key: "quantity",
  label: "Quantity",
  fieldKind: "number",
  required: true,
  control: {
    tagName: "INPUT",
    inputType: "number",
    min: "10",
    max: "20",
    step: "0.5",
  },
} satisfies Field;
const arrival = {
  key: "arrival",
  label: "Arrival date",
  fieldKind: "date_time",
  required: false,
  control: {
    tagName: "INPUT",
    inputType: "date",
  },
} satisfies Field;
test("browser-user-action-page-018 the constrained required quantity accepts a half unit", async () => {
  const request = browserRequest([quantity]);
  await request.open();
  const input = await screen.findByLabelText(quantity.label, {
    selector: 'input[type="number"]',
  });
  expect(input).toBeRequired();
  await waitFor(() => {
    expect(input).toHaveAttribute("min", "10");
  });
  expect(input).toHaveAttribute("max", "20");
  expect(input).toHaveAttribute("step", "0.5");
  fireEvent.change(input, { target: { value: "12.5" } });
  await expect(submit(request)).resolves.toStrictEqual([
    { key: quantity.key, value: "12.5" },
  ]);
});
test.each([
  { id: "019", optional: { ...quantity, required: false } },
  { id: "026", optional: arrival },
])(
  "browser-user-action-page-$id leaving $optional.label empty omits it from the completed request",
  async ({ optional }) => {
    const request = browserRequest([optional]);
    await request.open();
    const input = await screen.findByLabelText(optional.label);
    expect(input).not.toBeRequired();
    expect(input).toHaveDisplayValue("");
    await expect(submit(request)).resolves.toStrictEqual([]);
  },
);
test("browser-user-action-page-021 picking a calendar day submits its local date", async () => {
  const request = browserRequest([arrival]);
  await request.open();
  const date = await screen.findByLabelText(arrival.label, {
    selector: 'input[type="date"]',
  });
  fireEvent.change(date, { target: { value: "2026-09-25" } });
  await expect(submit(request)).resolves.toStrictEqual([
    { key: arrival.key, value: "2026-09-25" },
  ]);
});

test("browser-user-action-page-028 revoking existing consent includes the observed checked state", async () => {
  const consent = {
    key: "consent",
    label: "Share receipts",
    fieldKind: "checkbox",
    required: false,
    control: {
      tagName: "INPUT",
      inputType: "checkbox",
      checked: true,
    },
  } satisfies Field;
  const request = browserRequest([consent]);
  await request.open();
  const box = await screen.findByLabelText(consent.label, {
    selector: '[role="checkbox"]',
  });
  await waitFor(() => {
    expect(addButton()).toBeEnabled();
  });
  expect(box).toBeChecked();
  click(box);
  expect(box).not.toBeChecked();
  await expect(submit(request)).resolves.toStrictEqual([
    { key: consent.key, checked: false, observedChecked: true },
  ]);
});
test("browser-user-action-page-034 the existing first radio choice satisfies an agent-required group", async () => {
  const method = {
    key: "method",
    label: "Delivery",
    fieldKind: "radio",
    required: true,
    control: {
      tagName: "INPUT",
      inputType: "radio",
      radioGroupFingerprint: fingerprint,
      radioOptions: [
        { index: 0, label: "Collect", selected: true, disabled: false },
        { index: 1, label: "Post", selected: false, disabled: false },
      ],
    },
  } satisfies Field;
  const request = browserRequest([method]);
  await request.open();
  await expect(screen.findByLabelText(/1\. Collect/)).resolves.toBeChecked();
  await expect(submit(request)).resolves.toStrictEqual([
    {
      key: method.key,
      memberIndex: 0,
      observedSelectedIndex: 0,
      groupFingerprint: fingerprint,
    },
  ]);
});
test("browser-user-action-page-036 changing a multiple selection drops the unavailable website choice", async () => {
  const choices = {
    key: "items",
    label: "Items",
    fieldKind: "select",
    required: true,
    control: {
      tagName: "SELECT",
      inputType: "select-multiple",
      multiple: true,
      optionSetFingerprint: fingerprint,
      options: ["First", "Unavailable", "Second"].map((label, index) => {
        return {
          index,
          label,
          selected: index !== 2,
          disabled: index === 1,
          empty: false,
        };
      }),
    },
  } satisfies Field;
  const request = browserRequest([choices]);
  await request.open();
  const list = await screen.findByLabelText(choices.label);
  const options = within(list);
  await expect(options.findByText("Unavailable")).resolves.toBeDisabled();
  expect(list).toHaveValue(["0", "1"]);
  expect(addButton()).toBeDisabled();
  await userEvent.selectOptions(list, options.getByText("Second"));
  await expect(submit(request)).resolves.toStrictEqual([
    {
      key: choices.key,
      optionIndexes: [0, 2],
      optionSetFingerprint: fingerprint,
    },
  ]);
});

test("browser-user-action-page-039 returning through history opens a fresh password and verification form", async () => {
  const request = browserRequest([password, code]);
  await request.open();
  const secret = await screen.findByLabelText(password.label);
  const otp = screen.getByLabelText(code.label);
  await fill(secret, "draft-password");
  await fill(otp, "563491");
  expect(secret).toHaveValue("draft-password");
  expect(otp).toHaveValue("563491");
  const brand = queryAllByRoleFast("link").find((link) => {
    return within(link).queryByAltText("Okou") !== null;
  });
  if (!brand) {
    throw new Error("Missing Okou navigation link");
  }
  click(brand);
  await waitFor(() => {
    expect(window.location.pathname).toBe("/connectors");
  });
  await waitFor(() => {
    expect(screen.queryByLabelText(password.label)).not.toBeInTheDocument();
  });
  window.history.back();
  await expect(screen.findByLabelText(password.label)).resolves.toHaveValue("");
  expect(screen.getByLabelText(code.label)).toHaveValue("");
});

test("browser-user-action-page-040 cancellation records the terminal decision before the callback reaches the chat", async () => {
  const request = browserRequest([account]);
  await request.open();
  click(await screen.findByText("Cancel", { selector: "button" }));
  await screen.findByText("Agent notified");
  await expect(request.callback.promise).resolves.toStrictEqual({
    state: "cancelled",
    threadId,
    prompt: "The user cancelled the browser input request.",
  });
});

test("browser-user-action-page-041 a failed chat callback preserves the successful browser result and removes entered credentials", async () => {
  const request = browserRequest([account, password, code]);
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Chat unavailable" },
    });
  });
  await request.open();
  const credentials = [
    [account, email],
    [password, "private-invoice"],
    [code, "647301"],
  ] as const;
  for (const [descriptor, value] of credentials) {
    await fill(await screen.findByLabelText(descriptor.label), value);
  }
  click(addButton());
  await screen.findByText("Information added");
  await screen.findByText(/Chat unavailable/);
  await expect(request.applied.promise).resolves.toStrictEqual(
    credentials.map(([descriptor, value]) => {
      return { key: descriptor.key, value };
    }),
  );
  for (const [descriptor, value] of credentials) {
    expect(screen.queryByLabelText(descriptor.label)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(value)).not.toBeInTheDocument();
    expect(screen.queryByText(value)).not.toBeInTheDocument();
  }
});

test("browser-user-action-page-047 an uncertain application takes its sensitive inputs off the page", async () => {
  const request = browserRequest([password, code]);
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    request.applied.resolve(body.values);
    return respond(200, request.transition("uncertain"));
  });
  await request.open();
  const values = [
    { key: password.key, value: "temporary-invoice-pass" },
    { key: code.key, value: "827501" },
  ];
  await fill(await screen.findByLabelText(password.label), values[0]!.value);
  await fill(screen.getByLabelText(code.label), values[1]!.value);
  click(addButton());
  await screen.findByText("Check the browser");
  await expect(request.applied.promise).resolves.toStrictEqual(values);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  for (const { value } of values) {
    expect(screen.queryByDisplayValue(value)).not.toBeInTheDocument();
    expect(screen.queryByText(value)).not.toBeInTheDocument();
  }
});

test.each([
  { id: "049", state: "succeeded" as const, result: "Information added" },
  { id: "051", state: "stale" as const, result: "Fields changed" },
])(
  "browser-user-action-page-$id the opening status check settles as $state",
  async ({ state, result }) => {
    const request = browserRequest([account], { state: "applying" });
    const subscription = context.mocks.ably.deferSubscribeOnChannel(
      "user:test-user-123",
      "browserUserActionChanged:" + threadId,
    );
    await request.open();
    await screen.findByText("Checking browser status");
    await subscription.started;
    request.record.state = state;
    subscription.attach();
    await screen.findByText(result);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  },
);

test("browser-user-action-page-053 the target thread signals an uncertain outcome while its page is checking status", async () => {
  const request = browserRequest([account], { state: "applying" });
  const subscription = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "browserUserActionChanged:" + threadId,
  );
  await request.open();
  await screen.findByText("Checking browser status");
  await subscription.started;
  const initialCheck = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let changed = false;
  context.mocks.api(browserUserActionsContract.get, async ({ respond }) => {
    if (!changed) {
      initialCheck.resolve();
      await release.promise;
      return respond(200, { ...request.record, state: "applying" });
    }
    return respond(200, { ...request.record, state: "uncertain" });
  });
  subscription.attach();
  await initialCheck.promise;
  try {
    changed = true;
    request.announce();
    await screen.findByText("Check the browser");
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  } finally {
    release.resolve();
  }
});

test("An email-only request shows the fallback heading and notifies its chat", async () => {
  const request = browserRequest([account]);
  await request.open();
  const heading = await screen.findByRole("heading", {
    name: "Enter information in browser",
  });
  const form = within(screen.getByRole("form", { name: heading.textContent! }));
  expect(
    form.queryByText("Enter information in browser", { selector: "p" }),
  ).not.toBeInTheDocument();
  await fill(form.getByLabelText(account.label), email);
  await expect(submit(request)).resolves.toStrictEqual([
    { key: account.key, value: email },
  ]);
  await expect(request.callback.promise).resolves.toMatchObject({
    threadId,
    prompt: callbackPrompt,
  });
});

test("A pending standalone field is withdrawn when preflight finds changed fields", async () => {
  const request = browserRequest([account]);
  const inspecting = context.mocks.deferred<void>();
  const changed = context.mocks.deferred<void>();
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ respond }) => {
      inspecting.resolve();
      await changed.promise;
      request.transition("stale");
      return respond(409, {
        error: { code: "FIELDS_CHANGED", message: "The target changed" },
      });
    },
  );
  await request.open();
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        "user:test-user-123",
        "browserUserActionChanged:" + threadId,
      ),
    ).toBeTruthy();
  });
  await inspecting.promise;
  const address = await screen.findByLabelText(account.label);
  await fill(address, "reviewer@example.test");
  expect(address).toHaveValue("reviewer@example.test");
  changed.resolve();
  await screen.findByText("Fields changed");
  expect(
    screen.getByText("Ask the agent to create a new request."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(address).not.toBeInTheDocument();
});
