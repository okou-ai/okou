import ChatData
import Foundation

struct CreditUsageDisplayRow: Equatable, Identifiable {
  let id: String
  let label: String
  var credits: Int
}

enum CreditUsageDisplay {
  static func credits(_ value: Int, locale: Locale = .current) -> String {
    value.formatted(.number.locale(locale))
  }

  /// Match PWA UsageChip: merge managed capabilities by kind and model aliases
  /// by their recorded catalog identity. Never resolve a retired model's successor.
  static func rows(_ usage: ChatRunUsage, catalog: ModelCatalog?) -> [CreditUsageDisplayRow] {
    var result: [CreditUsageDisplayRow] = []
    for kind in usage.breakdown {
      for provider in kind.providers {
        let parsed = parse(kind.kind, provider: provider.provider)
        let base = String(
          parsed.kind.split(separator: "/", omittingEmptySubsequences: false).first ?? "")
        let managed = managedName(base)
        let identity =
          parsed.kind == "model" ? modelIdentity(parsed.provider, catalog: catalog) : nil
        let id = managed != nil ? "kind:\(base)" : "\(parsed.kind):\(identity ?? parsed.provider)"
        if let index = result.firstIndex(where: { $0.id == id }) {
          result[index].credits += provider.credits
        } else {
          result.append(
            CreditUsageDisplayRow(
              id: id,
              label: managed
                ?? name(kind: parsed.kind, provider: parsed.provider, catalog: catalog),
              credits: provider.credits))
        }
      }
    }
    return result
  }

  private static func parse(_ kind: String, provider: String) -> (kind: String, provider: String) {
    let parts = kind.components(separatedBy: "/")
    guard let base = parts.first, ["model", "image", "video"].contains(base), parts.count >= 2
    else {
      return (kind, provider)
    }
    let end =
      parts.indices.first {
        $0 > 1 && (parts[$0].hasPrefix("tokens.") || parts[$0].hasPrefix("output_"))
      } ?? parts.count
    let embedded = parts[1..<end].joined(separator: "/")
    return embedded.isEmpty ? (kind, provider) : (base, embedded)
  }

  private static func name(kind: String, provider: String, catalog: ModelCatalog?) -> String {
    guard !provider.isEmpty, provider != "unknown" else { return title(kind) }
    let value = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    if kind == "model" {
      if let special = specialName(value) { return special }
      guard let catalog else { return String(localized: "Models") }
      let identity = modelIdentity(value, catalog: catalog)
      return catalog.models.first { $0.model == identity }?.displayName ?? value
    }
    if kind == "image" || kind == "video" {
      if let special = specialName(value) { return special }
      if let name = generationNames[value] { return name }
      var stripped = value
      for prefix in ["fal-ai/", "bytedance/", "dreamina-"] where stripped.hasPrefix(prefix) {
        stripped = String(stripped.dropFirst(prefix.count))
        break
      }
      return generationNames[stripped] ?? title(stripped)
    }
    return title(value)
  }

  private static func modelIdentity(_ raw: String, catalog: ModelCatalog?) -> String? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if value == "auto" || value == "okou-1.0"
      || (value.hasPrefix("@preset/") && value.count > 8 && value.count <= 255)
    {
      return "auto"
    }
    guard let catalog else { return nil }
    if catalog.models.contains(where: { $0.model == value }) { return value }
    var historical = value
    for prefix in ["openai/", "anthropic/", "google/", "deepseek/"] where value.hasPrefix(prefix) {
      historical = String(value.dropFirst(prefix.count))
      break
    }
    var candidates = Set(
      catalog.routes.filter {
        $0.upstreamModel == value || $0.upstreamModel == historical
      }.map(\.model))
    for model in catalog.models {
      let dotted = model.model.replacingOccurrences(
        of: #"-(\d+)-(\d+)$"#, with: "-$1.$2", options: .regularExpression)
      if model.model == historical || (model.model.hasPrefix("claude-") && dotted == historical) {
        candidates.insert(model.model)
      }
    }
    guard candidates.count == 1, let identity = candidates.first,
      catalog.models.contains(where: { $0.model == identity })
    else { return nil }
    return identity
  }

