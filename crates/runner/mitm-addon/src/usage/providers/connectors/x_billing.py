"""X billing bucket classification.

Maps firewall permission + request method/path to one of X's official
per-API pricing buckets (see https://docs.x.com/x-api/getting-started/pricing).
The bucket name is written to ``usage_event.category`` and used by the
server-side billing processor to look up ``unit_price`` in
``usage_pricing``.

Body-dependent refinement is applied on top via
:func:`refine_bucket_with_body` — currently used to drop
``content.create_with_url`` to ``content.create`` only when the POST
/2/tweets body is valid plain text with neither a URL nor a rendered-link
signal such as a quote reference, media attachment, card, or DM deep link.
Parse failures and ambiguous bodies stay on the more expensive bucket,
matching the "never under-charge" rule.

Design:

- ``_PERMISSION_TO_BUCKET`` gives each firewall scope a default bucket.
  The default is chosen to match the MAJORITY of paths in that scope
  so the category name stays semantically meaningful (a tweet-read
  request lands in ``posts.read``, not ``user.read``).

- ``_PATH_OVERRIDES`` holds per-path refinements when a specific path
  within a scope belongs to a different X bucket than the scope default.
  Overrides may raise OR lower the price — the goal is accuracy, not
  one-sided safety.

- **Provider-documented pricing**: X's public pricing page lists named
  pricing buckets and prices, but it does not publish a comprehensive
  endpoint → bucket mapping.  It does document a separate **Owned Reads**
  exception: requests for the authenticated user's own data are priced at
  ``$0.001`` per resource when ``{id}`` matches the authenticated user and
  that user owns the developer app.  The documented Owned Reads endpoints
  are:

  - ``GET /2/users/{id}/tweets``
  - ``GET /2/users/{id}/mentions``
  - ``GET /2/users/{id}/liked_tweets``
  - ``GET /2/users/{id}/bookmarks``
  - ``GET /2/users/{id}/followers``
  - ``GET /2/users/{id}/following``
  - ``GET /2/users/{id}/blocking``
  - ``GET /2/users/{id}/muting``
  - ``GET /2/users/{id}/owned_lists``
  - ``GET /2/users/{id}/followed_lists``
  - ``GET /2/users/{id}/list_memberships``
  - ``GET /2/users/{id}/pinned_lists``

  This endpoint-specific provider documentation does not define how a
  qualifying request maps to one of the platform's ordinary pricing buckets.

- **Current platform treatment**: ``classify_bucket`` receives only the firewall
  permission, HTTP method, and query-free request path.  It has no
  authenticated-user or developer-app ownership input and no separate
  ``Owned Reads`` category.  The listed paths therefore continue through
  the existing permission defaults and path overrides; this documentation
  must not be read as saying that the platform applies the provider's conditional
  ``$0.001`` rate.

- **Semantic inferences**: For the current path-to-bucket mapping beyond
  provider-documented exceptions, X's pricing page does not publish a
  comprehensive endpoint → bucket mapping.  The overrides here are
  semantic inferences from the bucket names (e.g. DELETE of your own
  content → ``content.manage``).  A handful of overrides lower the price
  by 10–40× based on name semantics alone.  Validate against Developer
  Console billing data or empirical live calls before relying on the
  numbers; drift from X's actual classification will cause under- or
  over-charging until an override is corrected.

- ``_INCLUDES_TO_BUCKET`` maps X v2 ``includes.<key>`` resource types
  to buckets.  Unknown keys return ``None`` and the caller routes them
  to a bounded synthetic or overflow category; the billing processor applies
  a server-side fallback price for these.

- Scopes that are not billable (e.g. the ``"app-only"`` group for
  BearerToken-only endpoints) are intentionally absent; ``classify_bucket``
  returns ``None`` and the caller skips emitting a ``usage_event`` row.
  That matches current behaviour where the TypeScript firewall execution
  metadata only marks user-authenticated X calls as connector-billable.

New X endpoints appearing in a scope but not in overrides will be
billed at the scope default.  If X's own pricing for that new endpoint
is higher than the default bucket, we'd under-charge until an override
is added — monitor the firewall generator output and the X pricing
sheet for drift.
"""

import json
import re
from collections.abc import Callable
from typing import Literal, NamedTuple

import matching
from host_normalization import UnsafeIdnaCompatibilityMappingError, normalize_idna_label

