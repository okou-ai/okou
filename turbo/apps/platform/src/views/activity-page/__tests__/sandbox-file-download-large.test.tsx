import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  downloadBrowser,
  fileGuest,
  readyDownload,
} from "./sandbox-file-download-test-helpers.ts";
import { openFiles, setupFilesPage } from "./sandbox-files-test-helpers.ts";

const context = testContext();

test("A file above the complete-preview limit remains fully downloadable", async () => {
  const size = 16 * 1024 * 1024 + 19;
  const browser = await downloadBrowser(context);
  await setupFilesPage(context, { handler: fileGuest(size) });
  const files = await openFiles();
  await screen.findByText("report.bin");
  const control = await readyDownload(files);
  click(control);
  const result = await browser.outcome;
  expect(result.saved).toBeTruthy();
  expect((await stat(result.file)).size).toBe(size);
  const actual = createHash("sha256");
  for await (const chunk of createReadStream(result.file)) {
    actual.update(chunk);
  }
  const expected = createHash("sha256");
  // Reuse whole periods while keeping the oracle independent of the guest.
  const bytes = Buffer.alloc(251 * 128);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = index % 251;
  }
  for (let offset = 0; offset < size; offset += bytes.length) {
    expected.update(bytes.subarray(0, Math.min(bytes.length, size - offset)));
  }
  expect(actual.digest("hex")).toBe(expected.digest("hex"));
  await readyDownload(files);
});
