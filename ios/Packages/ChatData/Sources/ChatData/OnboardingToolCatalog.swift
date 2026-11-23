import Foundation

public struct OnboardingTool: Identifiable, Sendable {
  public let id: String
  public let title: String
  public let description: String
}

/// Router owns family names and discovery. This public request never uses API credentials.
public struct OnboardingToolCatalog: Sendable {
  private let url: URL
  private let session: URLSession
  public init(url: URL, session: URLSession = .shared) {
    self.url = url
    self.session = session
  }

  public func tools(locale: String) async throws -> [OnboardingTool] {
    var cursor: String?
    var cursors = Set<String>()
    var families: [OnboardingRouterFamily] = []
    var listed = Set<String>()
    repeat {
      let data = try await APIClient.publicToolCatalogPage(
        at: url, cursor: cursor, session: session)
      try Task.checkCancellation()
      let page = try JSONDecoder().decode(OnboardingRouterEnvelope.self, from: data).result
      for family in page._meta.data.families {
        let isKnown = families.contains(where: { $0.id == family.id })
        if !isKnown { families.append(family) }
      }
      listed.formUnion(page.tools.compactMap { $0._meta?.data?.family })
      cursor = page.nextCursor
      if let cursor, !cursors.insert(cursor).inserted { throw APIClientError.invalidResponse }
    } while cursor != nil
    return families.filter {
      listed.contains($0.id) && !["web-search", "image-generation"].contains($0.id)
    }
    .map {
      OnboardingTool(
        id: $0.id, title: $0.title[locale] ?? $0.title["en-US"] ?? $0.id,
        description: $0.description[locale] ?? $0.description["en-US"] ?? "")
    }
  }
}

private struct OnboardingRouterFamily: Decodable {
  let id: String
  let title: [String: String]
  let description: [String: String]
}

private struct OnboardingRouterToolMeta: Decodable {
  struct DataMeta: Decodable { let family: String }
  let data: DataMeta?
  enum CodingKeys: String, CodingKey { case data = "ai.okou/data" }
}

private struct OnboardingRouterPageMeta: Decodable {
  struct DataMeta: Decodable { let families: [OnboardingRouterFamily] }
  let data: DataMeta
  enum CodingKeys: String, CodingKey { case data = "ai.okou/data" }
}

private struct OnboardingRouterPage: Decodable {
  struct Tool: Decodable { let _meta: OnboardingRouterToolMeta? }
  let tools: [Tool]
  let nextCursor: String?
  let _meta: OnboardingRouterPageMeta
}

private struct OnboardingRouterEnvelope: Decodable { let result: OnboardingRouterPage }
