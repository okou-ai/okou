import { setTimeout as delay } from "node:timers/promises";
import {
  fingerprint,
  object,
  type Resource,
  type Snapshot,
  type Source,
} from "./model";

const CLERK = "https://api.clerk.com/v1";
const STRIPE = "https://api.stripe.com/v1";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function text(value: unknown) {
  if (typeof value !== "string" || !value)
    throw new Error("Missing provider identity");
  return value;
}

export class Provider {
  private lastRequest = 0;

  constructor(
    readonly source: Exclude<Source, "database">,
    private readonly interval: number,
  ) {}

  private async request(
    path: string,
    signal: AbortSignal,
    options?: RequestInit,
  ): Promise<unknown> {
    const base = this.source === "clerk" ? CLERK : STRIPE;
    const token = requiredEnv(
      this.source === "clerk" ? "CLERK_SECRET_KEY" : "STRIPE_SECRET_KEY",
    );
    const headers = new Headers(options?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    for (let attempt = 0; ; attempt++) {
      await delay(
        Math.max(0, this.lastRequest + this.interval - Date.now()),
        undefined,
        { signal },
      );
      this.lastRequest = Date.now();
      const response = await fetch(`${base}/${path}`, {
        ...options,
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: "error",
      });
      if (response.ok) return await response.json();
      // Never replay an uncertain mutation. A resumed batch re-reads the record.
      if (
        options?.method ||
        attempt >= 3 ||
        (response.status !== 429 && response.status < 500)
      ) {
        throw new Error(
          `${this.source} ${options?.method ?? "GET"} failed (${response.status})`,
        );
      }
      const retry = response.headers.get("retry-after");
      const seconds = retry === null ? Number.NaN : Number(retry);
      const retryMs =
        retry === null
          ? 0
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retry) - Date.now();
      const wait = Math.max(
        500 * 2 ** attempt + Math.random() * 250,
        Number.isFinite(retryMs) ? retryMs : 0,
      );
      if (wait > 60_000)
        throw new Error(
          "Provider Retry-After exceeds the bounded retry window; resume later",
        );
      await response.arrayBuffer();
      await delay(wait, undefined, { signal });
    }
  }

  async identity(signal: AbortSignal): Promise<string> {
    if (this.source === "clerk") {
      const instance = object(await this.request("instance", signal));
      return `${text(instance.id)}:${text(instance.environment_type)}`;
    }
    const account = object(await this.request("account", signal));
    const balance = object(await this.request("balance", signal));
    if (typeof balance.livemode !== "boolean")
      throw new Error("Stripe mode is unavailable");
    return `${text(account.id)}:${balance.livemode ? "live" : "test"}`;
  }

  private snapshot(resource: Resource, raw: unknown): Snapshot {
    const row = object(raw);
    const id = text(row.id);
    if (!/^[\w-]+$/u.test(id)) throw new Error("Invalid provider object ID");
    if (resource === "users") {
      const metadata = object(row.private_metadata);
      return {
        resource,
        id,
        value: Object.fromEntries(
          [
            "signup_attribution",
            "google_data_manager_acquisition_conversions",
            "marketing_privacy_receipt",
          ]
            .filter((key) => {
              return Object.hasOwn(metadata, key);
            })
            .map((key) => {
              return [key, metadata[key]];
            }),
        ),
      };
    }
    return { resource, id, value: object(row.metadata) };
  }

  async scan(cutoff: number, signal: AbortSignal): Promise<Snapshot[]> {
    const result: Snapshot[] = [];
    const resources: Resource[] =
      this.source === "clerk"
        ? ["users"]
        : ["customers", "subscriptions", "checkout/sessions", "invoices"];
    for (const resource of resources) {
      let offset = 0;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const query = new URLSearchParams({ limit: "100" });
        if (this.source === "clerk") {
          query.set("offset", String(offset));
          query.set("order_by", "+created_at");
          query.set("created_at_before", String(cutoff * 1000));
        } else {
          query.set("created[lt]", String(cutoff));
          if (cursor) query.set("starting_after", cursor);
          if (resource === "subscriptions") query.set("status", "all");
        }
        const body = await this.request(`${resource}?${query}`, signal);
        const list = this.source === "clerk" ? body : object(body).data;
        if (!Array.isArray(list))
          throw new Error("Invalid provider list response");
        for (const raw of list) {
          const record = this.snapshot(resource, raw);
          if (seen.has(record.id))
            throw new Error("Provider pagination repeated an identity");
          seen.add(record.id);
          result.push(record);
        }
        if (this.source === "clerk") {
          offset += list.length;
          if (list.length < 100) break;
        } else {
          const hasMore = object(body).has_more;
          if (typeof hasMore !== "boolean")
            throw new Error("Missing Stripe pagination state");
          if (!hasMore) break;
          if (list.length === 0)
            throw new Error("Empty nonterminal Stripe page");
          cursor = text(object(list[list.length - 1]).id);
        }
      }
    }
    return result;
  }

  async read(record: Snapshot, signal: AbortSignal): Promise<Snapshot> {
    return this.snapshot(
      record.resource,
      await this.request(
        `${record.resource}/${encodeURIComponent(record.id)}`,
        signal,
      ),
    );
  }

  async write(
    record: Snapshot,
    patch: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const path = `${record.resource}/${encodeURIComponent(record.id)}`;
    if (this.source === "clerk") {
      await this.request(`${path}/metadata`, signal, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ private_metadata: patch }),
      });
    } else {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(patch))
        body.set(`metadata[${key}]`, text(value));
      await this.request(path, signal, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": `okou-attribution-${fingerprint(record)}`,
        },
        body,
      });
    }
  }
}
