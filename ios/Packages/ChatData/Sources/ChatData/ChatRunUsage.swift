import ChatDomain
import Foundation

/// Settled accounting returned by the canonical thread-scoped read, never event totals.
public struct ChatRunUsage: Decodable, Equatable, Sendable {
  public let version: Int
  public let totalCredits: Int
  public let settledAt: String
  public let breakdown: [Kind]

  public struct Kind: Decodable, Equatable, Sendable {
    public let kind: String
    public let credits: Int
    public let providers: [Provider]
  }
  public struct Provider: Decodable, Equatable, Sendable {
    public let provider: String
    public let credits: Int
  }

  var isValid: Bool {
    version == 1 && totalCredits >= 0 && !settledAt.isEmpty
      && breakdown.allSatisfy { $0.credits >= 0 && $0.providers.allSatisfy { $0.credits >= 0 } }
  }
}

extension ChatSync {
  public func runUsage(threadID: String, runIDs: [String]) async throws -> [String: ChatRunUsage] {
    struct Body: Encodable { let runIds: [String] }
    struct Response: Decodable, Sendable {
      struct Run: Decodable, Sendable {
        let runId: String
        let usage: ChatRunUsage
      }
      let runs: [Run]
    }
    let ids = Array(Set(runIDs)).sorted()
    guard !ids.isEmpty, ids.count <= 100 else {
      throw ChatError.invalidContract("Usage reads require between 1 and 100 runs.")
    }
    let response: Response = try await client.request(
      "/api/chat-threads/\(threadID)/usage", method: "POST",
      body: JSONEncoder().encode(Body(runIds: ids)))
    var result: [String: ChatRunUsage] = [:]
    for run in response.runs {
      guard ids.contains(run.runId), result[run.runId] == nil, run.usage.isValid else {
        throw APIClientError.incompatibleData
      }
      result[run.runId] = run.usage
    }
    return result
  }
}
