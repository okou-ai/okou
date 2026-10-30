import type {
  OkouBrowserClient,
  NativeTab,
  NativeEvent,
} from "@okouai/browser-extension-client";
import { createDeferredPromise, scheduleTimeout } from "../../utils.ts";
import type { CdpClient, CdpEvent } from "./client.ts";
import { CdpFault, isRecord } from "./errors.ts";
import type { TargetDirectory } from "./targets.ts";

interface CreationOptions {
  readonly native: OkouBrowserClient;
  readonly windowId: number | undefined;
  readonly current: () => boolean;
}

interface CreationHost extends CreationOptions {
  readonly client: CdpClient;
  readonly directory: TargetDirectory;
}

/** A nonce joins only this owned creation. Existing pages always retain CDP IDs. */
export async function openTab(
  client: CdpClient,
  directory: TargetDirectory,
  options: CreationOptions,
  signal: AbortSignal,
): Promise<string> {
  return await new NativeTabCreation(
    { client, directory, ...options },
    signal,
  ).open();
}

/** All observations, temporary sessions and cleanup belong to one create attempt. */
class NativeTabCreation {
  private readonly marker: string;
  private readonly candidates = new Set<string>();
  private readonly movedTabs = new Set<number>();
  private readonly changed;
  private readonly observed;
  private readonly cleanups: (() => void)[] = [];
  private receipt: NativeTab | undefined;
  private attached: string | undefined;
  private targetId: string | undefined;
  private movementOverflow = false;
  private preparing = false;
  private pageChanged = false;

