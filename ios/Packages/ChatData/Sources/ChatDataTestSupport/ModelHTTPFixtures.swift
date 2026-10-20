import Foundation

/// Synthetic HTTP examples shared by data, native state and presentation tests.
public enum ModelHTTPFixtures {
  public static let threadID = "97000000-0000-4000-8000-000000000001"
  public static let agentID = "97000000-0000-4000-8000-000000000002"
  public static let accountID = "97000000-0000-4000-8000-000000000003"
  public static let preference = """
    {"selectedModel":"codex-model","serviceTier":null,"modelSettings":{"codex-model":{"effort":"ultra"},"claude-model":{"effort":"extra"}},"selectedImageModel":null,"updatedAt":null}
    """
  public static let features = """
    {"effectiveSwitches":{"subscriptionLinkingEntry":true,"_codexExecution":false}}
    """
  public static let models = """
    {"models":[
    {"model":"auto","modelLabel":"Auto","memberEffective":{"availability":"available","providerType":"built-in","runtimeProviderType":"openrouter-codex"}},
    {"model":"codex-model","modelLabel":"Codex Example","memberEffective":{"availability":"available","providerType":"codex-oauth-token","runtimeProviderType":"codex-oauth-token"},"subscriptionOptions":{"serviceTier":"priority","efforts":["low","medium","high","xhigh","max","ultra"]}},
    {"model":"claude-model","modelLabel":"Claude Example","memberEffective":{"availability":"available","providerType":"claude-code-oauth-token","runtimeProviderType":"claude-code-oauth-token"},"subscriptionOptions":{"serviceTier":null,"efforts":["low","medium","high","extra","max","ultracode"]}}]}
    """
  public static let catalog = """
    {"models":[
    {"model":"auto","resolvedModel":"auto","displayName":"Auto","sortOrder":0,"replacedBy":null},
    {"model":"retired","resolvedModel":"codex-model","displayName":"Retired Example","sortOrder":1,"replacedBy":"codex-model"},
    {"model":"codex-model","resolvedModel":"codex-model","displayName":"Codex Example","sortOrder":2,"replacedBy":null,"piRouteClass":"gpt-codex","runOptions":{"fast":{"chatGptUsageMultiplier":3.75}}},
    {"model":"claude-model","resolvedModel":"claude-model","displayName":"Claude Example","sortOrder":3,"replacedBy":null}],
    "routes":[
    {"model":"codex-model","providerType":"codex-oauth-token","concreteProviderType":"codex-oauth-token","enabled":true,"priority":0,"efforts":["low","medium","high","xhigh","max","ultra"],"defaultEffort":"medium","piRuntimeCapable":true},
    {"model":"claude-model","providerType":"claude-code-oauth-token","concreteProviderType":"claude-code-oauth-token","enabled":true,"priority":0,"efforts":["low","medium","high","extra","max","ultracode"],"defaultEffort":"high","piRuntimeCapable":false}]}
    """
  public static let metadata = """
    {"id":"\(threadID)","agentId":"\(agentID)","selectedModel":"codex-model","modelSettings":{"codex-model":{"effort":"max"}},"serviceTier":null,"cloudBrowserEnabled":false,"computerUseHostId":null}
    """
  public static let subscriptions = """
    {"subscriptions":[{"id":"\(accountID)","type":"codex-oauth-token","isActive":true,"accountEmail":"sample@example.invalid","planType":"pro","needsReconnect":false,"lastRefreshErrorCode":null,"subscriptionResetCredits":2,"subscriptionResetSupported":true,"subscriptionResetCreditsNextExpiresAt":"2030-12-01T00:00:00Z","subscriptionUsage":{"fiveHour":{"usedPercent":20,"remainingPercent":80,"resetAt":"2030-10-20T08:00:00Z","windowSeconds":18000},"weekly":{"usedPercent":70,"remainingPercent":30,"resetAt":"2030-10-25T00:00:00Z","windowSeconds":604800}}}]}
    """
  public static func response(_ path: String) -> ChatHTTPResponse? {
    switch path {
    case "/api/user-model-preference": ChatHTTPResponse(body: preference)
    case "/api/run-models": ChatHTTPResponse(body: models)
    case "/api/model-catalog": ChatHTTPResponse(body: catalog)
    case "/api/feature-switches": ChatHTTPResponse(body: features)
    case "/api/me/3rd-party-subscriptions": ChatHTTPResponse(body: subscriptions)
    case "/api/chat-threads/\(threadID)/metadata": ChatHTTPResponse(body: metadata)
    default: nil
    }
  }
}
