import ChatDomain
import Foundation

public struct ChatModelSelection: Codable, Equatable, Sendable {
  public var model: String?
  public var serviceTier: String?
  public var modelSettings: [String: ThreadModelSetting]

  public init(
    model: String? = nil, serviceTier: String? = nil,
    modelSettings: [String: ThreadModelSetting] = [:]
  ) {
    self.model = Self.normalized(model)
    self.serviceTier = serviceTier
    self.modelSettings = modelSettings
  }

  public init(thread: ChatThread) {
    self.init(
      model: thread.selectedModel, serviceTier: thread.serviceTier,
      modelSettings: thread.modelSettings)
  }

  static func normalized(_ model: String?) -> String? {
    model == "auto" || model == "okou-1.0" ? nil : model
  }
}

public struct ModelPreference: Decodable, Sendable {
  public let selectedModel: String?
  public let serviceTier: String?
  public let modelSettings: [String: ThreadModelSetting]?
}

public struct AvailableRunModels: Decodable, Sendable {
  public let models: [Model]
  public struct Model: Decodable, Identifiable, Sendable {
    public let model: String?
    public let memberEffective: MemberRoute
    public let subscriptionOptions: SubscriptionOptions?
    public var id: String { model ?? "auto" }
    public var selectedModel: String? { ChatModelSelection.normalized(model) }

    public struct MemberRoute: Decodable, Sendable {
      public let availability: String
      public let providerType: String
      public let runtimeProviderType: String?
    }
    public struct SubscriptionOptions: Decodable, Sendable {
      public let serviceTier: String?
      public let efforts: [String]
    }
    public var isConfigurable: Bool {
      ["available", "reconnect_required"].contains(memberEffective.availability)
    }
    public func hasUsableRoute() -> Bool {
      isConfigurable || memberEffective.availability == "plan_restricted"
    }
    public func supportsServiceTier(_ tier: String) -> Bool {
      selectedModel != nil && tier == "priority" && subscriptionOptions?.serviceTier == tier
    }
  }
}

public struct ModelCatalog: Decodable, Sendable {
  public let models: [Model]
  public let routes: [Route]
  public struct Model: Decodable, Sendable {
    public let model: String
    public let resolvedModel: String
    public let displayName: String
    public let sortOrder: Int
    public let replacedBy: String?
    public let runOptions: RunOptions?
    public struct RunOptions: Decodable, Sendable {
      public let fast: Fast?
      public struct Fast: Decodable, Sendable {
        public let chatGptUsageMultiplier: Double
      }
    }
  }
  public struct Route: Decodable, Sendable {
    public let model: String
    public let upstreamModel: String
    public let providerType: String
    public let concreteProviderType: String
    public let enabled: Bool
    public let priority: Int
    public let efforts: [String]
    public let defaultEffort: String?
    public let piRuntimeCapable: Bool?
  }
  public func resolve(_ model: String) -> String? {
    models.first(where: { $0.model == model })?.resolvedModel
  }
  public func name(_ model: String?) -> String {
    guard let model = ChatModelSelection.normalized(model) else { return "Auto" }
    return models.first(where: { $0.model == model })?.displayName ?? model
  }
  public func order(_ model: String?) -> Int {
    guard let model else { return 0 }
    return models.first(where: { $0.model == model })?.sortOrder ?? Int.max
  }
  public func fastMultiplier(_ model: String?) -> Double? {
    models.first(where: { $0.model == model })?.runOptions?.fast?.chatGptUsageMultiplier
  }
  func matchingRoutes(_ row: AvailableRunModels.Model) -> [Route] {
    routes.filter {
      $0.enabled && $0.model == row.selectedModel
        && $0.providerType == row.memberEffective.providerType
        && (row.memberEffective.runtimeProviderType == nil
          || $0.concreteProviderType == row.memberEffective.runtimeProviderType)
    }.sorted { $0.priority < $1.priority }
  }
}

/// A projection of canonical API metadata. It owns no personal credentials or quota reads.
public struct ChatModelConfiguration: Sendable {
  public let preference: ModelPreference
  public let available: AvailableRunModels
  public let catalog: ModelCatalog
  public let switches: [String: Bool]

