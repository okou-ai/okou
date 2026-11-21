// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { findAction } from "./connector-integrations-test-helpers.ts";
import { initSentry } from "../../../lib/sentry.ts";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
const context = testContext();
const filename = "private-recording.mp4",
  size = 5 * 1024 * 1024;
function storage() {
  const record = {
    id: crypto.randomUUID(),
    filename,
    contentType: "video/mp4",
    size,
    url: "https://cdn.example.org/video",
  };
  const endpoint =
    "https://upload.example.org/confidential/private-object?X-Amz-Signature=private-signature";
  context.mocks.api(uploadsContract.prepare, ({ respond }) => {
    return respond(200, {
      ...record,
      multipart: {
        uploadId: "movie",
        partSize: size,
        parts: [{ partNumber: 1, uploadUrl: endpoint }],
      },
    });
  });
  context.mocks.api(uploadsContract.completeMultipart, ({ respond }) => {
    return respond(200, record);
  });
  context.mocks.http.get("https://api.instatus.com/issues", () => {
    return HttpResponse.json([]);
  });
  const telemetry = context.mocks.sentry();
  initSentry();
  return telemetry;
}
async function attach() {
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  const input = await screen.findByLabelText("Attach", { selector: "input" });
  await userEvent
    .setup({ delay: null })
    .upload(
      input,
      new File([new Uint8Array(size)], filename, { type: "video/mp4" }),
    );
}
test("chat-upload-diagnostics-002 a failed video transfer can retry into a removable attachment", async () => {
  const telemetry = storage();
  const retry = context.mocks.deferred<void>();
  let recovered = false;
  context.mocks.http.put("https://upload.example.org/*", async () => {
    if (recovered) {
      await retry.promise;
      return new HttpResponse(null, { status: 200 });
    }
    recovered = true;
    return HttpResponse.error();
  });
  await attach();
  await expect(
    screen.findByRole("progressbar", { name: "Loading " + filename }),
  ).resolves.toBeVisible();
  retry.resolve();
  const remove = await findAction("button", "Remove " + filename);
  expect(remove).toBeEnabled();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(
    telemetry.reports.filter((r) => {
      return r.type === "exception";
    }),
  ).toStrictEqual([]);
});
