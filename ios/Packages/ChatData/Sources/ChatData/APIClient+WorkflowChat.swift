import Foundation

extension APIClient {
  /// Workflow details expose only the caller's automations and their shared chat.
  /// Reading a source link must never create a thread or run the workflow.
  public func workflowChatThreadID(_ workflowID: String) async throws -> String? {
    let detail: WorkflowChatDetail = try await request("/api/workflows/\(workflowID)")
    let ids = Set(detail.automations.compactMap(\.chatThreadId))
    guard ids.count <= 1, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else {
      throw APIClientError.incompatibleData
    }
    return ids.first
  }
}

private struct WorkflowChatDetail: Decodable, Sendable {
  let automations: [Automation]
  struct Automation: Decodable, Sendable { let chatThreadId: String? }
}
