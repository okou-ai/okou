import { randomUUID } from "node:crypto";
import {
  OkouBrowserClient,
  type CdpEvent,
} from "@okouai/browser-extension-client";
import { ControlWire, ProtocolError, record } from "./wire";

export interface TargetInfo extends Record<string, unknown> {
  readonly targetId: string;
  readonly type: string;
}

export function targetInfo(value: unknown): TargetInfo | null {
  return record(value) &&
    typeof value.targetId === "string" &&
    typeof value.type === "string"
    ? (value as TargetInfo)
    : null;
}

const CREATION_PREFIX = "about:blank#okou-cdp-create-";
export const outsideWindow = () => {
  return new ProtocolError({
    code: -32000,
    message: "The target is outside this chat's Browser window",
  });
};

/** Ownership observations are driven by discovery/native events, never input messages. */
export class WindowScope {
  readonly targets = new Map<string, TargetInfo>();
  private readonly membership = new Map<string, Promise<boolean>>();
  private readonly admitted = new Set<string>();
  private readonly descendants = new Map<
    string,
    { readonly parents: readonly string[] }
  >();
  private readonly creating = new Set<string>();
  private readonly preparingTabs = new Set<number>();
  private readonly created = new Map<string, string>();
  private readonly closingTargets = new Set<string>();
  private closing = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private stopped = false;
  private refreshQueued = false;
  private refreshing = Promise.resolve();
  private readonly off: (() => void)[];

  get revision(): number {
    return this.generation;
  }

  constructor(
    readonly wire: ControlWire,
    readonly native: OkouBrowserClient,
    readonly windowId: number,
    readonly stop: () => void,
    private readonly runtimeId: string,
    nativeSignal: AbortSignal,
  ) {
    const lost = () => {
      return stop();
    };
    nativeSignal.addEventListener("abort", lost, { once: true });
    wire.socket.addEventListener("close", lost, { once: true });
    this.off = [
      () => {
        return nativeSignal.removeEventListener("abort", lost);
      },
      () => {
        return wire.socket.removeEventListener("close", lost);
      },
      wire.onEvent((event) => {
        return this.event(event);
      }),
      native.onEvent((event) => {
        if (event.kind === "window-removed" && event.windowId === windowId)
          return stop();
        if (
          [
            "tab-attached",
            "tab-detached",
            "tab-replaced",
            "tab-removed",
          ].includes(event.kind) &&
          (event.windowId === windowId ||
            event.oldWindowId === windowId ||
            event.kind === "tab-replaced")
        ) {
          this.generation++;
          this.membership.clear();
          this.admitted.clear();
          this.scheduleRefresh();
        }
      }),
    ];
  }

  private event(event: CdpEvent): void {
    if (
      event.method === "Target.targetDestroyed" &&
      typeof event.params.targetId === "string"
    ) {
      this.forgetTarget(event.params.targetId);
    } else if (
      ["Target.targetCreated", "Target.targetInfoChanged"].includes(
        event.method,
      )
    ) {
      const info = targetInfo(event.params.targetInfo);
      if (info) {
        this.targets.set(info.targetId, info);
        this.scheduleRefresh();
      }
    }
  }