from ...json_selective import json_nesting_within_limit
from .x_tlds import IANA_TLDS


class _BodyRefinementRule(NamedTuple):
    source_bucket: str
    method: str
    path: str
    target_bucket: str
    matches_body: Callable[[bytes | None], bool]


class _BillingDomainLabelNormalization(NamedTuple):
    normalized_label: str | None
    unsafe_compatibility_mapping: bool


# Permission → default bucket.  The default matches the majority of
# paths in the scope; outliers go in `_PATH_OVERRIDES`.  Prices are
# defined in turbo/apps/api/src/scripts/dev-seed.ts.
_PERMISSION_TO_BUCKET: dict[str, str] = {
    # — Writes with an unambiguous single bucket —
    "tweet.moderate.write": "content.manage",
    "bookmark.write": "bookmark",
    "dm.write": "dm_interaction.create",
    # — Writes that span multiple X buckets — default to the more
    # expensive variant so an unmapped path never under-charges —
    # tweet.write: Content: Create vs Content: Create (with URL).
    # Distinguished by request body inspection in refine_bucket_with_body.
    # DELETE /2/tweets/{id} and DELETE /2/notes/{id} split off to
    # content.manage; retweet create/undo split off to
    # user_interaction.create / interaction.delete — see overrides.
    "tweet.write": "content.create_with_url",
    # media.write: public upload paths stay on Content: Create (with URL);
    # GETs, metadata/subtitles, and chat (DM) media uploads split off
    # via overrides.
    "media.write": "content.create_with_url",
    # User-interaction writes: POST creates are User Interaction: Create;
    # DELETE undoes are Interaction: Delete (Mute: Delete for mute).
    # Default = POST bucket; DELETE paths go in override.
    "like.write": "user_interaction.create",
    "follows.write": "user_interaction.create",
    "mute.write": "user_interaction.create",
    # list.write: POST /2/lists is List: Create; everything else is
    # List: Manage — see override.
    "list.write": "list.create",
    # — Reads —
    "bookmark.read": "posts.read",
    "dm.read": "dm_event.read",
    "follows.read": "following_followers.read",
    "like.read": "posts.read",
    "timeline.read": "posts.read",
    "space.read": "space.read",
    "list.read": "list.read",
    # Scopes whose response is a list of users
    "block.read": "user.read",
    "mute.read": "user.read",
    # tweet.read: majority of paths return tweets (Posts: Read).
    # Outlier /2/tweets/{id}/retweeted_by returns users — see override.
    "tweet.read": "posts.read",
    # users.read: majority return user records (User: Read).
    # Paths that return tweets (/mentions, /timelines, /tweets) and
    # /communities/search go to cheaper buckets via override.
    "users.read": "user.read",
}

