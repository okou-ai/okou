import type { ViewerTarget } from "../viewer/types.ts";
import { CdpClient } from "./client.ts";
import { CdpFault, isRecord, requestDetails } from "./errors.ts";
import type { OkouBrowserClient } from "@okouai/browser-extension-client";
import { nativeFault } from "./native.ts";

export function pageTarget(info: unknown): ViewerTarget | null {
  if (!isRecord(info) || info.type !== "page" || info.subtype === "prerender") {
    return null;
  }
  if (typeof info.targetId !== "string" || !info.targetId) {
    throw new CdpFault(
      "protocol",
      "The browser returned an invalid page target.",
    );
  }
  return Object.freeze({
    id: info.targetId,
    title:
      typeof info.title === "string" && info.title.trim()
        ? info.title.slice(0, 512)
        : "",
  });
}

export class TargetDirectory {
  private revision = 0;
  constructor(
    private readonly client: CdpClient,
    private readonly windowId: number | undefined,
    private readonly native: OkouBrowserClient,
  ) {}

  invalidate(): void {
    this.revision++;
  }

  async assertWindow(): Promise<void> {
    if (this.native.signal.aborted) {
      throw nativeFault();
    }
    if (this.windowId !== undefined) {
      const observation = await this.native.call("getWindow", {
        windowId: this.windowId,
      });
      if (observation.value?.id !== this.windowId) {
        throw new CdpFault(
          "scope",
          "The assigned browser window is unavailable.",
        );
      }
    }
  }

  async assertMember(targetId: string): Promise<void> {
    if (!(await this.contains(targetId))) {
      throw new CdpFault(
        "scope",
        "This target is outside the selected window.",
      );
    }
  }

  async contains(targetId: string): Promise<boolean> {
    if (this.native.signal.aborted) {
      throw nativeFault();
    }
    if (this.windowId === undefined) {
      return true;
    }
    const revision = this.revision;
    const result: unknown = await this.lookup(targetId);
    if (this.native.signal.aborted) {
      throw nativeFault();
    }
    if (revision !== this.revision) {
      throw new CdpFault(
        "scope",
        "Window membership changed during verification.",
      );
    }
    if (!isRecord(result) || !Number.isSafeInteger(result.windowId)) {
      throw new CdpFault(
        "scope",
        "The browser returned invalid window membership.",
      );
    }
    return result.windowId === this.windowId;
  }

  async read(): Promise<readonly ViewerTarget[]> {
    const raw: unknown = await this.client.request(
      "Target.getTargets",
      undefined,
    );
    if (!isRecord(raw) || !Array.isArray(raw.targetInfos)) {
      throw new CdpFault("protocol", "Invalid browser target list.");
    }
    const pages: ViewerTarget[] = [];
    for (const info of raw.targetInfos as unknown[]) {
      const page = pageTarget(info);
      if (page) {
        pages.push(page);
      }
    }
    return Object.freeze(pages);
  }

  private async lookup(targetId: string): Promise<unknown> {
    const [result] = await Promise.allSettled([
      this.client.request("Browser.getWindowForTarget", { targetId }),
    ]);
    if (result.status === "fulfilled") {
      return result.value;
    }
    const error: unknown = result.reason;

    throw new CdpFault(
      error instanceof CdpFault && error.code === -32_601
        ? "unsupported-capability"
        : "scope",
      "Window membership could not be verified. Scoped viewing is unavailable.",
      undefined,
      requestDetails(error),
    );
  }
}