  private forgetTarget(id: string): void {
    this.targets.delete(id);
    this.membership.delete(id);
    this.admitted.delete(id);
    this.descendants.delete(id);
    this.created.delete(id);
    this.creating.delete(id);
    this.closingTargets.delete(id);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshQueued || this.stopped) return;
    this.refreshQueued = true;
    this.refreshing = this.refreshing
      .then(async () => {
        this.refreshQueued = false;
        await this.refresh();
      })
      .catch(this.stop);
  }

  async stable(): Promise<void> {
    let observation: Promise<void>;
    do {
      observation = this.refreshing;
      await observation;
    } while (observation !== this.refreshing);
  }

  async start(): Promise<void> {
    const window = (
      await this.native.call("getWindow", { windowId: this.windowId })
    ).value;
    if (window?.id !== this.windowId)
      throw new Error("Assigned Browser window is unavailable");
    await this.wire.request("Target.setDiscoverTargets", {
      discover: true,
      filter: [{}],
    });
    const result = await this.wire.request("Target.getTargets", {
      filter: [{}],
    });
    if (!record(result) || !Array.isArray(result.targetInfos))
      throw new Error("Browser inventory unavailable");
    for (const value of result.targetInfos) {
      const info = targetInfo(value);
      if (info) this.targets.set(info.targetId, info);
    }
    await this.refresh();
    await this.firstPage();
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    await Promise.all(
      [...this.targets.values()]
        .filter((info) => {
          return info.type !== "tab";
        })
        .map((info) => {
          return this.contains(info);
        }),
    );
    if (generation === this.generation && !this.stopped) {
      const observers = [...this.listeners];
      for (const listener of observers)
        if (this.listeners.has(listener)) listener();
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publicInfo(info: TargetInfo): TargetInfo {
    const url = this.created.get(info.targetId);
    return url !== undefined &&
      typeof info.url === "string" &&
      info.url.startsWith(CREATION_PREFIX)
      ? { ...info, url }
      : info;
  }

  /** A session can use cached admission while native ownership is unchanged. */
  admits(id: string): boolean {
    if (this.stopped || this.creating.has(id)) return false;
    const info = this.targets.get(id);
    if (!info || this.internal(info)) return false;
    if (this.admitted.has(id)) return true;
    const relation = this.descendants.get(id);
    return (
      relation !== undefined &&
      relation.parents.every((parent) => {
        return this.admits(parent);
      })
    );
  }

  private internal(info: TargetInfo): boolean {
    return (
      typeof info.url === "string" &&
      (info.url.startsWith("chrome-extension://" + this.runtimeId + "/") ||
        (info.url.startsWith(CREATION_PREFIX) &&
          !this.created.has(info.targetId)))
    );
  }

  /** Provenance comes from an admitted native parent or a scoped native selector. */
  inherit(info: TargetInfo, parents: readonly string[]): void {
    this.targets.set(info.targetId, info);
    if (info.type === "page" || info.type === "tab" || this.internal(info))
      return;
    const roots = [...new Set(parents)];
    if (
      !roots.length ||
      roots.some((parent) => {
        return !this.admits(parent);
      })
    )
      return;
    const prior = this.descendants.get(info.targetId);
    // Keep a still-valid, more precise provenance proof instead of replacing it
    // with the wider candidate set of another native selector.
    if (
      prior &&
      this.admits(info.targetId) &&
      prior.parents.every((parent) => {
        return roots.includes(parent);
      })
    )
      return;
    const visited = new Set<string>();
    if (
      roots.some((parent) => {
        return this.dependsOn(parent, info.targetId, visited);
      })
    )
      return;
    this.descendants.set(info.targetId, { parents: roots });
  }

  private dependsOn(
    id: string,
    ancestor: string,
    visited: Set<string>,
  ): boolean {
    if (id === ancestor) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return (
      this.descendants.get(id)?.parents.some((parent) => {
        return this.dependsOn(parent, ancestor, visited);
      }) ?? false
    );
  }

  contains(info: TargetInfo): Promise<boolean> {
    this.targets.set(info.targetId, info);
    if (this.stopped || this.creating.has(info.targetId) || this.internal(info))
      return Promise.resolve(false);
    if (this.admits(info.targetId)) return Promise.resolve(true);
    if (["browser", "service_worker", "shared_worker"].includes(info.type)) {
      this.admitted.add(info.targetId);
      return Promise.resolve(true);
    }
    if (info.type !== "page" && info.type !== "tab") {
      const opener =
        typeof info.openerId === "string" ? info.openerId : undefined;
      if (opener && this.admits(opener)) this.inherit(info, [opener]);
      return Promise.resolve(this.admits(info.targetId));
    }
    let pending = this.membership.get(info.targetId);
    if (!pending) {
      const generation = this.generation;
      pending = this.wire
        .request("Browser.getWindowForTarget", { targetId: info.targetId })
        .then(
          (value) => {
            if (!record(value) || typeof value.windowId !== "number")
              throw new Error("Invalid Browser window");
            if (this.stopped || !this.targets.has(info.targetId)) return false;
            // Invalidated observations are unknown, not proof that a live root
            // left. Join its current observation before retiring native sessions.
            if (generation !== this.generation)
              return this.allows(info.targetId);
            const allowed = value.windowId === this.windowId;
            if (allowed) this.admitted.add(info.targetId);
            return allowed;
          },
          async (error) => {
            // A missing target is expected during destruction; other native failures
            // must not silently turn a live owned target into an external one.
            if (
              error instanceof ProtocolError &&
              error.detail.code === -32000
            ) {
              const inventory = await this.wire.request("Target.getTargets", {
                filter: [{}],
              });
              if (
                record(inventory) &&
                Array.isArray(inventory.targetInfos) &&
                !inventory.targetInfos.some((value) => {
                  return targetInfo(value)?.targetId === info.targetId;
                })
              ) {
                this.forgetTarget(info.targetId);
                return false;
              }
            }
            throw error;
          },
        );
      this.membership.set(info.targetId, pending);
    }
    return pending;
  }

  allows(id: string): Promise<boolean> {
    const info = this.targets.get(id);
    return info ? this.contains(info) : Promise.resolve(false);
  }

  async firstPage(): Promise<string> {
    for (const info of this.targets.values())
      if (info.type === "page" && (await this.contains(info)))
        return info.targetId;
    throw new Error("Assigned Browser window has no page");
  }

  /** One close owner across peers; a pending native close is not a survivor. */
  closeTarget(id: string, close: () => Promise<unknown>): Promise<unknown> {
    const reserved = this.closingTargets.has(id);
    this.closingTargets.add(id);
    let dispatched = false;
    const operation = this.closing
      .then(async () => {
        await this.confirmWindow(id);
        let window;
        let revision: number;
        let closing: number;
        do {
          if (this.stopped)
            throw new Error("Assigned Browser window is unavailable");
          revision = this.generation;
          closing = this.closingTargets.size;
          window = (
            await this.native.call("getWindow", {
              windowId: this.windowId,
              populate: true,
            })
          ).value;
        } while (revision !== this.generation);
        if (window?.id !== this.windowId || !window.tabs?.length)
          throw new Error("Assigned Browser window is unavailable");
        // An unfinished creation can still be rolled back; internal control tabs
        // also cannot serve as the client's usable surviving page.
        const usable = window.tabs.filter((tab) => {
          const locations = [tab.url, tab.pendingUrl];
          return (
            !this.preparingTabs.has(tab.id) &&
            locations.some(Boolean) &&
            !locations.some((url) => {
              return (
                url?.startsWith(CREATION_PREFIX) ||
                url?.startsWith("chrome-extension://" + this.runtimeId + "/")
              );
            })
          );
        });
        // Keep the pre-query reservation count: retirement can overtake its reply.
        if (usable.length <= Math.max(closing, this.closingTargets.size)) {
          await this.create(
            { url: "about:blank", background: true },
            (params) => {
              return this.wire.request("Target.createTarget", params);
            },
          );
        }
        await this.confirmWindow(id);
        dispatched = true;
        const result = await close();
        if (!reserved && record(result) && result.success === false)
          this.closingTargets.delete(id);
        // A successful acknowledgement can precede destruction (Page.close may
        // also await beforeunload). Native retirement owns reservation release.
        return result;
      })
      .catch((error: unknown) => {
        // Once sent, a failed/disconnected reply does not prove that native close
        // was cancelled. Keep its reservation until authoritative retirement.
        if (!reserved && !dispatched) this.closingTargets.delete(id);
        throw error;
      });
    this.closing = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  private async confirmWindow(targetId: string): Promise<void> {
    if (this.stopped) throw new Error("Assigned Browser window is unavailable");
    const location = await this.wire.request("Browser.getWindowForTarget", {
      targetId,
    });
    if (!record(location) || typeof location.windowId !== "number")
      throw new Error("Invalid Browser window");
    if (location.windowId !== this.windowId) throw outsideWindow();
  }

  private async createdPage(
    marker: string,
  ): Promise<{ page: TargetInfo; inventory: (TargetInfo | null)[] }> {
    const inventory = await this.wire.request("Target.getTargets", {
      filter: [{}],
    });
    if (!record(inventory) || !Array.isArray(inventory.targetInfos))
      throw new Error("Invalid created inventory");
    const pages = inventory.targetInfos
      .map(targetInfo)
      .filter((info): info is TargetInfo => {
        return info !== null && info.type === "page" && info.url === marker;
      });
    if (pages.length !== 1)
      throw new Error("Created page correlation is unavailable");
    const page = pages[0]!;

    return { page, inventory: inventory.targetInfos.map(targetInfo) };
  }

  private async place(createdId: string, marker: string): Promise<number> {
    const location = await this.wire.request("Browser.getWindowForTarget", {
      targetId: createdId,
    });
    if (!record(location) || typeof location.windowId !== "number")
      throw new Error("Invalid created window");
    const window = (
      await this.native.call("getWindow", {
        windowId: location.windowId,
        populate: true,
      })
    ).value;
    const tabs = window?.tabs?.filter((tab) => {
      return tab.url === marker || tab.pendingUrl === marker;
    });
    if (tabs?.length !== 1)
      throw new Error("Created native tab correlation is unavailable");
    const tab = tabs[0]!;
    if (tab.windowId !== this.windowId) {
      const moved = (
        await this.native.call("moveTabs", {
          tabIds: [tab.id],
          windowId: this.windowId,
          index: -1,
        })
      ).value;
      if (
        moved.length !== 1 ||
        moved[0]?.id !== tab.id ||
        moved[0].windowId !== this.windowId
      )
        throw new Error("Created tab placement is unconfirmed");
    }
    return tab.id;
  }

  private async navigateCreated(targetId: string, url: string): Promise<void> {
    const attached = await this.wire.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (!record(attached) || typeof attached.sessionId !== "string")
      throw new Error("Created page session unavailable");
    try {
      await this.wire.request(
        "Page.navigate",
        { url: url },
        attached.sessionId,
      );
    } finally {
      await this.wire.request("Target.detachFromTarget", {
        sessionId: attached.sessionId,
      });
    }
  }

  async create(
    params: Record<string, unknown>,
    create: (params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    if (typeof params.url !== "string") return create(params);
    if (params.newWindow === true || params.hidden === true)
      throw outsideWindow();
    const first = this.targets.get(await this.firstPage())!;
    if (
      params.browserContextId !== undefined &&
      params.browserContextId !== first.browserContextId
    )
      throw outsideWindow();
    const marker = CREATION_PREFIX + randomUUID();
    let createdId: string | undefined;
    let createdPageId: string | undefined;
    let preparingTabId: number | undefined;
    try {
      const result = await create({ ...params, url: marker });
      if (!record(result) || typeof result.targetId !== "string")
        throw new Error("Invalid created target");
      createdId = result.targetId;
      this.creating.add(createdId);
      const { inventory, page } = await this.createdPage(marker);
      createdPageId = page.targetId;
      this.creating.add(page.targetId);
      preparingTabId = await this.place(createdId, marker);
      // Native URLs can commit before navigation/detach/membership completes.
      // Keep that exact tab out of close survivors until creation or rollback ends.
      this.preparingTabs.add(preparingTabId);
      await this.navigateCreated(page.targetId, params.url || "about:blank");
      this.targets.set(page.targetId, {
        ...page,
        url: params.url || "about:blank",
      });
      const createdInfo = inventory.find((info) => {
        return info?.targetId === createdId;
      });
      if (createdInfo) this.targets.set(createdId, createdInfo);
      this.created.set(createdId, params.url || "about:blank");
      this.created.set(page.targetId, params.url || "about:blank");
      this.creating.delete(page.targetId);
      this.creating.delete(createdId);
      this.membership.delete(createdId);
      this.membership.delete(page.targetId);
      if (!(await this.allows(createdId)))
        throw new Error("Created Browser target left its assigned window");
      this.scheduleRefresh();
      return result;
    } catch (error) {
      if (createdId) {
        try {
          await this.wire.request("Target.closeTarget", {
            targetId: createdId,
          });
        } catch {
          this.stop();
        }
      }
      throw error;
    } finally {
      if (preparingTabId !== undefined)
        this.preparingTabs.delete(preparingTabId);
      if (createdId) this.creating.delete(createdId);
      if (createdPageId) this.creating.delete(createdPageId);
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    for (const off of this.off) off();
    this.listeners.clear();
    this.admitted.clear();
    this.membership.clear();
    this.descendants.clear();
    this.creating.clear();
    this.preparingTabs.clear();
    this.created.clear();
    this.closingTargets.clear();
    this.targets.clear();
  }
}