# Per-path refinements when a specific path within a scope belongs to a
# different X bucket than the scope default.  First-match wins.
_PATH_OVERRIDES: list[tuple[str, str, str, str]] = [
    # (scope, method, path pattern, bucket)
    #
    # — reads —
    # tweet.read: retweeted_by returns users, priced as User: Read.
    ("tweet.read", "GET", "/2/tweets/{id}/retweeted_by", "user.read"),
    # tweet.read: analytics / media / note paths share the posts.read
    # price but belong to semantically distinct X buckets.
    ("tweet.read", "GET", "/2/insights/28hr", "analytics.read"),
    ("tweet.read", "GET", "/2/insights/historical", "analytics.read"),
    ("tweet.read", "GET", "/2/media/analytics", "analytics.read"),
    ("tweet.read", "GET", "/2/tweets/analytics", "analytics.read"),
    ("tweet.read", "GET", "/2/media", "media.read"),
    ("tweet.read", "GET", "/2/media/{media_key}", "media.read"),
    ("tweet.read", "GET", "/2/notes/search/notes_written", "note.read"),
    ("tweet.read", "GET", "/2/notes/search/posts_eligible_for_notes", "note.read"),
    # users.read: paths returning tweets are Posts: Read.
    ("users.read", "GET", "/2/users/{id}/mentions", "posts.read"),
    ("users.read", "GET", "/2/users/{id}/timelines/reverse_chronological", "posts.read"),
    ("users.read", "GET", "/2/users/{id}/tweets", "posts.read"),
    # users.read: community search is Community: Read.
    ("users.read", "GET", "/2/communities/search", "community.read"),
    #
    # — writes: undo actions go to Interaction: Delete —
    ("like.write", "DELETE", "/2/users/{id}/likes/{tweet_id}", "interaction.delete"),
    (
        "follows.write",
        "DELETE",
        "/2/users/{source_user_id}/following/{target_user_id}",
        "interaction.delete",
    ),
    #
    # — tweet.write: DELETE of your own content is Content: Manage;
    # retweeting is a User Interaction (create/delete).  POST /2/notes
    # stays on the default because a note can carry URLs; evaluating
    # a community note is a user interaction, not content creation.
    # (X does not publish endpoint-to-bucket mapping — these are
    # semantic inferences from the bucket names in the pricing page.)
    ("tweet.write", "DELETE", "/2/tweets/{id}", "content.manage"),
    ("tweet.write", "DELETE", "/2/notes/{id}", "content.manage"),
    ("tweet.write", "POST", "/2/users/{id}/retweets", "user_interaction.create"),
    (
        "tweet.write",
        "DELETE",
        "/2/users/{id}/retweets/{source_tweet_id}",
        "interaction.delete",
    ),
    ("tweet.write", "POST", "/2/evaluate_note", "user_interaction.create"),
    #
    # — dm.write: deleting a DM you sent is managing your own content —
    ("dm.write", "DELETE", "/2/dm_events/{event_id}", "content.manage"),
    #
    # — mute undo is its own Mute: Delete bucket, cheaper than
    # Interaction: Delete —
    (
        "mute.write",
        "DELETE",
        "/2/users/{source_user_id}/muting/{target_user_id}",
        "mute.delete",
    ),
    #
    # — list.write: default is List: Create for POST /2/lists; every
    # other path in the scope is List: Manage —
    ("list.write", "PUT", "/2/lists/{id}", "list.manage"),
    ("list.write", "DELETE", "/2/lists/{id}", "list.manage"),
    ("list.write", "POST", "/2/lists/{id}/members", "list.manage"),
    ("list.write", "DELETE", "/2/lists/{id}/members/{user_id}", "list.manage"),
    ("list.write", "POST", "/2/users/{id}/followed_lists", "list.manage"),
    ("list.write", "DELETE", "/2/users/{id}/followed_lists/{list_id}", "list.manage"),
    ("list.write", "POST", "/2/users/{id}/pinned_lists", "list.manage"),
    ("list.write", "DELETE", "/2/users/{id}/pinned_lists/{list_id}", "list.manage"),
    #
    # — bookmark removal is still Bookmark, not Interaction: Delete.
    # (Default already covers POST; DELETE explicitly kept in the same
    # bucket to document that we checked.) —
    ("bookmark.write", "DELETE", "/2/users/{id}/bookmarks/{tweet_id}", "bookmark"),
    #
    # — media.write: default covers public upload paths; GETs, metadata,
    # subtitles, and chat (DM) media uploads split off to cheaper
    # buckets.  Chat media routes are in DM context, so we infer
    # DM Interaction: Create (same inference confidence as the DM
    # write overrides above — not docs-confirmed). —
    ("media.write", "GET", "/2/media/upload", "media.read"),
    ("media.write", "GET", "/2/chat/media/{id}/{media_hash_key}", "media.read"),
    ("media.write", "POST", "/2/media/metadata", "media_metadata"),
    ("media.write", "POST", "/2/media/subtitles", "media_metadata"),
    ("media.write", "DELETE", "/2/media/subtitles", "media_metadata"),
    ("media.write", "POST", "/2/chat/media/upload/initialize", "dm_interaction.create"),
    ("media.write", "POST", "/2/chat/media/upload/{id}/append", "dm_interaction.create"),
    ("media.write", "POST", "/2/chat/media/upload/{id}/finalize", "dm_interaction.create"),
]


def _build_override_index(
    overrides: list[tuple[str, str, str, str]],
) -> dict[tuple[str, str], list[tuple[matching.CompiledPathPattern, str]]]:
    """Group overrides by ``(scope, method)`` so :func:`classify_bucket`
    only walks patterns under the matching scope/method instead of the
    full list.  Insertion order is preserved inside each bucket, which
    keeps first-match-wins semantics from the source list.
    """
    index: dict[tuple[str, str], list[tuple[matching.CompiledPathPattern, str]]] = {}
    for scope, method, pattern, bucket in overrides:
        compiled_pattern = matching.compile_path_pattern(pattern)
        if compiled_pattern is None:
            raise ValueError(f"invalid X billing override path pattern: {scope} {method} {pattern}")
        index.setdefault((scope, method), []).append((compiled_pattern, bucket))
    return index


