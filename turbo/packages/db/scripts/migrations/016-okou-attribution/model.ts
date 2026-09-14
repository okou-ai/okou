import { createHash } from "node:crypto";

export type Source = "clerk" | "stripe" | "database";
export type Resource =
  | "users"
  | "customers"
  | "subscriptions"
  | "checkout/sessions"
  | "invoices"
  | "org_metadata";
export interface Snapshot {
  resource: Resource;
  id: string;
  value: Record<string, unknown>;
}
export interface Inventory {
  version: 1;
  source: Source;
  identity: string;
  cutoff: number;
  records: Snapshot[];
}
interface Addition {
  path: string[];
  value: string;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a metadata object");
  }
  return Object.fromEntries(Object.entries(value));
}

function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          return a.localeCompare(b);
        })
        .map(([key, item]) => {
          return [key, stable(item)];
        }),
    );
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function setPath(
  target: Record<string, unknown>,
  path: string[],
  value: string,
) {
  const [key, ...rest] = path;
  if (!key) throw new Error("Empty attribution patch path");
  const next = rest.length > 0 ? object(target[key] ?? {}) : undefined;
  if (next) setPath(next, rest, value);
  Object.defineProperty(target, key, {
    value: next ?? value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function containersFor(snapshot: Snapshot, problems: string[]) {
  const containers: { path: string[]; value: unknown; prefix: string }[] = [];
  if (snapshot.resource === "users") {
    if (Object.hasOwn(snapshot.value, "signup_attribution")) {
      containers.push({
        path: ["signup_attribution"],
        value: snapshot.value.signup_attribution,
        prefix: "",
      });
    }
    const receipts = snapshot.value.google_data_manager_acquisition_conversions;
    if (receipts !== undefined) {
      if (
        !receipts ||
        typeof receipts !== "object" ||
        Array.isArray(receipts)
      ) {
        problems.push("invalid_delivery_history");
      } else {
        for (const [id, receipt] of Object.entries(receipts)) {
          if (
            !receipt ||
            typeof receipt !== "object" ||
            Array.isArray(receipt)
          ) {
            problems.push("invalid_delivery_receipt");
            continue;
          }
          const row = object(receipt);
          if (Object.hasOwn(row, "attribution")) {
            containers.push({
              path: [
                "google_data_manager_acquisition_conversions",
                id,
                "attribution",
              ],
              value: row.attribution,
              prefix: "",
            });
          }
        }
      }
    }
  } else if (snapshot.resource !== "org_metadata") {
    containers.push({ path: [], value: snapshot.value, prefix: "" });
    containers.push({ path: [], value: snapshot.value, prefix: "gdm_" });
  }
  return containers;
}

function validId(value: unknown) {
  return (
    value === undefined ||
    (typeof value === "string" && /^\d{1,100}$/u.test(value))
  );
}

function exceedsStripeCapacity(snapshot: Snapshot, additions: number) {
  return (
    snapshot.resource !== "users" &&
    snapshot.resource !== "org_metadata" &&
    Object.keys(snapshot.value).length + additions > 50
  );
}

/** Only add equal aliases. Never trim, resolve conflicts, or replace a touch. */
export function plan(snapshot: Snapshot) {
  const additions: Addition[] = [];
  const problems: string[] = [];
  for (const container of containersFor(snapshot, problems)) {
    if (
      !container.value ||
      typeof container.value !== "object" ||
      Array.isArray(container.value)
    ) {
      problems.push("invalid_attribution");
      continue;
    }
    const metadata = object(container.value);
    for (const field of ["campaign_id", "ad_group_id"]) {
      const oldKey = `${container.prefix}vm0_${field}`;
      const newKey = `${container.prefix}okou_${field}`;
      const legacy = metadata[oldKey];
      const canonical = metadata[newKey];
      if (legacy === undefined && canonical === undefined) continue;
      if (!validId(legacy) || !validId(canonical)) {
        problems.push(`invalid_${container.prefix}${field}`);
        continue;
      }
      if (
        legacy !== undefined &&
        canonical !== undefined &&
        legacy !== canonical
      ) {
        problems.push(`conflicting_${container.prefix}${field}`);
        continue;
      }
      if (typeof legacy === "string" && canonical === undefined) {
        additions.push({ path: [...container.path, newKey], value: legacy });
      }
    }
  }
  if (exceedsStripeCapacity(snapshot, additions.length)) {
    problems.push("stripe_metadata_limit");
  }
  const patch: Record<string, unknown> = {};
  const after = structuredClone(snapshot.value);
  if (problems.length === 0) {
    for (const addition of additions) {
      setPath(patch, addition.path, addition.value);
      setPath(after, addition.path, addition.value);
    }
  }
  return {
    patch,
    after,
    additions: problems.length ? 0 : additions.length,
    problems,
  };
}

export function snapshotKey(record: Snapshot) {
  return `${record.resource}:${record.id}`;
}

export function inventoryFingerprint(records: Snapshot[]) {
  return fingerprint(
    [...records].sort((a, b) => {
      return snapshotKey(a).localeCompare(snapshotKey(b));
    }),
  );
}

export function parseInventory(value: unknown): Inventory {
  const data = object(value);
  if (
    data.version !== 1 ||
    (data.source !== "clerk" &&
      data.source !== "stripe" &&
      data.source !== "database") ||
    typeof data.identity !== "string" ||
    !Number.isSafeInteger(data.cutoff) ||
    typeof data.cutoff !== "number" ||
    data.cutoff <= 0 ||
    !Array.isArray(data.records)
  )
    throw new Error("Invalid attribution inventory");
  const allowed: Record<Source, Resource[]> = {
    clerk: ["users"],
    stripe: ["customers", "subscriptions", "checkout/sessions", "invoices"],
    database: ["org_metadata"],
  };
  const source = data.source;
  const records = data.records.map((item): Snapshot => {
    const record = object(item);
    const resource = allowed[source].find((candidate) => {
      return candidate === record.resource;
    });
    if (
      !resource ||
      typeof record.id !== "string" ||
      !/^[\w-]+$/u.test(record.id)
    ) {
      throw new Error("Invalid inventory resource or identity");
    }
    return { resource, id: record.id, value: object(record.value) };
  });
  if (new Set(records.map(snapshotKey)).size !== records.length) {
    throw new Error("Duplicate inventory identity");
  }
  return {
    version: 1,
    source: data.source,
    identity: data.identity,
    cutoff: data.cutoff,
    records,
  };
}
