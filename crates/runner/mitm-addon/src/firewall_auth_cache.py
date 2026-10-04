"""Firewall auth cache, fetch admission, and force-refresh lifecycle.

The cache separates credential identity from registry ownership freshness. A cache key is
credential-equivalent when its ``(run_id, api_id, auth_identity)`` fields match. Its optional
``registry_generation`` records which published registry snapshot authorized the lookup, but is
not part of credential identity, so an unchanged auth identity can reuse its cached payload and
refresh lifecycle across registry snapshots.

Shared ownership is limited to one auth identity per ``(run_id, api_id)`` scope. A current registry
generation may claim that scope or replace its previous identity. A stale generation can use
existing equivalent state, but cannot create, replace, or reclaim shared ownership; when no
equivalent state remains, its fetch uses detached state instead. Registry reconciliation also
removes ownership for runs that are no longer active.
"""

import asyncio
import time
from dataclasses import dataclass, field

from aws_sigv4 import AwsSigV4Credentials
from firewall_auth_client import (
    FirewallAuthPayload,
    FirewallAuthRequest,
    fetch_firewall_headers,
    is_supported_expiry,
)


class InvalidBillableAuthExpiryError(Exception):
    """Raised when billable firewall auth succeeds with an invalid cache expiry."""


class FirewallAuthFetchSaturatedError(Exception):
    """Raised when firewall auth fetch admission is saturated."""


class FirewallAuthCacheEntryIdentity:
    """Credential-free process-local identity for one cached auth result."""

    __slots__ = ()


@dataclass(frozen=True)
class FirewallAuthCacheKey:
    """Auth cache identity for one run, API, and resolved auth input set.

    ``registry_generation`` is ownership-freshness metadata rather than credential identity. It is
    intentionally excluded from equality, hashing, and representation so an unchanged auth
    identity reuses its cached payload and refresh lifecycle across registry generations. Lookup
    checks the generation separately before allowing a key to mutate shared ownership.

    The shared owner scope is one auth identity per ``(run_id, api_id)``. A current key with a
    different ``auth_identity`` replaces the previous owner's state. A stale key cannot reclaim
    that ownership; it can reuse equivalent existing state, or otherwise receives detached state
    that is not stored in the shared cache.
    """

    run_id: str
    api_id: str
    auth_identity: str
    registry_generation: int | None = field(
        default=None,
        compare=False,
        hash=False,
        repr=False,
    )


@dataclass
class _FirewallHeaderCacheEntry:
    """Cached /firewall/auth response data for a single firewall key."""

    payload: FirewallAuthPayload
    identity: FirewallAuthCacheEntryIdentity = field(default_factory=FirewallAuthCacheEntryIdentity)
    expires_at: object = None


@dataclass
class _FirewallAuthState:
    """Per-auth-identity lifecycle state."""

    cache: _FirewallHeaderCacheEntry | None = None
    in_flight: asyncio.Task[dict] | None = None
    force_refresh_pending: bool = False
    last_force_refresh_monotonic_at: float | None = None


@dataclass(frozen=True)
class FirewallAuthStateSnapshotForTests:
    """Copied auth cache state exposed to tests without leaking private storage."""

    has_cached_headers: bool
    has_in_flight_fetch: bool
    headers: dict[str, str] = field(default_factory=dict)
    resolved_secrets: list[str] = field(default_factory=list)
    base: str | None = None
    query: dict[str, str] | None = None
    aws_sigv4: AwsSigV4Credentials | None = None
    expires_at: object = None
    cache_entry_identity: FirewallAuthCacheEntryIdentity | None = None
    force_refresh_pending: bool = False
    last_force_refresh_monotonic_at: float | None = None


FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE = "_firewall_auth_registry_generation"
type _FirewallAuthScope = tuple[str, str]

_auth_state: dict[FirewallAuthCacheKey, _FirewallAuthState] = {}
_owned_auth_keys: dict[_FirewallAuthScope, FirewallAuthCacheKey] = {}
_active_registry_generations: dict[str, int] = {}
MAX_CONCURRENT_FIREWALL_AUTH_FETCHES = 4
MAX_ADMITTED_FIREWALL_AUTH_FETCHES = 16
_admitted_firewall_auth_fetches = 0
_firewall_auth_fetch_semaphore: asyncio.Semaphore | None = None

# Cooldown window for re-marking a force-refresh. Caps amplification at
# 30 refreshes/hour/key under a persistent non-token 401 loop — safely
# below Google's 50/hour/user OAuth refresh limit (the tightest known).
# The first force-refresh after a real token invalidation always fires
# immediately; the cooldown only affects REPEATED forced refreshes, so
# happy-path recovery is unaffected.
_FORCE_REFRESH_COOLDOWN_SECS = 120.0