_OVERRIDE_INDEX = _build_override_index(_PATH_OVERRIDES)


def classify_bucket(permission: str, method: str, path: str) -> str | None:
    """Return the X billing bucket for a matched firewall request.

    ``permission`` is the firewall permission name set on
    ``metadata_keys.FIREWALL_PERMISSION``.  ``method`` comes from
    ``flow.request.method``.  ``path`` must be the URL path with its query
    removed, not mitmproxy's raw ``flow.request.path``.  The production caller
    applies ``_strip_request_target_query()`` in ``_response_usage_context()``
    before calling this function.

    Compiled path overrides match this normalized path.  Passing a raw,
    query-bearing request target can miss an override and fall back to the
    permission's default billing bucket.

    Returns ``None`` for permissions that are not billable (e.g. the
    ``"app-only"`` scope).  The caller should skip emission in that
    case.
    """
    for pattern, bucket in _OVERRIDE_INDEX.get((permission, method.upper()), ()):
        if matching.match_compiled_path(path, pattern) is not None:
            return bucket
    return _PERMISSION_TO_BUCKET.get(permission)


# X v2 ``includes.<key>`` resource types → X billing bucket.
# Irregular cases: includes key is plural while firewall permission is
# singular (``tweets`` → Posts: Read, ``spaces`` → Space: Read).
_INCLUDES_TO_BUCKET: dict[str, str] = {
    "users": "user.read",
    "tweets": "posts.read",
    "media": "media.read",
    "polls": "posts.read",
    "places": "posts.read",
    "topics": "posts.read",
    "spaces": "space.read",
}

MAX_UNKNOWN_INCLUDE_CATEGORIES = 64
INCLUDES_OVERFLOW_CATEGORY = "includes.__overflow__"
_MAX_USAGE_CATEGORY_CHARS = 100
_SYNTHETIC_INCLUDE_CATEGORY_PREFIX = "includes."
_SAFE_SYNTHETIC_INCLUDE_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class IncludeBillingCategory(NamedTuple):
    category: str
    kind: Literal["known", "synthetic", "overflow"]


def classify_includes_bucket(key: str) -> str | None:
    """Return the billing bucket for an ``includes.<key>`` resource type.

    ``None`` means the caller must preserve the unknown type as a bounded
    synthetic ``includes.<key>`` category or the fixed
    ``includes.__overflow__`` category, not substitute a known bucket.  The
    server applies the minimum-rate X ``__fallback__`` price to these
    categories, records ``fallback_pricing``, and emits underbilling telemetry.
    """
    return _INCLUDES_TO_BUCKET.get(key)


def _synthetic_include_category(key: str) -> str | None:
    max_key_chars = _MAX_USAGE_CATEGORY_CHARS - len(_SYNTHETIC_INCLUDE_CATEGORY_PREFIX)
    if not key or len(key) > max_key_chars:
        return None
    if _SAFE_SYNTHETIC_INCLUDE_KEY_RE.fullmatch(key) is None:
        return None
    if f"{_SYNTHETIC_INCLUDE_CATEGORY_PREFIX}{key}" == INCLUDES_OVERFLOW_CATEGORY:
        return None
    return f"{_SYNTHETIC_INCLUDE_CATEGORY_PREFIX}{key}"


def include_billing_category(key: str) -> IncludeBillingCategory:
    """Classify one known, safe synthetic, or overflow include category."""
    bucket = classify_includes_bucket(key)
    if bucket is not None:
        return IncludeBillingCategory(bucket, "known")

    category = _synthetic_include_category(key)
    if category is None:
        return IncludeBillingCategory(INCLUDES_OVERFLOW_CATEGORY, "overflow")
    return IncludeBillingCategory(category, "synthetic")


