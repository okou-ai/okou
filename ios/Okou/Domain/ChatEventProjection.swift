import Foundation

enum ChatEventProjection {
  static func history(rows: [ChatEventRow], recovering: Bool) throws -> ChatHistory {
    let revoked = Set(rows.compactMap(\.revokesEventId))
    let terminated = Set(rows.filter { $0.eventType.isTerminal }.compactMap(\.runId))
    let interrupted = Set(rows.filter { $0.eventType == .controlInterrupt }.compactMap(\.runId))
    let activeRuns = Set(
      rows.filter {
        $0.eventType != .controlInterrupt && $0.eventType != .usageRecorded
          && !revoked.contains($0.id)
      }.compactMap(\.runId)
    ).subtracting(terminated)
    let queuedInputs = rows.filter {
      $0.eventType == .inputPrompt && $0.runId == nil && !revoked.contains($0.id)
    }.map(\.id)

    var messages: [ChatMessage] = []
    for row in rows where !revoked.contains(row.id) {
      let text: String
      let role: ChatMessage.Role
      let isError: Bool
      switch row.eventType {
      case .inputPrompt, .inputRejected, .inputAutomation:
        if row.eventType == .inputAutomation && row.payload?.userMessage == nil { continue }
        guard let document = row.payload?.userMessage, document.version == 1 else {
          throw ChatServiceError.invalidContract("Unsupported user message document.")
        }
        let body = document.parts.compactMap { part -> String? in
          switch part.type {
          case "text": part.text
          case "chat_thread", "source": part.titleSnapshot
          case "agent": part.nameSnapshot
          case "automation": part.workflowName
          case "file":
            part.filenameSnapshot.map {
              "Attachment: \($0) (open this chat on the website to view)"
            }
          default: nil
          }
        }.joined(separator: "\n")
        text = row.payload?.error.map { body + "\n\n" + $0 } ?? body
        role = .user
        isError = row.eventType == .inputRejected
      case .outputMessage:
        guard let content = row.payload?.content else {
          throw ChatServiceError.invalidContract("Assistant output is missing its content.")
        }
        text = visibleOutput(content)
        role = .assistant
        isError = false
      case .outputError, .runFailed:
        text =
          row.payload?.error ?? "This task failed. Open the chat on the Okou website for details."
        role = .system
        isError = true
      case .runCancelled:
        text = "Task stopped."
        role = .system
        isError = false
      default: continue
      }
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
      messages.append(
        ChatMessage(
          id: row.id, role: role, text: text, createdAt: row.createdAt,
          runID: row.runId, isQueued: queuedInputs.contains(row.id), isError: isError))
    }

    let state: ChatExecutionState
    if recovering {
      state = .recovering
    } else if !activeRuns.intersection(interrupted).isEmpty {
      state = .stopping
    } else if !activeRuns.isEmpty {
      state = .running
    } else if !queuedInputs.isEmpty {
      state = .queued
    } else {
      switch rows.last(where: { $0.eventType.isTerminal })?.eventType {
      case .runCompleted: state = .completed
      case .runFailed: state = .failed
      case .runCancelled: state = .cancelled
      default: state = .idle
      }
    }
    return ChatHistory(
      messages: messages, executionState: state,
      activeRunIDs: activeRuns.subtracting(interrupted).sorted(), queuedEventIDs: queuedInputs,
      persistedEventIDs: Set(rows.map(\.id)))
  }

  /// Raw history may contain historical private memory-citation envelopes.
  /// They are transport metadata, not assistant output (including incomplete envelopes).
  private static func visibleOutput(_ source: String) -> String {
    var text = source
    while let opening = text.range(of: "<oai-mem-citation>") {
      let end =
        text.range(of: "</oai-mem-citation>", range: opening.upperBound..<text.endIndex)?.upperBound
        ?? text.endIndex
      text.removeSubrange(opening.lowerBound..<end)
    }
    return text.replacingOccurrences(of: "</oai-mem-citation>", with: "")
  }
}