  constructor(
    private readonly host: CreationHost,
    private readonly signal: AbortSignal,
  ) {
    const token = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => {
        return byte.toString(16).padStart(2, "0");
      },
    ).join("");
    this.marker = `about:blank#okou-create-${token}`;
    this.changed = createDeferredPromise<void>(signal);
    this.observed = Promise.allSettled([this.changed.promise]);
  }

  private check(): void {
    if (!this.host.current() || this.signal.aborted) {
      throw new CdpFault("tab", "The tab action is no longer current.");
    }
    if (this.candidates.size > 1) {
      throw new CdpFault(
        "tab",
        "The new tab could not be identified unambiguously.",
      );
    }
    if (
      this.movementOverflow ||
      this.pageChanged ||
      (this.receipt && this.movedTabs.has(this.receipt.id))
    ) {
      throw new CdpFault(
        "tab",
        "The new tab moved or navigated before it was ready.",
      );
    }
  }

  private owned(tab: NativeTab | null): boolean {
    return (
      !!tab &&
      Number.isSafeInteger(tab.id) &&
      Number.isSafeInteger(tab.windowId) &&
      tab.id === this.receipt?.id &&
      tab.windowId === this.receipt.windowId &&
      (tab.pendingUrl ?? tab.url) === this.marker
    );
  }

  async open(): Promise<string> {
    using _subscriptions = {
      [Symbol.dispose]: () => {
        for (const cleanup of this.cleanups) {
          cleanup();
        }
        if (!this.changed.settled()) {
          this.changed.resolve();
        }
      },
    };
    this.check();
    this.cleanups.push(
      this.host.native.onEvent((event) => {
        this.nativeEvent(event);
      }),
    );
    this.cleanups.push(
      this.host.client.onEvent((event) => {
        this.targetEvent(event);
      }),
    );
    this.cleanups.push(
      scheduleTimeout(
        () => {
          if (!this.changed.settled()) {
            this.changed.reject(
              new CdpFault(
                "tab",
                "The new tab could not be identified. Check the browser before trying again.",
              ),
            );
          }
        },
        10_000,
        this.signal,
      ),
    );
    const [result] = await Promise.allSettled([this.create()]);
    if (this.attached) {
      this.detach({ sessionId: this.attached });
    }
    if (result.status === "fulfilled") {
      return result.value;
    }
    // A moved/navigated tab, missing receipt or uncertain create is never chased.
    await Promise.allSettled([this.cleanup()]);
    throw result.reason;
  }

  private inspect(info: unknown): void {
    if (
      isRecord(info) &&
      info.type === "page" &&
      info.url === this.marker &&
      typeof info.targetId === "string"
    ) {
      if (this.candidates.size < 2) {
        this.candidates.add(info.targetId);
      }
      if (!this.changed.settled()) {
        this.changed.resolve();
      }
    }
  }

  private targetEvent(event: CdpEvent): void {
    if (event.sessionId !== undefined) {
      return;
    }
    const info = event.params.targetInfo;
    if (this.targetId) {
      if (
        event.method === "Target.targetDestroyed" &&
        event.params.targetId === this.targetId
      ) {
        this.pageChanged = true;
      }
      if (
        !this.preparing &&
        event.method === "Target.targetInfoChanged" &&
        isRecord(info) &&
        info.targetId === this.targetId &&
        info.url !== this.marker
      ) {
        this.pageChanged = true;
      }
    }
    if (
      ["Target.targetCreated", "Target.targetInfoChanged"].includes(
        event.method,
      )
    ) {
      this.inspect(info);
    }
  }

  private nativeEvent(event: NativeEvent): void {
    if (
      !["tab-detached", "tab-attached", "tab-removed", "tab-replaced"].includes(
        event.kind,
      )
    ) {
      return;
    }
    for (const id of [event.tabId, event.removedTabId]) {
      if (id === undefined) {
        continue;
      }
      if (this.movedTabs.size >= 256) {
        this.movementOverflow = true;
      } else {
        this.movedTabs.add(id);
      }
    }
  }

  private async create(): Promise<string> {
    const { native, client, windowId } = this.host;
    this.receipt = (
      await native.call("createTab", {
        ...(windowId === undefined ? {} : { windowId }),
        url: this.marker,
      })
    ).value;
    this.check();
    if (
      !Number.isSafeInteger(this.receipt.id) ||
      !Number.isSafeInteger(this.receipt.windowId) ||
      (windowId !== undefined && this.receipt.windowId !== windowId)
    ) {
      throw new CdpFault("tab", "The native new-tab receipt is invalid.");
    }
    if (!this.candidates.size) {
      const targets = await client.request("Target.getTargets", undefined);
      this.check();
      for (const info of targets.targetInfos) {
        this.inspect(info);
      }
    }
    const [notification] = await this.observed;
    if (notification.status === "rejected") {
      throw notification.reason;
    }
    this.check();
    const [targetId] = this.candidates;
    if (this.candidates.size !== 1 || !targetId) {
      throw new CdpFault(
        "tab",
        "The new tab could not be identified unambiguously.",
      );
    }
    this.targetId = targetId;
    await this.prepare(targetId);
    return targetId;
  }

  private async verify(targetId: string): Promise<void> {
    const { native, client } = this.host;
    const tab = (await native.call("getTab", { tabId: this.receipt!.id }))
      .value;
    this.check();
    if (!this.owned(tab)) {
      throw new CdpFault(
        "tab",
        "The new tab moved or navigated before it was ready.",
      );
    }
    const { targetInfo } = await client.request("Target.getTargetInfo", {
      targetId,
    });
    this.check();
    if (
      targetInfo.type !== "page" ||
      targetInfo.url !== this.marker ||
      targetInfo.targetId !== targetId
    ) {
      throw new CdpFault("tab", "The new page changed before it was ready.");
    }
    const { windowId } = await client.request("Browser.getWindowForTarget", {
      targetId,
    });
    this.check();
    if (windowId !== this.receipt!.windowId) {
      throw new CdpFault("tab", "The new page moved before it was ready.");
    }
  }

  private async prepare(targetId: string): Promise<void> {
    const { client, native, directory } = this.host;
    await this.verify(targetId);
    const session = await client.request(
      "Target.attachToTarget",
      { targetId, flatten: true },
      undefined,
      (value) => {
        this.detach(value);
      },
    );
    if (typeof session.sessionId !== "string" || !session.sessionId) {
      throw new CdpFault(
        "tab",
        "The browser returned an invalid new-tab session.",
      );
    }
    this.attached = session.sessionId;
    this.check();
    await this.verify(targetId);
    this.check();
    this.preparing = true;
    const navigation = await client.request(
      "Page.navigate",
      { url: "about:blank" },
      this.attached,
    );
    this.check();
    if (navigation.errorText) {
      throw new CdpFault("tab", "The new tab could not be prepared.");
    }
    const tab = (await native.call("getTab", { tabId: this.receipt!.id }))
      .value;
    this.check();
    if (
      tab?.windowId !== this.receipt!.windowId ||
      (tab.pendingUrl ?? tab.url) !== "about:blank"
    ) {
      throw new CdpFault("tab", "The new tab changed before it was ready.");
    }
    await directory.assertMember(targetId);
    this.check();
  }

  private detach(value: unknown): void {
    if (isRecord(value) && typeof value.sessionId === "string") {
      this.host.client.notify("Target.detachFromTarget", {
        sessionId: value.sessionId,
      });
    }
  }

  private async cleanup(): Promise<void> {
    if (!this.receipt) {
      return;
    }
    const { native } = this.host;
    const tab = (await native.call("getTab", { tabId: this.receipt.id })).value;
    if (
      this.owned(tab) &&
      !this.movementOverflow &&
      !this.movedTabs.has(this.receipt.id)
    ) {
      await native.call("closeTab", { tabId: this.receipt.id });
    }
  }
}
