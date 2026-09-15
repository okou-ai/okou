/** Raw provider boundary cases shared by both real memory workers. */
export const nativeMemoryQuotaCases: readonly {
  name: string;
  payload: unknown;
  raw?: string;
  reason?: "quota_below_threshold" | "quota_limit_reached";
  status?: number;
}[] = [
  ...(["primary_window", "secondary_window"] as const).flatMap((window) => {
    return [74.999, 75, 75.0001, 100, 101].map((used) => {
      return {
        name: `${window} used ${used}`,
        payload: { rate_limit: { [window]: { used_percent: used } } },
        ...(used > 75 ? { reason: "quota_below_threshold" as const } : {}),
      };
    });
  }),
  ...[
    "rate_limit_reached",
    "workspace_owner_credits_depleted",
    "workspace_member_credits_depleted",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
  ].flatMap((type) => {
    return [
      undefined,
      { primary_window: { used_percent: 1 } },
      { primary_window: "broken", secondary_window: { used_percent: -2 } },
    ].map((rateLimit) => {
      return {
        name: `${type} with ${JSON.stringify(rateLimit)}`,
        payload: {
          rate_limit_reached_type: { type },
          rate_limit: rateLimit,
          plan_type: { malformed: true },
        },
        reason: "quota_limit_reached" as const,
      };
    });
  }),
  ...[{ allowed: false }, { limit_reached: true }].flatMap((flag) => {
    return [undefined, { used_percent: 0 }, "broken"].map((primaryWindow) => {
      return {
        name: `${JSON.stringify(flag)} with ${JSON.stringify(primaryWindow)}`,
        payload: { rate_limit: { ...flag, primary_window: primaryWindow } },
        reason: "quota_limit_reached" as const,
      };
    });
  }),
  {
    name: "low primary beats malformed secondary",
    payload: {
      rate_limit: {
        primary_window: { used_percent: 90 },
        secondary_window: "broken",
      },
    },
    reason: "quota_below_threshold",
  },
  {
    name: "low secondary beats malformed primary",
    payload: {
      rate_limit: {
        primary_window: { used_percent: -3 },
        secondary_window: { used_percent: 90 },
      },
    },
    reason: "quota_below_threshold",
  },
  {
    name: "nonfinite raw usage",
    payload: {},
    raw: '{"rate_limit":{"primary_window":{"used_percent":1e309}}}',
  },
  {
    name: "nonfinite raw sibling preserves low window",
    payload: {},
    raw: '{"rate_limit":{"primary_window":{"used_percent":1e309},"secondary_window":{"used_percent":75.001}}}',
    reason: "quota_below_threshold",
  },
  {
    name: "both healthy",
    payload: {
      rate_limit: {
        primary_window: { used_percent: 75 },
        secondary_window: { used_percent: 25 },
      },
    },
  },
  { name: "missing metadata", payload: {} },
  { name: "malformed root", payload: ["broken"] },
  {
    name: "negative usage",
    payload: { rate_limit: { primary_window: { used_percent: -1 } } },
  },
  {
    name: "malformed usage",
    payload: { rate_limit: { secondary_window: { used_percent: "90" } } },
  },
  {
    name: "unrecognized reached object",
    payload: {
      rate_limit_reached_type: { type: "future-secret-provider-value" },
    },
  },
  {
    name: "additional bucket does not replace ordinary quota",
    payload: { additional_rate_limits: [{ rate_limit: { allowed: false } }] },
  },
  {
    name: "HTTP failure without denial",
    payload: { error: "private error text" },
    status: 503,
  },
  {
    name: "HTTP failure preserves denial",
    payload: { rate_limit: { allowed: false } },
    status: 429,
    reason: "quota_limit_reached",
  },
];
