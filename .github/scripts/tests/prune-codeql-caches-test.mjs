import assert from "node:assert/strict";
import { test } from "node:test";
import prune from "../prune-codeql-caches.mjs";

function cache(id, overrides = {}) {
  return {
    id,
    key: `codeql-overlay-base-database-fixture-${id}`,
    ref: "refs/heads/main",
    created_at: new Date(id * 1000).toISOString(),
    size_in_bytes: 1024,
    ...overrides,
  };
}

function fixture(caches) {
  const store = new Map(caches.map((entry) => [entry.id, entry]));
  const input = {
    context: {
      eventName: "push",
      ref: "refs/heads/main",
      repo: { owner: "fixture", repo: "ci" },
    },
    core: { info() {} },
    github: {
      async paginate(route, options) {
        const all = [];
        for (let page = 1; ; page++) {
          const response = await route({ ...options, page });
          all.push(...response.data.actions_caches);
          if (response.data.actions_caches.length < options.per_page)
            return all;
        }
      },
      rest: {
        actions: {
          async getActionsCacheList({ page, per_page }) {
            const current = [...store.values()];
            return {
              data: {
                actions_caches: current.slice(
                  (page - 1) * per_page,
                  page * per_page,
                ),
              },
            };
          },
          async deleteActionsCacheById({ cache_id }) {
            store.delete(cache_id);
          },
        },
      },
    },
  };
  return { input, store };
}

test("retains the newest two bases across all pages and preserves unrelated caches", async () => {
  const caches = Array.from({ length: 105 }, (_, index) => cache(index + 1));
  caches.push(
    cache(106, { key: "kerberos-native-v3-fixture" }),
    cache(107, { key: "v0-rust-fixture" }),
    cache(108, { ref: "refs/pull/7/merge" }),
    cache(109, { ref: "refs/heads/feature" }),
  );
  const { input, store } = fixture(caches.reverse());
  await prune(input);
  assert.deepEqual(
    [...store.keys()].sort((a, b) => a - b),
    [104, 105, 106, 107, 108, 109],
  );
  await prune(input);
  assert.deepEqual(
    [...store.keys()].sort((a, b) => a - b),
    [104, 105, 106, 107, 108, 109],
  );
});

test("preserves an empty or partially populated cache", async () => {
  for (const caches of [[], [cache(1)], [cache(1), cache(2)]]) {
    const { input, store } = fixture(caches);
    await prune(input);
    assert.deepEqual([...store.values()], caches);
  }
});

test("overlapping listing pages preserve two distinct newest bases", async () => {
  const { input, store } = fixture([cache(1), cache(2), cache(3)]);
  input.github.paginate = async () => [cache(3), cache(2), cache(3), cache(1)];
  await prune(input);
  assert.deepEqual([...store.keys()], [2, 3]);
});

test("rejects PRs and non-main pushes before accessing caches", async () => {
  for (const context of [
    { eventName: "pull_request", ref: "refs/pull/7/merge" },
    { eventName: "push", ref: "refs/heads/feature" },
  ]) {
    const { input, store } = fixture([cache(1), cache(2), cache(3)]);
    Object.assign(input.context, context);
    input.github.paginate = () =>
      assert.fail("ineligible event accessed the cache API");
    await assert.rejects(prune(input), /requires a push to main/);
    assert.equal(store.size, 3);
  }
});

test("a later listing-page failure leaves every existing cache intact", async () => {
  const { input, store } = fixture(
    Array.from({ length: 101 }, (_, index) => cache(index + 1)),
  );
  const list = input.github.rest.actions.getActionsCacheList;
  input.github.rest.actions.getActionsCacheList = (options) => {
    if (options.page === 2)
      throw Object.assign(new Error("unavailable"), { status: 503 });
    return list(options);
  };
  await assert.rejects(prune(input), /unavailable/);
  assert.equal(store.size, 101);
});

test("concurrent pruning is idempotent while other deletion errors remain visible", async () => {
  for (const status of [404, 403]) {
    const { input, store } = fixture([cache(1), cache(2), cache(3)]);
    input.github.rest.actions.deleteActionsCacheById = async ({ cache_id }) => {
      if (status === 404) store.delete(cache_id);
      throw Object.assign(new Error("cache API response"), { status });
    };
    if (status === 404) {
      await prune(input);
      assert.deepEqual([...store.keys()], [2, 3]);
    } else {
      await assert.rejects(prune(input), /cache API response/);
      assert.deepEqual([...store.keys()], [1, 2, 3]);
    }
  }
});
