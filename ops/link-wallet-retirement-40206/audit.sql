-- One statement gives every count the same snapshot without an explicit transaction.
WITH connections AS (
  SELECT
    count(*)::text AS total,
    count(*) FILTER (WHERE revoked_at IS NULL AND agent_id IS NOT NULL)::text AS active_agent_owned,
    count(*) FILTER (WHERE revoked_at IS NULL AND agent_id IS NULL)::text AS active_workspace_user,
    count(*) FILTER (WHERE revoked_at IS NULL AND oauth_requested_scopes IS NULL)::text AS active_missing_requested_scopes,
    count(*) FILTER (WHERE revoked_at IS NOT NULL AND agent_id IS NOT NULL)::text AS revoked_agent_owned,
    count(*) FILTER (WHERE revoked_at IS NOT NULL AND revocation_confirmed_at IS NULL)::text AS revocation_pending
  FROM public.link_wallet_connections
), attempts AS (
  SELECT
    count(*)::text AS total,
    count(*) FILTER (WHERE scope = 'agent')::text AS legacy_total,
    count(*) FILTER (WHERE scope = 'agent' AND status IN ('pending', 'exchanging') AND expires_at > statement_timestamp())::text AS live_legacy,
    count(*) FILTER (WHERE scope = 'agent' AND status IN ('pending', 'exchanging') AND expires_at <= statement_timestamp())::text AS expired_legacy,
    count(*) FILTER (WHERE scope = 'agent' AND status = 'completed')::text AS completed_legacy,
    count(*) FILTER (WHERE oauth_requested_scopes IS NULL AND status IN ('pending', 'exchanging') AND expires_at > statement_timestamp())::text AS live_missing_requested_scopes,
    count(*) FILTER (WHERE scope NOT IN ('agent', 'workspace_user'))::text AS unexpected_scope,
    count(*) FILTER (WHERE status NOT IN ('pending', 'exchanging', 'completed', 'failed'))::text AS unexpected_status
  FROM public.link_wallet_oauth_attempts
)
SELECT jsonb_build_object(
  'observedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'readOnly', current_setting('transaction_read_only') = 'on',
  'connections', jsonb_build_object(
    'total', connections.total,
    'activeAgentOwned', connections.active_agent_owned,
    'activeWorkspaceUser', connections.active_workspace_user,
    'activeMissingRequestedScopes', connections.active_missing_requested_scopes,
    'revokedAgentOwned', connections.revoked_agent_owned,
    'revocationPending', connections.revocation_pending
  ),
  'oauthAttempts', jsonb_build_object(
    'total', attempts.total,
    'legacyTotal', attempts.legacy_total,
    'liveLegacy', attempts.live_legacy,
    'expiredLegacy', attempts.expired_legacy,
    'completedLegacy', attempts.completed_legacy,
    'liveMissingRequestedScopes', attempts.live_missing_requested_scopes,
    'unexpectedScope', attempts.unexpected_scope,
    'unexpectedStatus', attempts.unexpected_status
  )
)
FROM connections CROSS JOIN attempts;
