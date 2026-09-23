"""Connector response parser result types."""

from collections.abc import Callable
from typing import NamedTuple


class ConnectorResponseParser(NamedTuple):
    """Incremental parser hooks for connector response-body usage extraction.

    Connector response-inspection capabilities registered in ``_REGISTRATIONS``
    return this value when a connector flow needs response-body parsing for
    connector usage extraction. The response streaming layer wires ``feed`` into
    the stream callback for that flow.

    ### Incremental parser delivery

    ``feed`` receives each streamed response-body parser chunk. The stream
    wrapper passes decoded bytes to ``feed`` for ``gzip``, ``deflate``, and
    ``br``. With no ``Content-Encoding`` or ``identity``, the byte content is
    unchanged. Parser delivery chunks for every supported encoding are bounded
    independently by the configured streaming decode chunk limit, while the
    cumulative decoded-output budget for compressed encodings remains scoped to
    the response. Brotli 1.2's ``output_buffer_limit`` is a soft allocation
    threshold, so temporary output allocation may transiently exceed that limit
    even though delivered output is split and charged against the response
    budget.

    ### Terminal fallback for non-incremental encodings

    Encodings that cannot be safely decoded under the bounded incremental
    contract (currently ``zstd`` and unsupported values) do not receive
    incremental parser input. A connector flow using one of those encodings may
    still use a separate bounded terminal JSON fallback when response streaming
    and the connector's inspection policy allow it; this fallback is not part of
    the ``feed`` delivery contract. Implementations must treat ``b""`` as a
    no-op: incremental decompressors may produce no output for a source chunk,
    and decompression failures intentionally suppress later parser input.

    ``report_on_interruption`` explicitly declares whether state accumulated by
    this parser may be finalized and reported after a connection error. Use it
    only when partial observations are independently billable; ordinary JSON
    parsers must leave it false so an incomplete body cannot reach request-side
    billing fallbacks.

    ``finish`` is optional. When provided, normal completed-response
    finalization calls it once after streaming has fed all chunks and before
    ``report_connector_usage`` consumes connector metadata. An interrupted
    response also calls it when ``report_on_interruption`` is true. It should
    publish final parser state to connector-owned ``flow.metadata`` keys through
    the closure created by the connector parser factory.

    ``finish_decode_error`` is optional. When provided, response streaming calls
    it instead of ``finish`` if the transport decoder cannot prove a compressed
    response body completed. It should publish connector-owned unparsed state so
    later fallback parsing does not trust best-effort decoded bytes. This runs
    before an opted-in interrupted response is reported.

    ``should_continue`` is optional and only valid for one-document parsers
    whose errors are permanent. Response decoding checks it after each parser
    callback and intentionally stops inspection once it returns false. Event-
    or line-scoped parsers that recover on later input must leave it unset.
    """

    feed: Callable[[bytes], None]
    report_on_interruption: bool
    finish: Callable[[], None] | None = None
    finish_decode_error: Callable[[str], None] | None = None
    should_continue: Callable[[], bool] | None = None