  public func withPreference(_ preference: ModelPreference) -> ChatModelConfiguration {
    ChatModelConfiguration(
      preference: preference, available: available, catalog: catalog, switches: switches)
  }
  public var canLinkSubscriptions: Bool { switches["subscriptionLinkingEntry"] == true }
  public var models: [AvailableRunModels.Model] {
    available.models.sorted {
      let a = catalog.order($0.selectedModel)
      let b = catalog.order($1.selectedModel)
      return a == b ? $0.id < $1.id : a < b
    }
  }
  public func row(for selection: ChatModelSelection) -> AvailableRunModels.Model? {
    models.first { $0.selectedModel == selection.model }
  }
  public var defaultSelection: ChatModelSelection {
    let raw = ChatModelSelection.normalized(preference.selectedModel)
    let resolved = raw.flatMap(catalog.resolve)
    let model = resolved.flatMap { id in
      models.contains { $0.selectedModel == id && $0.hasUsableRoute() } ? id : nil
    }
    let selection = ChatModelSelection(model: model, modelSettings: preference.modelSettings ?? [:])
    return ChatModelSelection(
      model: model,
      serviceTier: preference.serviceTier == "priority"
        && row(for: selection)?.supportsServiceTier("priority") == true ? "priority" : nil,
      modelSettings: selection.modelSettings)
  }
  public func resolved(_ selection: ChatModelSelection) -> ChatModelSelection {
    var result = selection
    if let model = result.model, let resolved = catalog.resolve(model) { result.model = resolved }
    if row(for: result)?.supportsServiceTier("priority") != true { result.serviceTier = nil }
    return result
  }
  public func efforts(for selection: ChatModelSelection) -> [String] {
    guard selection.model != nil, let row = row(for: selection), row.isConfigurable,
      row.memberEffective.runtimeProviderType != nil
    else { return [] }
    let routes = catalog.matchingRoutes(row)
    let pi =
      switches["_codexExecution"] != true
      && routes.first?.piRuntimeCapable == true
      && row.memberEffective.providerType == "codex-oauth-token"
    var seen = Set<String>()
    return routes.flatMap(\.efforts).filter {
      ["low", "medium", "high", "xhigh", "extra", "max", "ultra"].contains($0)
        && (!pi || $0 != "ultra")
        && (row.subscriptionOptions == nil
          || row.subscriptionOptions?.efforts.contains($0) == true)
        && seen.insert($0).inserted
    }
  }
  public func effectiveEffort(for selection: ChatModelSelection) -> String? {
    let choices = efforts(for: selection)
    if let model = selection.model, let saved = selection.modelSettings[model]?.effort,
      choices.contains(saved)
    {
      return saved
    }
    guard let row = row(for: selection) else { return nil }
    return catalog.matchingRoutes(row).compactMap(\.defaultEffort).first.flatMap {
      choices.contains($0) ? $0 : nil
    }
  }
  public func canUseFast(_ selection: ChatModelSelection) -> Bool {
    row(for: selection).map { $0.isConfigurable && $0.supportsServiceTier("priority") } ?? false
  }
  public func requestedEffort(for selection: ChatModelSelection) -> String? {
    guard let model = selection.model, let saved = selection.modelSettings[model]?.effort,
      efforts(for: selection).contains(saved)
    else { return nil }
    return saved
  }
}

public struct ChatModelService: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func catalog() async throws -> ModelCatalog {
    try await client.request("/api/model-catalog")
  }

  public func load() async throws -> ChatModelConfiguration {
    async let preference: ModelPreference = client.request("/api/user-model-preference")
    async let models: AvailableRunModels = client.request("/api/run-models")
    async let catalog: ModelCatalog = client.request("/api/model-catalog")
    async let features: SidebarFeatureSwitches = client.request("/api/feature-switches")
    let configuration = try await ChatModelConfiguration(
      preference: preference, available: models, catalog: catalog,
      switches: features.effectiveSwitches)
    guard
      configuration.catalog.routes.allSatisfy({ $0.piRuntimeCapable != nil })
    else {
      throw APIClientError.incompatibleData
    }
    return configuration
  }
  public func selection(threadID: String) async throws -> ChatModelSelection {
    let metadata: ThreadMetadata = try await client.request(
      "/api/chat-threads/\(threadID)/metadata")
    return ChatModelSelection(
      model: metadata.selectedModel, serviceTier: metadata.serviceTier,
      modelSettings: metadata.modelSettings ?? [:])
  }
  public func save(_ selection: ChatModelSelection, effort: String?, threadID: String) async throws
  {
    let body = SelectionBody(
      model: selection.model, reasoningEffort: effort,
      codexServiceTier: selection.serviceTier == "priority" ? "fast" : nil)
    try await client.data(
      "/api/chat-threads/\(threadID)/model-selection", method: "POST",
      body: JSONEncoder().encode(body))
  }
  public func saveDefault(_ selection: ChatModelSelection, effort: String?) async throws
    -> ModelPreference
  {
    struct Body: Encodable {
      let selectedModel: String?
      let serviceTier: String?
      let modelSettingsPatch: ThreadModelSettingsPatch?
      enum Keys: String, CodingKey { case selectedModel, serviceTier, modelSettingsPatch }
      func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(selectedModel, forKey: .selectedModel)
        try c.encode(serviceTier, forKey: .serviceTier)
        try c.encodeIfPresent(modelSettingsPatch, forKey: .modelSettingsPatch)
      }
    }
    return try await client.request(
      "/api/user-model-preference", method: "PUT",
      body: JSONEncoder().encode(
        Body(
          selectedModel: selection.model, serviceTier: selection.serviceTier,
          modelSettingsPatch: selection.model.flatMap { model in
            effort.map { .init(model: model, effort: $0) }
          })))
  }
  private struct SelectionBody: Encodable {
    let model: String?
    let reasoningEffort: String?
    let codexServiceTier: String?
    enum Keys: String, CodingKey { case model, reasoningEffort, codexServiceTier }
    func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: Keys.self)
      try c.encode(model, forKey: .model)
      try c.encode(codexServiceTier, forKey: .codexServiceTier)
      try c.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
    }
  }
}