# URL detector for tweet body refinement.  Billing needs a conservative
# "could X auto-link this?" boolean, not link indices.  Keep protocol
# matching case-insensitive and preserve twitter-text-style boundary
# guards so emails, mentions, hashtags and cashtags do not look like
# scheme-less URLs.  Candidate extraction starts only at Unicode-label
# boundaries and stays greedy; classification recognizes a valid TLD at
# its own boundary before later text can invalidate the URL prefix.
_URL_PRECEDING_CHARS = r"A-Za-z0-9@\uFF20$#\uFF03"
_URL_WITH_PROTOCOL_RE = re.compile(rf"(?<![{_URL_PRECEDING_CHARS}])https?://", re.IGNORECASE)
_DOMAIN_CODEPOINT = r"[^\W_]"
_DOMAIN_CANDIDATE_CHAR = rf"(?:{_DOMAIN_CODEPOINT}|-)"
_BARE_DOMAIN_CANDIDATE_RE = re.compile(
    rf"(?<!{_DOMAIN_CODEPOINT})"
    rf"(?<![{_URL_PRECEDING_CHARS}._/-])"
    rf"({_DOMAIN_CANDIDATE_CHAR}+(?:\.{_DOMAIN_CANDIDATE_CHAR}+)+)",
    re.IGNORECASE,
)
_MAX_DOMAIN_LABEL_CHARS = 63
# This stays above the 127 one-character labels that fit in a DNS name while
# leaving a fixed ceiling for non-host text inspected by billing.
_MAX_BILLING_DOMAIN_LABEL_CLASSIFICATIONS = 256
_DOMAIN_LABEL_RE = re.compile(rf"^[a-z0-9-]{{1,{_MAX_DOMAIN_LABEL_CHARS}}}$")
_INVALID_TLD_FOLLOWING_CHARS = "@+-"


def _build_iana_tld_text_keys() -> frozenset[str]:
    texts = set(IANA_TLDS)
    texts.update(
        tld.removeprefix("xn--").encode("ascii").decode("punycode")
        for tld in IANA_TLDS
        if tld.startswith("xn--")
    )
    return frozenset(text.casefold() for text in texts)


_IANA_TLD_TEXT_KEYS = _build_iana_tld_text_keys()
_MAX_IANA_TLD_TEXT_KEY_CHARS = max(map(len, _IANA_TLD_TEXT_KEYS))


def _label_is_billing_domain_label(label: str) -> bool:
    return (
        bool(label)
        and _DOMAIN_LABEL_RE.fullmatch(label) is not None
        and not label.startswith("-")
        and not label.endswith("-")
    )


def _is_twitter_text_tld_boundary(following_char: str) -> bool:
    return not following_char or not (
        following_char.isascii()
        and (following_char.isalnum() or following_char in _INVALID_TLD_FOLLOWING_CHARS)
    )


def _label_has_tld_prefix_before_unicode(label: str) -> bool:
    prefix_limit = min(len(label), _MAX_IANA_TLD_TEXT_KEY_CHARS + 1)
    for prefix_end in range(1, prefix_limit):
        if label[prefix_end].isascii():
            continue
        prefix = label[:prefix_end]
        if prefix.casefold() not in _IANA_TLD_TEXT_KEYS:
            continue
        try:
            normalized_prefix = normalize_idna_label(prefix)
        except UnicodeError:
            continue
        if _label_is_billing_domain_label(normalized_prefix) and normalized_prefix in IANA_TLDS:
            return True
    return False


def _normalize_billing_domain_label(label: str) -> _BillingDomainLabelNormalization:
    try:
        return _BillingDomainLabelNormalization(normalize_idna_label(label), False)
    except UnsafeIdnaCompatibilityMappingError:
        return _BillingDomainLabelNormalization(None, True)
    except UnicodeError:
        return _BillingDomainLabelNormalization(None, False)


