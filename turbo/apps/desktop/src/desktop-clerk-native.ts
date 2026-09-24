import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

export interface NativeClerkOrganization {
  readonly id: string;
  readonly name: string;
}

interface PendingRequest {
  readonly child: ChildProcessWithoutNullStreams;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Only the Electron main process may speak to the native auth owner. */
export class DesktopClerkNative {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly publishableKey: string,
    private readonly executable = path.join(
      path.dirname(process.execPath),
      "clerk-auth-helper",
    ),
  ) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(this.executable, [], {
      env: {
        ...process.env,
        OKOU_DESKTOP_CLERK_PUBLISHABLE_KEY: this.publishableKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof payload !== "object" || payload === null || !("id" in payload))
        return;
      const id = payload.id;
      if (typeof id !== "number") return;
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if ("error" in payload && typeof payload.error === "string") {
        request.reject(new Error(payload.error));
      } else if ("result" in payload) {
        request.resolve(payload.result);
      } else {
        request.reject(new Error("Native Clerk response was unusable"));
      }
    });
    const fail = (error: Error) => {
      if (this.child === child) this.child = null;
      for (const [id, request] of this.pending) {
        if (request.child !== child) continue;
        this.pending.delete(id);
        request.reject(error);
      }
      lines.close();
    };
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("exit", () => fail(new Error("Native Clerk helper exited")));
    return child;
  }

  private async request(
    command: string,
    values: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      signal?.throwIfAborted();
      const child = this.ensureChild();
      const id = ++this.nextId;
      return await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            this.pending.delete(id);
            settle.reject(new Error(`Native Clerk ${command} timed out`));
            if (this.child === child) this.child = null;
            child.kill();
          },
          command === "signIn" ? 10 * 60_000 : 30_000,
        );
        const abort = () => {
          this.pending.delete(id);
          settle.reject(new Error(`Native Clerk ${command} cancelled`));
          if (this.child === child) this.child = null;
          child.kill();
        };
        const settle: PendingRequest = {
          child,
          resolve: (value) => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        };
        this.pending.set(id, settle);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        child.stdin.write(`${JSON.stringify({ id, command, ...values })}\n`);
      });
    };
    const result = this.serial.then(run, run);
    this.serial = result.catch(() => {});
    return await result;
  }

  private async token(
    command: "token" | "signIn" | "setOrganization",
    values?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await this.request(command, values, signal);
    if (typeof result !== "object" || result === null || !("token" in result))
      throw new Error("Native Clerk token response was unusable");
    if (result.token === null) return null;
    if (typeof result.token !== "string" || !result.token)
      throw new Error("Native Clerk token response was unusable");
    return result.token;
  }

  getToken(signal?: AbortSignal): Promise<string | null> {
    return this.token("token", undefined, signal);
  }

  signIn(signal?: AbortSignal): Promise<string | null> {
    return this.token("signIn", undefined, signal);
  }

  async organizations(
    signal?: AbortSignal,
  ): Promise<readonly NativeClerkOrganization[]> {
    const result = await this.request("organizations", {}, signal);
    if (
      typeof result !== "object" ||
      result === null ||
      !("organizations" in result) ||
      !Array.isArray(result.organizations)
    )
      throw new Error("Native Clerk organizations response was unusable");
    return result.organizations.map((value: unknown) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        !("name" in value) ||
        typeof value.id !== "string" ||
        typeof value.name !== "string"
      )
        throw new Error("Native Clerk organization was unusable");
      return { id: value.id, name: value.name };
    });
  }

  setOrganization(
    organizationId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return this.token("setOrganization", { organizationId }, signal);
  }

  async signOut(): Promise<void> {
    await this.request("signOut");
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }
}
