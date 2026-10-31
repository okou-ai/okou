// New direct App validator imports replace schema property reads on an already
// imported baseline router. Retain that same schema object, without rewriting
// baseline wire/schema sources or silently dropping a new runtime root.
const prefix = "@okouai/api-contracts";
function route(module, imported, ...access) {
  return {
    source: `${prefix}/contracts/${module}`,
    imported,
    ...(access.length ? { access } : {}),
  };
}

export const baselineExpressionRoots = {
  [`${prefix}/validators/chat-threads#composerDraftSchema`]: route(
    "chat-threads",
    "chatThreadDraftSchema",
  ),
  // Defining-module imports replace prior forwarding-only exports; the baseline
  // must retain the old App-imported path, not a new source-module root.
  [`${prefix}/validators/ssh-credentials#SSH_DISPLAY_NAME_MAX_LENGTH`]: route(
    "ssh-connections",
    "SSH_DISPLAY_NAME_MAX_LENGTH",
  ),
  [`${prefix}/validators/ssh-credentials#SSH_USERNAME_MAX_LENGTH`]: route(
    "ssh-connections",
    "SSH_USERNAME_MAX_LENGTH",
  ),
  [`${prefix}/validators/ssh-credentials#SSH_PRIVATE_KEY_MAX_LENGTH`]: route(
    "ssh-connections",
    "SSH_PRIVATE_KEY_MAX_LENGTH",
  ),
  [`${prefix}/validators/ssh-credentials#SSH_PASSPHRASE_MAX_LENGTH`]: route(
    "ssh-connections",
    "SSH_PASSPHRASE_MAX_LENGTH",
  ),
  [`${prefix}/contracts/vnc-transport#VNC_HOST_MAX_LENGTH`]: route(
    "vnc-connections",
    "VNC_HOST_MAX_LENGTH",
  ),
  [`${prefix}/contracts/vnc-transport#VNC_CA_BUNDLE_MAX_LENGTH`]: route(
    "vnc-connections",
    "VNC_CA_BUNDLE_MAX_LENGTH",
  ),
  [`${prefix}/validators/chat-threads#indicatorsSchema`]: route(
    "chat-threads",
    "chatThreadsContract",
    "indicators",
    "responses",
    200,
  ),
  [`${prefix}/validators/artifact-catalog#artifactIdPathParamsSchema`]: route(
    "artifact-catalog",
    "artifactCatalogContract",
    "get",
    "pathParams",
  ),
  [`${prefix}/validators/discord-oauth#discordOauthApprovalBodySchema`]: route(
    "discord-oauth",
    "discordOauthContract",
    "approve",
    "body",
  ),
  [`${prefix}/validators/cloudflare-access#createCloudflareAccessConfigRequestSchema`]:
    route("cloudflare-access", "cloudflareAccessContract", "create", "body"),
  [`${prefix}/validators/tailscale#createTailscaleConfigRequestSchema`]: route(
    "tailscale",
    "tailscaleContract",
    "create",
    "body",
  ),
  [`${prefix}/validators/tailscale#updateTailscaleConfigRequestSchema`]: route(
    "tailscale",
    "tailscaleContract",
    "update",
    "body",
  ),
  [`${prefix}/contracts/connector-schemas#connectorCompletedOperationResponseSchema`]:
    route(
      "connectors",
      "builtinConnectorManualGrantContract",
      "connect",
      "responses",
      200,
    ),
  [`${prefix}/contracts/connector-schemas#builtinConnectorOauthDeviceAuthSessionPollResponseSchema`]:
    route(
      "connectors",
      "builtinConnectorOauthDeviceAuthSessionContract",
      "poll",
      "responses",
      200,
    ),
  [`${prefix}/contracts/connector-schemas#builtinConnectorExternalCodeSessionCompleteResponseSchema`]:
    route(
      "connectors",
      "builtinConnectorExternalCodeSessionContract",
      "complete",
      "responses",
      200,
    ),
};
