import type { ViewerTarget } from "../viewer/types.ts";
import { CdpClient } from "./client.ts";
import { CdpFault, isRecord, requestDetails } from "./errors.ts";

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
  constructor(
    private readonly client: CdpClient,
    private readonly windowId: number | undefined,
  ) {}

  async assertMember(targetId: string): Promise<void> {
    if (!(await this.contains(targetId))) {
      throw new CdpFault(
        "scope",
        "This target is outside the selected window.",
      );
    }
  }

  async contains(targetId: string): Promise<boolean> {
    if (this.windowId === undefined) {
      return true;
    }
    const result: unknown = await this.lookup(targetId);
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

  async list(): Promise<readonly ViewerTarget[]> {
    const pages = await this.read();
    if (this.windowId === undefined) {
      return Object.freeze(pages);
    }

    const members: ViewerTarget[] = [];
    // Avoid an unbounded fan-out into the transport's request map.
    for (let offset = 0; offset < pages.length; offset += 4) {
      const results = await Promise.all(
        pages.slice(offset, offset + 4).map(async (page) => {
          const [membership] = await Promise.allSettled([
            this.contains(page.id),
          ]);
          if (membership.status === "fulfilled") {
            return membership.value ? page : null;
          }
          if (
            membership.reason instanceof CdpFault &&
            membership.reason.kind === "scope"
          ) {
            return null;
          }
          throw membership.reason;
        }),
      );
      for (const page of results) {
        if (page) {
          members.push(page);
        }
      }
    }
    return Object.freeze(members);
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
