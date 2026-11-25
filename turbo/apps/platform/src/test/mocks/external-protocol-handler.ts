import { DetachedBrowserFrame } from "happy-dom";
import { vi } from "vitest";

// A registered OS handler receives these navigations and leaves the initiating
// document open. The browser resolves the URL and honors cancelled clicks.
export function externalProtocolHandler(
  protocol: "sms:" | "slack:" | "mailto:",
) {
  const received: string[] = [];
  const navigate = DetachedBrowserFrame.prototype.goto;
  vi.spyOn(DetachedBrowserFrame.prototype, "goto").mockImplementation(function (
    this: DetachedBrowserFrame,
    url,
    options,
  ) {
    if (url.startsWith(protocol)) {
      received.push(url);
      return Promise.resolve(null);
    }
    return navigate.call(this, url, options);
  });
  return received;
}
