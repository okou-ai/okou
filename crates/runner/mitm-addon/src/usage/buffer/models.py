"""Shared models for the usage buffer subsystem."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, NotRequired, TypedDict

DEFAULT_FLUSH_INTERVAL_SECONDS = 30.0
DEFAULT_FLUSH_JITTER_RATIO = 0.2
MAX_BUFFERED_SOURCE_EVENTS = 1_000
MAX_AGGREGATE_BUCKETS = 100
MAX_BUFFERED_WEBHOOK_BATCHES = 4
MAX_SOURCE_IDEMPOTENCY_KEYS = 10_000
USAGE_EVENT_BATCH_SIZE = 100
MAX_RESOURCE_IDS_PER_BATCH = 1_000
MAX_RESOURCE_BATCH_BYTES = 256 * 1024
MAX_RETAINED_USAGE_BATCH_RETRIES = 20


class ResourceUsageItem(TypedDict):
    id: str
    occurrences: int


class ResourceUsageRemainder(TypedDict):
    reason: Literal["missing_id", "unsupported_resource", "identity_limit", "parse_fallback"]
    quantity: int


class UsageEvent(TypedDict):
    idempotencyKey: str
    kind: str
    provider: str
    category: str
    quantity: int
    protocol: NotRequired[Literal["x-resource-v1"]]
    observedAt: NotRequired[str]
    resources: NotRequired[list[ResourceUsageItem]]
    remainder: NotRequired[list[ResourceUsageRemainder]]


UsageFlushTrigger = Literal["timer", "threshold", "runner", "shutdown", "test"]


@dataclass(frozen=True)
class _DestinationKey:
    url: str
    sandbox_token: str
    proxy_log_path: str


@dataclass(frozen=True)
class _AggregateKey:
    run_id: str
    kind: str
    provider: str
    category: str


@dataclass
class _AggregateBucket:
    quantity: int = 0
    source_event_count: int = 0


@dataclass(frozen=True)
class _BufferedSourceEvent:
    run_id: str
    event: UsageEvent
    encoded_size: int


@dataclass(frozen=True)
class _FlushEvent:
    payload: dict
    source_event_count: int


@dataclass(frozen=True)
class _FlushBatch:
    url: str
    sandbox_token: str
    payload: dict
    proxy_log_path: str
    source_event_count: int


@dataclass(frozen=True)
class _PendingBatch:
    batch: _FlushBatch
    flush_batch_index: int
    retained_retry_count: int = 0


@dataclass
class _FlushSummary:
    proxy_log_path: str
    source_event_count: int = 0
    aggregate_event_count: int = 0
    webhook_batch_count: int = 0
    dropped_webhook_batch_count: int = 0
    retained_webhook_batch_count: int = 0
    retained_source_event_count: int = 0
    run_ids: set[str] = field(default_factory=set)
    destinations: set[tuple[str, str]] = field(default_factory=set)


@dataclass
class _PendingFlush:
    flush_sequence: int
    batches: list[_PendingBatch]
    summaries: list[_FlushSummary]
    retry_after_flush_generation: int = 0

    @property
    def source_event_count(self) -> int:
        return sum(pending_batch.batch.source_event_count for pending_batch in self.batches)


@dataclass
class _DeliveringFlush:
    pending_flush: _PendingFlush
    trigger: UsageFlushTrigger
    flush_generation: int
    remaining_batch_count: int
    retryable_batches: list[_PendingBatch] = field(default_factory=list)


@dataclass(frozen=True)
class _DeliveryCompletion:
    pending_flush: _PendingFlush
    trigger: UsageFlushTrigger
    retained_batches: list[_PendingBatch]
    dropped_batches: list[_PendingBatch]


@dataclass(frozen=True)
class _BatchAdmissionResult:
    admitted_batch_count: int
    retained_batches: list[_PendingBatch]


class _BatchEnqueueError(Exception):
    def __init__(self, original: Exception, admission_result: _BatchAdmissionResult) -> None:
        super().__init__(str(original))
        self.original = original
        self.admission_result = admission_result


@dataclass(frozen=True)
class _RetainBatchesResult:
    retained_batches: list[_PendingBatch]
    dropped_batches: list[_PendingBatch]