def _get_auth_state(cache_key: FirewallAuthCacheKey) -> _FirewallAuthState:
    """Return shared state, or detached state for a stale registry key.

    A current key owns one ``(run_id, api_id)`` scope. Claiming that scope with a different
    ``auth_identity`` evicts the previous shared state. Because ``registry_generation`` is excluded
    from key equality, an unchanged auth identity reuses its lifecycle state across generations.
    A stale key may use equivalent existing state, but cannot mutate shared ownership; if that
    state is absent, it receives a detached state object.
    """
    state = _auth_state.get(cache_key)

    registry_generation = cache_key.registry_generation
    is_current_registry_generation = registry_generation is None or (
        _active_registry_generations.get(cache_key.run_id) == registry_generation
    )
    if not is_current_registry_generation:
        return state if state is not None else _FirewallAuthState()

    scope = (cache_key.run_id, cache_key.api_id)
    owned_key = _owned_auth_keys.get(scope)
    if owned_key is not None and owned_key != cache_key:
        _auth_state.pop(owned_key, None)
        state = None

    _owned_auth_keys[scope] = cache_key
    if state is None:
        state = _FirewallAuthState()
        _auth_state[cache_key] = state
    return state


def request_force_refresh(cache_key: FirewallAuthCacheKey) -> None:
    """Request a forced token refresh on the next /firewall/auth fetch.

    No-op if registry lifecycle handling has already evicted the key. Response
    hooks may update auth state owned by an active run, but must not recreate
    ownership for a completed flow.

    No-op if a force-refresh marker was consumed within
    ``_FORCE_REFRESH_COOLDOWN_SECS``. The cooldown starts when the marker is
    consumed, before the forced fetch completes, so the same window covers
    requests made while that fetch is in flight or after it fails. This
    rate-limits the case where the token is actually fine but the endpoint
    rejects for another reason (scope, resource-level permission). See #9860.

    Design notes for future changes:

    * The consume timestamp in ``state.last_force_refresh_monotonic_at`` is
      written **before** ``fetch_firewall_headers`` is awaited in
      ``get_firewall_headers``, not after. Recording after would allow a 401
      arriving during the fetch to re-add the marker; after the fetch
      completes and writes the cache, a later cache miss would then consume
      the stale marker and trigger an unnecessary second refresh. The
      trade-off is that a failed fetch (webhook down,
      ``TOKEN_REFRESH_FAILED``, etc.) still burns the cooldown — intentional,
      because if the refresh grant itself is broken, retrying faster than once
      per cooldown wouldn't help and would hammer the provider.
    * The cooldown is process-local elapsed time and uses ``time.monotonic()``.
      Absolute webhook ``expiresAt`` checks remain wall-clock based elsewhere
      in this module.
    """
    state = _auth_state.get(cache_key)
    if state is None:
        return
    now = time.monotonic()
    last_force_refresh_monotonic_at = state.last_force_refresh_monotonic_at
    if (
        last_force_refresh_monotonic_at is None
        or now - last_force_refresh_monotonic_at >= _FORCE_REFRESH_COOLDOWN_SECS
    ):
        state.force_refresh_pending = True


def invalidate_cached_firewall_headers(
    cache_key: FirewallAuthCacheKey,
    cache_entry_identity: FirewallAuthCacheEntryIdentity,
) -> None:
    """Invalidate and request refresh only for the currently cached entry."""
    state = _auth_state.get(cache_key)
    if state is None or state.cache is None or state.cache.identity is not cache_entry_identity:
        return
    state.cache = None
    request_force_refresh(cache_key)


def reconcile_registry_cache_ownership(active_run_generations: dict[str, int]) -> None:
    """Publish registry freshness and reconcile shared auth-cache ownership.

    ``active_run_generations`` maps each active run to the generation of the registry snapshot just
    published. Replacing this map makes only matching generations current for ownership mutation.
    The ``(run_id, api_id)`` owner remains reusable across generations when the auth identity is
    unchanged, because generation is excluded from cache-key equality. A current key with a new
    identity replaces the prior owner, while stale keys cannot reclaim it.

    Runs absent from ``active_run_generations`` are no longer active owners, so their entries are
    removed from both ownership and auth state, including cached payload and refresh lifecycle
    state.
    """
    _active_registry_generations.clear()
    _active_registry_generations.update(active_run_generations)

    stale_scopes = [scope for scope in _owned_auth_keys if scope[0] not in active_run_generations]
    for scope in stale_scopes:
        cache_key = _owned_auth_keys.pop(scope)
        _auth_state.pop(cache_key, None)


def evict_all_cache_keys() -> None:
    """Remove all auth cache entries when active registry ownership is unknown."""
    _auth_state.clear()
    _owned_auth_keys.clear()
    _active_registry_generations.clear()


