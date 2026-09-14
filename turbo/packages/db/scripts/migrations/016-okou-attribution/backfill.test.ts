import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { googleAdsAccountForAttribution } from "@okouai/core/google-ads-account";
import { runBackfill } from "./backfill";
import { object } from "./model";

const server = setupServer();
let directory: string;
let controller: AbortController;

beforeAll(() => {
  return server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => {
  return server.close();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-attribution-"));
  controller = new AbortController();
  vi.stubEnv("CLERK_SECRET_KEY", "test-clerk-key");
  vi.stubEnv("STRIPE_SECRET_KEY", "test-stripe-key");
  server.use(
    http.get("https://api.clerk.com/v1/instance", () => {
      return HttpResponse.json({
        id: "ins_test",
        environment_type: "development",
      });
    }),
    http.get("https://api.stripe.com/v1/account", () => {
      return HttpResponse.json({ id: "acct_test" });
    }),
    http.get("https://api.stripe.com/v1/balance", () => {
      return HttpResponse.json({ livemode: false });
    }),
  );
});
afterEach(async () => {
  controller.abort();
  server.resetHandlers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function run(...args: string[]) {
  return runBackfill([...args, "--interval-ms", "0"], controller.signal);
}

// The external Clerk metadata endpoint deep-merges JSON objects.
function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child = object(target[key] ?? {});
      merge(child, object(value));
      target[key] = child;
    } else target[key] = value;
  }
}

function clerk(initial: Record<string, unknown>, total = 1) {
  const users = Array.from({ length: total }, (_, index) => {
    return {
      id: `user_${String(index).padStart(4, "0")}`,
      private_metadata: index === 0 ? structuredClone(initial) : {},
    };
  });
  const writes: unknown[] = [];
  server.use(
    http.get("https://api.clerk.com/v1/users", ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("created_at_before")).toMatch(/^\d+$/u);
      const offset = Number(params.get("offset"));
      return HttpResponse.json(users.slice(offset, offset + 100));
    }),
    http.get("https://api.clerk.com/v1/users/:id", ({ params }) => {
      const user = users.find((candidate) => {
        return candidate.id === params.id;
      });
      return user
        ? HttpResponse.json(user)
        : new HttpResponse(null, { status: 404 });
    }),
    http.patch(
      "https://api.clerk.com/v1/users/:id/metadata",
      async ({ params, request }) => {
        const user = users.find((candidate) => {
          return candidate.id === params.id;
        });
        if (!user) return new HttpResponse(null, { status: 404 });
        const body = object(await request.json());
        writes.push(body);
        merge(user.private_metadata, object(body.private_metadata));
        return HttpResponse.json(user);
      },
    ),
  );
  return { users, writes };
}

const touch = {
  vm0_campaign_id: "24239997272",
  vm0_ad_group_id: "123456",
  gclid: "first-click",
  recorded_at: "2026-09-11T02:00:00Z",
  vm0_source: "presentation",
};

