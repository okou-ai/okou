/**
 * Worker-build-only replacement for @vercel/functions, whose CommonJS barrel
 * otherwise bundles cache, purge, middleware and OIDC code for two calls.
 * Worker requests register background work through RequestRuntime.waitUntil
 * and own a per-request Hyperdrive pool, so these Vercel fallbacks run only
 * outside a request runtime. There, without Vercel's request-context global,
 * the real package already does nothing; this keeps exactly that behavior.
 */
export function waitUntil(): void {
  // No Vercel request context exists on Workers.
}

export function attachDatabasePool(): void {
  // Vercel idle-connection draining needs VERCEL_URL/VERCEL_REGION.
}
