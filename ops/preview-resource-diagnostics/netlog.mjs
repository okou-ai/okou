// Retain transport metadata, never arbitrary headers, bodies or command lines.
const numeric = new Set([
  "stream_id",
  "last_accepted_stream_id",
  "error_code",
  "net_error",
  "byte_count",
  "size",
  "delta",
  "window_size",
  "initial_window_size",
  "connection_id",
  "packet_number",
  "length",
  "fin",
  "is_ack",
  "flags",
  "priority",
  "load_flags",
  "socket_id",
  "source_start_time",
  "count",
  "received_bytes",
  "sent_bytes",
  "bytes_copied",
  "bytes_read",
  "bytes_written",
  "error",
  "id",
  "value",
]);
const responseHeaders = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "cf-ray",
  "cf-cache-status",
  "etag",
  "age",
  ":status",
]);

export function safeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      responseHeaders.has(name.toLowerCase()),
    ),
  );
}

export function sanitizeNetlog(log, allowedUrls) {
  if (!Array.isArray(log.events) || !log.constants?.logEventTypes) {
    throw new Error("Invalid Chromium NetLog");
  }
  const constants = {};
  for (const name of [
    "logEventTypes",
    "logEventPhase",
    "logSourceType",
    "netError",
  ]) {
    if (log.constants[name]) constants[name] = log.constants[name];
  }
  for (const name of ["logFormatVersion", "timeTickOffset"]) {
    const value = log.constants[name];
    if (
      typeof value === "number" ||
      (typeof value === "string" && /^\d+$/u.test(value))
    ) {
      constants[name] = value;
    }
  }
  const events = log.events.map((event) => {
    const params = {};
    for (const [key, value] of Object.entries(event.params ?? {})) {
      if (
        numeric.has(key) &&
        (typeof value === "number" || typeof value === "boolean")
      ) {
        params[key] = value;
      } else if (
        key === "source_dependency" &&
        Number.isInteger(value?.id) &&
        Number.isInteger(value?.type)
      ) {
        params[key] = { id: value.id, type: value.type };
      } else if (key === "url" && allowedUrls.has(value)) {
        params.url = value;
      } else if (
        key === "error_code" &&
        typeof value === "string" &&
        /^(?:\d+ \()?(?:NO_ERROR|PROTOCOL_ERROR|INTERNAL_ERROR|FLOW_CONTROL_ERROR|SETTINGS_TIMEOUT|STREAM_CLOSED|FRAME_SIZE_ERROR|REFUSED_STREAM|CANCEL|COMPRESSION_ERROR|CONNECT_ERROR|ENHANCE_YOUR_CALM|INADEQUATE_SECURITY|HTTP_1_1_REQUIRED)\)?$/u.test(
          value,
        )
      ) {
        params.error_code = value;
      } else if (key === "settings" && Array.isArray(value)) {
        params.settings = value.filter(
          (setting) =>
            typeof setting === "string" &&
            /^(?:\[id:\d+\])?[A-Z_]+ = \d+$/u.test(setting),
        );
      } else if (key === "headers" && Array.isArray(value)) {
        params.headers = value.filter((header) => {
          if (typeof header !== "string") return false;
          const match =
            /^(content-type|content-length|content-encoding|cf-ray|cf-cache-status|etag|age|:status): /iu.exec(
              header,
            );
          return Boolean(match);
        });
      }
    }
    return {
      time: event.time,
      type: event.type,
      phase: event.phase,
      source: { id: event.source.id, type: event.source.type },
      params,
    };
  });
  return { constants, events };
}
