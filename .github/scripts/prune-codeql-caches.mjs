// GitHub-script entry point. Requires Actions write access on a main push.
// CodeQL restores the newest compatible base by prefix, not a commit-specific
// base. Keep a preceding database while making room for native dependency caches.
export default async function pruneCodeqlCaches({ github, context, core }) {
  if (context.eventName !== "push" || context.ref !== "refs/heads/main") {
    throw new Error("CodeQL cache pruning requires a push to main");
  }

  const prefix = "codeql-overlay-base-database-";
  const caches = await github.paginate(
    github.rest.actions.getActionsCacheList,
    {
      ...context.repo,
      ref: context.ref,
      key: prefix,
      per_page: 100,
      sort: "created_at",
      direction: "desc",
    },
  );
  // New uploads can shift page boundaries. Deduplicate immutable IDs before
  // selecting survivors so an overlapping page cannot delete a retained base.
  const basesById = new Map();
  for (const cache of caches) {
    if (cache.ref === context.ref && cache.key.startsWith(prefix)) {
      basesById.set(cache.id, cache);
    }
  }
  const bases = [...basesById.values()].sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id,
  );

  for (const cache of bases.slice(2)) {
    try {
      await github.rest.actions.deleteActionsCacheById({
        ...context.repo,
        cache_id: cache.id,
      });
      core.info(
        `Deleted CodeQL base cache ${cache.id} (${cache.size_in_bytes} bytes)`,
      );
    } catch (error) {
      // A concurrent main scan may already have pruned the same immutable ID.
      if (error.status !== 404) throw error;
    }
  }
  core.info(
    `Retained ${Math.min(2, bases.length)} newest CodeQL base caches on main`,
  );
}