describe("attribution migration command", () => {
  it("inventories every historical Clerk user and preserves first touch and every delivery state on rerun", async () => {
    const history = Object.fromEntries(
      ["uploaded", "submitted", "pending_account", "failed", "validated"].map(
        (status) => {
          return [
            status,
            {
              status,
              request_id: `request-${status}`,
              event_time: "2026-09-11T03:00:00Z",
              attribution: {
                vm0_campaign_id: "24239997272",
                gclid: "original-event-click",
              },
            },
          ];
        },
      ),
    );
    const metadata = {
      signup_attribution: touch,
      google_data_manager_acquisition_conversions: history,
      unrelated: "preserve-me",
    };
    const mock = clerk(metadata, 101);
    const file = join(directory, "clerk.json");
    expect(await run("--source", "clerk", "--output", file)).toMatchObject({
      records: 101,
      candidates: 1,
      additions: 7,
      conflicts: 0,
    });
    expect(mock.writes).toHaveLength(0);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const args = [
      "--migrate",
      "--plan",
      file,
      "--writers-quiesced",
      "--identity",
      "ins_test:development",
      "--limit",
      "200",
    ];
    expect(await run(...args)).toMatchObject({
      applied: 1,
      unchanged: 100,
      batchComplete: true,
    });
    expect(mock.writes).toHaveLength(1);
    expect(mock.users[0]?.private_metadata).toMatchObject({
      ...metadata,
      signup_attribution: {
        ...touch,
        okou_campaign_id: "24239997272",
        okou_ad_group_id: "123456",
      },
    });
    expect(mock.writes[0]).toEqual({
      private_metadata: {
        signup_attribution: {
          okou_campaign_id: "24239997272",
          okou_ad_group_id: "123456",
        },
        google_data_manager_acquisition_conversions: Object.fromEntries(
          Object.keys(history).map((key) => {
            return [key, { attribution: { okou_campaign_id: "24239997272" } }];
          }),
        ),
      },
    });
    const stored = object(mock.users[0]?.private_metadata.signup_attribution);
    expect(googleAdsAccountForAttribution(touch)).toBe("7935750692");
    expect(
      googleAdsAccountForAttribution({
        vm0_campaign_id: String(stored.vm0_campaign_id),
        okou_campaign_id: String(stored.okou_campaign_id),
      }),
    ).toBe("7935750692");
    expect(await run(...args)).toMatchObject({ applied: 0, unchanged: 101 });
    expect(await run("--verify", "--plan", file)).toMatchObject({
      complete: true,
      matches: true,
      candidates: 0,
    });
    expect(mock.writes).toHaveLength(1);
    expect(await readFile(`${file}.journal.jsonl`, "utf8")).toContain(
      '"status":"verified"',
    );
  });

  it.each([
    { ...touch, okou_campaign_id: "24154967178" },
    { ...touch, vm0_campaign_id: " 24239997272 " },
    { ...touch, vm0_campaign_id: ["24239997272"] },
    null,
  ])(
    "retains conflicting or malformed source evidence without a write: %j",
    async (saved) => {
      const mock = clerk({ signup_attribution: saved });
      const file = join(directory, "conflict.json");
      expect(await run("--source", "clerk", "--output", file)).toMatchObject({
        candidates: 0,
        conflicts: 1,
      });
      await expect(
        run(
          "--migrate",
          "--plan",
          file,
          "--writers-quiesced",
          "--identity",
          "ins_test:development",
        ),
      ).rejects.toThrow("Resolve inventory conflicts");
      expect(await run("--verify", "--plan", file)).toMatchObject({
        complete: false,
        conflicts: 1,
      });
      expect(mock.writes).toHaveLength(0);
      expect(mock.users[0]?.private_metadata.signup_attribution).toEqual(saved);
    },
  );

  it("requires the reviewed source and quiesced writers, then detects pre-write drift", async () => {
    const mock = clerk({ signup_attribution: touch });
    const file = join(directory, "plan.json");
    await run("--source", "clerk", "--output", file);
    await expect(run("--migrate", "--plan", file)).rejects.toThrow(
      "writers-quiesced",
    );
    server.use(
      http.get("https://api.clerk.com/v1/instance", () => {
        return HttpResponse.json({
          id: "ins_other",
          environment_type: "development",
        });
      }),
    );
    await expect(
      run(
        "--migrate",
        "--plan",
        file,
        "--writers-quiesced",
        "--identity",
        "ins_test:development",
      ),
    ).rejects.toThrow("identity");
    server.use(
      http.get("https://api.clerk.com/v1/instance", () => {
        return HttpResponse.json({
          id: "ins_test",
          environment_type: "development",
        });
      }),
    );
    const first = mock.users[0];
    if (!first) throw new Error("Missing test user");
    first.private_metadata.signup_attribution = {
      ...touch,
      gclid: "changed-click",
    };
    await expect(
      run(
        "--migrate",
        "--plan",
        file,
        "--writers-quiesced",
        "--identity",
        "ins_test:development",
      ),
    ).rejects.toThrow("drifted");
    expect(mock.writes).toHaveLength(0);
  });

  it("resumes an uncertain successful write by readback without replaying the mutation", async () => {
    const mock = clerk({ signup_attribution: touch });
    const file = join(directory, "plan.json");
    await run("--source", "clerk", "--output", file);
    let writes = 0;
    server.use(
      http.patch(
        "https://api.clerk.com/v1/users/:id/metadata",
        async ({ request }) => {
          writes++;
          const first = mock.users[0];
          if (!first) throw new Error("Missing test user");
          merge(
            first.private_metadata,
            object(object(await request.json()).private_metadata),
          );
          return new HttpResponse(null, { status: 503 });
        },
      ),
    );
    const args = [
      "--migrate",
      "--plan",
      file,
      "--writers-quiesced",
      "--identity",
      "ins_test:development",
    ];
    await expect(run(...args)).rejects.toThrow("PATCH failed (503)");
    expect(writes).toBe(1);
    expect(await run(...args)).toMatchObject({ applied: 0, unchanged: 1 });
    expect(writes).toBe(1);
    expect(await run("--verify", "--plan", file)).toMatchObject({
      complete: true,
    });
  });

  it("retries a read rate limit without turning it into an absent record", async () => {
    const mock = clerk({ signup_attribution: touch });
    let throttled = false;
    server.use(
      http.get("https://api.clerk.com/v1/users", () => {
        if (!throttled) {
          throttled = true;
          return new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return HttpResponse.json(mock.users);
      }),
    );
    expect(
      await run(
        "--source",
        "clerk",
        "--output",
        join(directory, "throttled.json"),
      ),
    ).toMatchObject({ records: 1, candidates: 1 });
    expect(mock.writes).toHaveLength(0);
  });

  it("stops when readback changes a first-touch field", async () => {
    const mock = clerk({ signup_attribution: touch });
    const file = join(directory, "changed-after-write.json");
    await run("--source", "clerk", "--output", file);
    server.use(
      http.patch(
        "https://api.clerk.com/v1/users/:id/metadata",
        async ({ request }) => {
          const user = mock.users[0];
          if (!user) throw new Error("Missing test user");
          merge(
            user.private_metadata,
            object(object(await request.json()).private_metadata),
          );
          user.private_metadata.signup_attribution = {
            ...object(user.private_metadata.signup_attribution),
            recorded_at: "2026-09-14T00:00:00Z",
          };
          return HttpResponse.json(user);
        },
      ),
    );
    await expect(
      run(
        "--migrate",
        "--plan",
        file,
        "--writers-quiesced",
        "--identity",
        "ins_test:development",
      ),
    ).rejects.toThrow("Post-write reconciliation failed");
    expect(await run("--verify", "--plan", file)).toMatchObject({
      complete: false,
      matches: false,
    });
  });

  it("rejects source churn instead of publishing an incomplete census", async () => {
    clerk({ signup_attribution: touch });
    let scans = 0;
    server.use(
      http.get("https://api.clerk.com/v1/users", () => {
        return HttpResponse.json([
          { id: `user_${++scans}`, private_metadata: {} },
        ]);
      }),
    );
    const file = join(directory, "unstable.json");
    await expect(run("--source", "clerk", "--output", file)).rejects.toThrow(
      "Source changed",
    );
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates Stripe metadata in bounded batches without changing billing or delivery receipts", async () => {
    const resources = [
      "customers",
      "subscriptions",
      "checkout/sessions",
      "invoices",
    ];
    const records = resources.map((resource, i) => {
      return {
        resource,
        id: `object_${i}`,
        metadata: {
          vm0_campaign_id: "24240467199",
          vm0_ad_group_id: "789",
          gdm_vm0_campaign_id: "24239997272",
          gdm_gclid: "invoice-click",
          gdm_status: "submitted",
          gdm_request_id: "receipt-id",
          gdm_event_time: "2026-09-11T00:00:00Z",
          checkout_source: "onboarding",
        },
      };
    });
    const writes: URLSearchParams[] = [];
    for (const resource of resources) {
      server.use(
        http.get(`https://api.stripe.com/v1/${resource}`, ({ request }) => {
          expect(new URL(request.url).searchParams.get("created[lt]")).toMatch(
            /^\d+$/u,
          );
          if (resource === "subscriptions")
            expect(new URL(request.url).searchParams.get("status")).toBe("all");
          return HttpResponse.json({
            data: records.filter((row) => {
              return row.resource === resource;
            }),
            has_more: false,
          });
        }),
        http.get(`https://api.stripe.com/v1/${resource}/:id`, ({ params }) => {
          return HttpResponse.json(
            records.find((row) => {
              return row.id === params.id;
            }),
          );
        }),
        http.post(
          `https://api.stripe.com/v1/${resource}/:id`,
          async ({ request, params }) => {
            const row = records.find((item) => {
              return item.id === params.id;
            });
            if (!row) return new HttpResponse(null, { status: 404 });
            const form = new URLSearchParams(await request.text());
            writes.push(form);
            expect(request.headers.get("Idempotency-Key")).toMatch(
              /^okou-attribution-/u,
            );
            for (const [key, value] of form)
              Object.assign(row.metadata, { [key.slice(9, -1)]: value });
            return HttpResponse.json(row);
          },
        ),
      );
    }
    const file = join(directory, "stripe.json");
    expect(await run("--source", "stripe", "--output", file)).toMatchObject({
      records: 4,
      candidates: 4,
    });
    const args = [
      "--migrate",
      "--plan",
      file,
      "--writers-quiesced",
      "--identity",
      "acct_test:test",
      "--limit",
      "2",
    ];
    expect(await run(...args)).toMatchObject({
      applied: 2,
      nextOffset: 2,
      batchComplete: false,
    });
    expect(await run(...args, "--offset", "2")).toMatchObject({
      applied: 2,
      nextOffset: 4,
      batchComplete: true,
    });
    expect(await run(...args)).toMatchObject({ applied: 0, unchanged: 2 });
    expect(writes).toHaveLength(4);
    for (const form of writes)
      expect(Object.fromEntries(form)).toEqual({
        "metadata[okou_campaign_id]": "24240467199",
        "metadata[okou_ad_group_id]": "789",
        "metadata[gdm_okou_campaign_id]": "24239997272",
      });
    expect(await run("--verify", "--plan", file)).toMatchObject({
      complete: true,
      matches: true,
    });
  });
});
