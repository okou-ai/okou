import { expect, test, vi } from "vitest";
import { testContext } from "../../__tests__/test-helpers.ts";
import { resetSignal } from "../../utils.ts";
import {
  landingFileReturnUrl,
  landingFileSource,
  readLandingFiles,
} from "../landing-file-handoff.ts";

const app = "https://pr-44425-app-okou-app-preview.vm0.workers.dev";
const source = "https://pr-848-www.omby.ai/en/tools/pdf-to-ppt";
const id = "f0000000-0000-4000-a000-000000000001";
const context = testContext();

test("pairs separately numbered previews and preserves the pair when returning to files", () => {
  expect(landingFileSource(source, app)?.toString()).toBe(source);
  expect(landingFileReturnUrl(new URL(source), id, app)).toBe(
    `${source}?fileDraft=${id}&appPreview=44425`,
  );
});

test.each([
  [source, "https://app.okou.ai"],
  ["https://pr-848-www.omby.ai.evil.example/files", app],
  ["https://user@pr-848-www.omby.ai/files", app],
  ["http://pr-848-www.omby.ai/files", app],
  [`${source}?redirect=evil`, app],
  [`${source}#fragment`, app],
  ["https://www.okou.ai:444/files", "https://app.okou.ai"],
])("rejects an untrusted file source %s for %s", (landing, receiving) => {
  expect(landingFileSource(landing, receiving)).toBeNull();
});

test("aborting a transfer closes its window and removes the message listener", async () => {
  const reset$ = resetSignal();
  const signal = context.store.set(reset$, context.signal);
  const open = vi.spyOn(window, "open").mockReturnValue(window);
  const close = vi.spyOn(window, "close").mockImplementation(() => {});
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  const result = readLandingFiles(new URL(source), id, signal);
  expect(open).toHaveBeenCalledOnce();
  const address = open.mock.calls[0][0];
  if (!address) {
    throw new Error("Expected a transfer window");
  }
  const nonce = new URL(String(address)).hash.slice(1);
  const ready = () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: new URL(source).origin,
        source: window,
        data: { type: "okou:landing-files:ready", nonce },
      }),
    );
  };
  ready();
  expect(post).toHaveBeenCalledExactlyOnceWith(
    { type: "okou:landing-files:read", id, nonce },
    new URL(source).origin,
  );
  context.store.set(reset$);
  await expect(result).rejects.toThrow(/abort/iu);
  expect(close).toHaveBeenCalledOnce();
  ready();
  expect(post).toHaveBeenCalledOnce();
});