def _bare_domain_candidate_likely_contains_url(
    candidate: str,
    following_char: str,
    label_normalizations: dict[str, _BillingDomainLabelNormalization],
    label_tld_prefixes: dict[str, bool],
) -> bool:
    if candidate.isascii():
        simple_ascii_candidate = candidate.lower()
        # Canonical A-label validation remains owned by the shared IDNA path.
        use_simple_ascii_labels = "xn--" not in simple_ascii_candidate
        labels = (simple_ascii_candidate if use_simple_ascii_labels else candidate).split(".")
    else:
        use_simple_ascii_labels = False
        labels = candidate.split(".")
    last_label_index = len(labels) - 1
    for index, label in enumerate(labels):
        if use_simple_ascii_labels:
            normalized_label = label
        else:
            normalization = label_normalizations.get(label)
            if (
                normalization is None
                and len(label_normalizations) >= _MAX_BILLING_DOMAIN_LABEL_CLASSIFICATIONS
            ):
                # Exhausted inspection is ambiguous, so keep the conservative
                # with-URL billing bucket.
                return True

            if index > 0:
                has_tld_prefix = label_tld_prefixes.get(label)
                if has_tld_prefix is None:
                    has_tld_prefix = _label_has_tld_prefix_before_unicode(label)
                    label_tld_prefixes[label] = has_tld_prefix
                if has_tld_prefix:
                    return True

            if normalization is None:
                normalization = _normalize_billing_domain_label(label)
                label_normalizations[label] = normalization
            if normalization.unsafe_compatibility_mapping:
                # Keep billing conservative for URL-like compatibility aliases,
                # but do not fold them into unrelated ASCII domains.
                if index == last_label_index:
                    return _is_twitter_text_tld_boundary(following_char)
                continue
            normalized_label = normalization.normalized_label
            if normalized_label is None:
                return False

        if not _label_is_billing_domain_label(normalized_label):
            return False
        if index > 0 and normalized_label in IANA_TLDS:
            if index < last_label_index:
                return True
            if _is_twitter_text_tld_boundary(following_char):
                return True

    return False


def _tweet_text_likely_contains_url(text: str) -> bool:
    if _URL_WITH_PROTOCOL_RE.search(text) is not None:
        return True
    if "." not in text:
        return False
    # Share bounded classification state across every candidate in this body.
    label_normalizations: dict[str, _BillingDomainLabelNormalization] = {}
    label_tld_prefixes: dict[str, bool] = {}
    return any(
        _bare_domain_candidate_likely_contains_url(
            match.group(1),
            text[match.end(1) : match.end(1) + 1],
            label_normalizations,
            label_tld_prefixes,
        )
        for match in _BARE_DOMAIN_CANDIDATE_RE.finditer(text)
    )


def _tweet_create_body_has_rendered_link_signal(obj: dict[str, object]) -> bool:
    # Quote tweets embed a link to the quoted post; X likely bills these
    # as "with URL" on the rendered tweet.  Stay conservative.
    if obj.get("quote_tweet_id") is not None:
        return True
    # Attached media renders as a t.co preview URL in the published tweet.
    media = obj.get("media")
    if isinstance(media, dict) and media.get("media_ids"):
        return True
    # A `card_uri` attaches a link preview card to the tweet.
    if obj.get("card_uri"):
        return True
    direct_message_deep_link = obj.get("direct_message_deep_link")
    return isinstance(direct_message_deep_link, str) and bool(direct_message_deep_link.strip())


def _tweet_create_body_is_plain_text_without_url(body: bytes | None) -> bool:
    if not body or not json_nesting_within_limit(body):
        return False
    try:
        obj = json.loads(body)
    except ValueError, RecursionError:
        return False
    if not isinstance(obj, dict):
        return False
    if _tweet_create_body_has_rendered_link_signal(obj):
        return False
    text = obj.get("text")
    return isinstance(text, str) and not _tweet_text_likely_contains_url(text)


_BODY_REFINEMENT_RULES: tuple[_BodyRefinementRule, ...] = (
    _BodyRefinementRule(
        source_bucket="content.create_with_url",
        method="POST",
        path="/2/tweets",
        target_bucket="content.create",
        matches_body=_tweet_create_body_is_plain_text_without_url,
    ),
)


def bucket_needs_body_refinement(bucket: str, method: str, path: str) -> bool:
    """Return True when request body inspection can refine this bucket."""
    return any(
        bucket == rule.source_bucket and method == rule.method and path == rule.path
        for rule in _BODY_REFINEMENT_RULES
    )


def refine_bucket_with_body(bucket: str, method: str, path: str, body: bytes | None) -> str:
    """Refine a bucket using the request body, when the body carries
    billing-relevant signal.

    Current behaviour: for ``POST /2/tweets`` classified as
    ``content.create_with_url``, drop to ``content.create`` when the
    tweet body is plain text with no URL and no rendered link signal
    such as a quote reference, media attachment, card, or DM deep link.
    All parse failures or ambiguity → stay on the more expensive bucket,
    matching the "never under-charge" rule.
    """
    for rule in _BODY_REFINEMENT_RULES:
        if bucket != rule.source_bucket or method != rule.method or path != rule.path:
            continue
        if rule.matches_body(body):
            return rule.target_bucket
    return bucket