def reset_cache_for_tests() -> None:
    """Reset auth cache module state between tests."""
    global _admitted_firewall_auth_fetches
    global _firewall_auth_fetch_semaphore

    _auth_state.clear()
    _owned_auth_keys.clear()
    _active_registry_generations.clear()
    _admitted_firewall_auth_fetches = 0
    _firewall_auth_fetch_semaphore = None


def admitted_firewall_auth_fetches_for_tests() -> int:
    """Return the current admitted distinct fetch count for tests."""
    return _admitted_firewall_auth_fetches


def _reserve_firewall_auth_fetch() -> None:
    global _admitted_firewall_auth_fetches

    if _admitted_firewall_auth_fetches >= MAX_ADMITTED_FIREWALL_AUTH_FETCHES:
        raise FirewallAuthFetchSaturatedError("firewall auth fetch admission is full")
    _admitted_firewall_auth_fetches += 1


def _release_firewall_auth_fetch() -> None:
    global _admitted_firewall_auth_fetches

    _admitted_firewall_auth_fetches -= 1


def _get_firewall_auth_fetch_semaphore() -> asyncio.Semaphore:
    global _firewall_auth_fetch_semaphore

    semaphore = _firewall_auth_fetch_semaphore
    if semaphore is None:
        semaphore = asyncio.Semaphore(
            MAX_CONCURRENT_FIREWALL_AUTH_FETCHES,
        )
        _firewall_auth_fetch_semaphore = semaphore
    return semaphore


def seed_cached_headers_for_tests(
    cache_key: FirewallAuthCacheKey,
    *,
    headers: dict[str, str],
    expires_at: object = None,
    resolved_secrets: list[str] | None = None,
    base: str | None = None,
    query: dict[str, str] | None = None,
    aws_sigv4: AwsSigV4Credentials | None = None,
) -> None:
    """Seed cached firewall auth payload for focused cache lifecycle tests."""
    state = _get_auth_state(cache_key)
    state.cache = _FirewallHeaderCacheEntry(
        payload=FirewallAuthPayload(
            headers=dict(headers),
            resolved_secrets=list(resolved_secrets or []),
            base=base,
            query=dict(query) if query is not None else None,
            aws_sigv4=aws_sigv4,
        ),
        expires_at=expires_at,
    )


def set_force_refresh_state_for_tests(
    cache_key: FirewallAuthCacheKey,
    *,
    pending: bool,
    last_monotonic_at: float | None,
) -> None:
    """Seed force-refresh lifecycle state for focused cache lifecycle tests."""
    state = _get_auth_state(cache_key)
    state.force_refresh_pending = pending
    state.last_force_refresh_monotonic_at = last_monotonic_at


def auth_state_snapshot_for_tests(
    cache_key: FirewallAuthCacheKey,
) -> FirewallAuthStateSnapshotForTests | None:
    """Return a copied snapshot of one auth cache state for tests."""
    state = _auth_state.get(cache_key)
    if state is None:
        return None

    cache = state.cache
    if cache is None:
        return FirewallAuthStateSnapshotForTests(
            has_cached_headers=False,
            has_in_flight_fetch=state.in_flight is not None,
            force_refresh_pending=state.force_refresh_pending,
            last_force_refresh_monotonic_at=state.last_force_refresh_monotonic_at,
        )

    payload = cache.payload
    return FirewallAuthStateSnapshotForTests(
        has_cached_headers=True,
        has_in_flight_fetch=state.in_flight is not None,
        headers=dict(payload.headers),
        resolved_secrets=list(payload.resolved_secrets),
        base=payload.base,
        query=dict(payload.query) if payload.query is not None else None,
        aws_sigv4=payload.aws_sigv4,
        expires_at=cache.expires_at,
        cache_entry_identity=cache.identity,
        force_refresh_pending=state.force_refresh_pending,
        last_force_refresh_monotonic_at=state.last_force_refresh_monotonic_at,
    )


def auth_state_is_empty_for_tests() -> bool:
    """Return whether tests have left the auth cache without any state."""
    return not _auth_state


def _has_valid_expiry(value: object, now: float | None = None) -> bool:
    if not is_supported_expiry(value):
        return False
    return (time.time() if now is None else now) < value


def _build_token_meta(
    cache_entry: _FirewallHeaderCacheEntry,
    *,
    cache_hit: bool,
    refreshed_connectors: list[str] | None = None,
    refreshed_secrets: list[str] | None = None,
) -> dict:
    payload = cache_entry.payload
    token_meta: dict = {
        "headers": dict(payload.headers),
        "resolved_secrets": list(payload.resolved_secrets),
        "cache_hit": cache_hit,
        "cache_entry_identity": cache_entry.identity,
    }
    if refreshed_connectors is not None:
        token_meta["refreshed_connectors"] = refreshed_connectors
    if refreshed_secrets is not None:
        token_meta["refreshed_secrets"] = refreshed_secrets
    if payload.base is not None:
        token_meta["base"] = payload.base
    if payload.query is not None:
        token_meta["query"] = dict(payload.query)
    if payload.aws_sigv4 is not None:
        token_meta["aws_sigv4"] = payload.aws_sigv4
    return token_meta