  private static func specialName(_ value: String) -> String? {
    switch value {
    case "heygen-avatar-iii", "joggai-talking-avatar": String(localized: "Avatar")
    case "google/gemini-3.5-flash": String(localized: "Image Recognition")
    default: nil
    }
  }

  private static func managedName(_ kind: String) -> String? {
    switch kind {
    case "scrape": String(localized: "Web Fetch")
    case "maps": String(localized: "Maps")
    case "web-search": String(localized: "Web Search")
    case "people-search": String(localized: "People Search")
    case "seo": String(localized: "SEO")
    case "social": String(localized: "Social Search")
    case "finance": String(localized: "Finance")
    case "weather": String(localized: "Weather")
    case "image-recognition": String(localized: "Image Recognition")
    case "translation": String(localized: "Translation")
    default: nil
    }
  }

  private static func title(_ value: String) -> String {
    let tokens = value.trimmingCharacters(in: .whitespacesAndNewlines)
      .components(separatedBy: CharacterSet(charactersIn: "/._-"))
      .filter { !$0.isEmpty }
    guard !tokens.isEmpty else { return String(localized: "Usage") }
    return tokens.map {
      let upper = $0.uppercased()
      return ["AI", "API", "GLM", "GPT", "ID", "SQL", "URL"].contains(upper)
        ? upper : $0.prefix(1).uppercased() + $0.dropFirst()
    }.joined(separator: " ")
  }

  // Generation tools have no run-model catalog. These are the same product labels
  // and supported aliases as core/image-model-catalog and core/model-display-name.
  private static let generationNames: [String: String] = [
    "gpt-image-1": "GPT Image 1", "gpt-image-2": "GPT Image 2",
    "gpt-image-2.5-flare": "GPT Image 2.5 Flare",
    "gpt-image-2.5-sunburst": "GPT Image 2.5 Sunburst",
    "fal-ai/flux-pro/v1.1": "Flux Pro v1.1", "flux-pro-1.1": "Flux Pro v1.1",
    "fal-ai/flux-pro/v1.1-ultra": "Flux Pro v1.1 Ultra",
    "flux-pro-1.1-ultra": "Flux Pro v1.1 Ultra",
    "fal-ai/flux-2-pro": "FLUX.2 Pro", "flux-2-pro": "FLUX.2 Pro",
    "alibaba/qwen-image-3/text-to-image": "Qwen Image 3", "qwen-image-3": "Qwen Image 3",
    "ideogram/v4": "Ideogram 4", "ideogram-4": "Ideogram 4",
    "fal-ai/bytedance/seedream/v4/text-to-image": "Seedream 4", "seedream4": "Seedream 4",
    "fal-ai/nano-banana-2": "Nano Banana 2", "nano-banana-2": "Nano Banana 2",
    "nano-banana2": "Nano Banana 2", "google/nano-banana-2-lite": "Nano Banana 2 Lite",
    "nano-banana-2-lite": "Nano Banana 2 Lite", "nano-banana2-lite": "Nano Banana 2 Lite",
    "dreamina-seedance-2-5-260628": "Seedance 2.5",
    "dreamina-seedance-2-0-260128": "Seedance 2.0",
    "dreamina-seedance-2-0-fast-260128": "Seedance 2.0 Fast",
    "dreamina-seedance-2-0-mini-260615": "Seedance 2.0 Mini",
    "seedance-2-0-260128": "Seedance 2.0", "seedance-2-0-fast-260128": "Seedance 2.0 Fast",
    "seedance-1-5-pro-251215": "Seedance 1.5 Pro", "MiniMax-H3": "MiniMax H3",
    "fal-ai/veo3.1": "Veo 3.1", "fal-ai/veo3.1/fast": "Veo 3.1 Fast",
    "fal-ai/kling-video/o3/standard/text-to-video": "Kling O3 Standard",
    "fal-ai/kling-video/v3/4k/text-to-video": "Kling 3 4K",
  ]
}
