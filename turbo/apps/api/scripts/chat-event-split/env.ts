import "../chat-event-acceptance/env";

// Own and await the existing publication/telemetry lifetime in this process.
Object.assign(process.env, {
  VITEST: "true",
  ABLY_API_KEY: "synthetic.key:synthetic-secret",
});