def _build_cache_hit(
    cached: _FirewallHeaderCacheEntry, firewall_billable: bool = False
) -> dict | None:
    """Check if a cached entry is still valid and return a cache-hit result."""
    expires_at = cached.expires_at
    now = time.time()
    if expires_at is None:
        if firewall_billable:
            return None
    elif not _has_valid_expiry(expires_at, now):
        return None
    return _build_token_meta(cached, cache_hit=True)


def _observe_fetch_task_exception(task: asyncio.Task[dict]) -> None:
    """Retrieve a detached fetch failure after every waiter is cancelled."""
    if not task.cancelled():
        task.exception()


async def _fetch_and_cache_firewall_headers(
    state: _FirewallAuthState,
    request: FirewallAuthRequest,
    *,
    force_refresh: bool,
) -> dict:
    """Own one shared fetch through completion and update its cache state."""
    try:
        async with _get_firewall_auth_fetch_semaphore():
            result = await fetch_firewall_headers(
                request,
                force_refresh=force_refresh,
            )
        if request.firewall_billable and not _has_valid_expiry(result.expires_at):
            raise InvalidBillableAuthExpiryError(
                "Billable firewall auth response did not include a valid cache expiry"
            )
        cache_entry = _FirewallHeaderCacheEntry(
            payload=result.payload,
            expires_at=result.expires_at,
        )

        # A 401 can request a forced refresh while this non-forced fetch is
        # in flight. Return the current result to its initiating request, but
        # do not let it repopulate shared cache ahead of the pending refresh.
        marker_appeared_during_non_forced_fetch = not force_refresh and state.force_refresh_pending
        if not marker_appeared_during_non_forced_fetch:
            state.cache = cache_entry

        return _build_token_meta(
            cache_entry,
            cache_hit=False,
            refreshed_connectors=result.refreshed_connectors,
            refreshed_secrets=result.refreshed_secrets,
        )
    finally:
        state.in_flight = None
        _release_firewall_auth_fetch()


async def get_firewall_headers(
    cache_key: FirewallAuthCacheKey,
    request: FirewallAuthRequest,
) -> dict:
    """Get firewall auth headers with TTL-based caching.

    Uses a state-owned per-key task so concurrent requests for the same
    auth identity coalesce even if an individual waiter is cancelled.

    Cached headers are physically cleared when:
    - The run is removed from the registry (see registry.load_registry; its
      auth state is evicted)
    - A 401 response is received (see response handler; refresh lifecycle state
      is preserved)

    TTL expiry is different: once the expiresAt timestamp from the auth
    endpoint has passed, the entry is treated as a cache miss and its headers
    are never served. A successful refetch replaces the expired entry, while a
    failed refetch leaves the expired entry stored for a later retry.
    """
    state = _get_auth_state(cache_key)

    while True:
        # Cache inspection and task selection contain no await, so they are
        # atomic on mitmproxy's single event loop.
        if state.cache:
            hit = _build_cache_hit(state.cache, firewall_billable=request.firewall_billable)
            if hit:
                return hit

        fetch_task = state.in_flight
        created_fetch = fetch_task is None
        if fetch_task is None:
            force_refresh = state.force_refresh_pending
            force_refresh_started_at = time.monotonic() if force_refresh else None
            _reserve_firewall_auth_fetch()

            fetch_coroutine = _fetch_and_cache_firewall_headers(
                state,
                request,
                force_refresh=force_refresh,
            )
            try:
                fetch_task = asyncio.create_task(fetch_coroutine)
            except BaseException:
                fetch_coroutine.close()
                _release_firewall_auth_fetch()
                raise

            state.in_flight = fetch_task

            # Task selection and publication contain no await, so consuming
            # the marker here is still atomic with choosing this shared fetch.
            # Recording before the task runs preserves the intentional
            # failed-refresh cooldown once task ownership has transferred.
            state.force_refresh_pending = False
            if force_refresh:
                state.last_force_refresh_monotonic_at = force_refresh_started_at

            fetch_task.add_done_callback(_observe_fetch_task_exception)

        result = await asyncio.shield(fetch_task)
        if created_fetch:
            return result

        # Followers observe an ordinary completion through the cache. If the
        # result was intentionally left uncached after a new 401 marker, the
        # loop creates the required forced refresh instead.
