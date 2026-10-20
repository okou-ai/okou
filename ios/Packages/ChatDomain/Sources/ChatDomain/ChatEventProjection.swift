import Foundation

public enum ChatEventProjection {
  public static func history(rows: [ChatEvent], recovering: Bool) throws -> ChatHistory {
    let revoked = Set(rows.compactMap(\.revokesEventId))
    let terminated = Set(rows.filter { $0.eventType.isTerminal }.compactMap(\.runId))
    let interrupted = Set(rows.filter { $0.eventType == .controlInterrupt }.compactMap(\.runId))
    let activeRuns = Set(
      rows.filter {
        $0.eventType != .controlInterrupt && $0.eventType != .usageRecorded
          && !revoked.contains($0.id)
      }.compactMap(\.runId)
    ).subtracting(terminated)
    // Match PWA liveRunIdsFromChatEvents: first occurrence in authoritative event
    // order, not UUID sorting or the most recent event from an older run.
    var seenRuns = Set<String>()
    let orderedRuns = rows.compactMap { row -> String? in
      guard let runID = row.runId, activeRuns.contains(runID),
        !revoked.contains(row.id), row.eventType != .usageRecorded,
        seenRuns.insert(runID).inserted
      else { return nil }
      return runID
    }
    let queuedInputs = rows.filter {
      ($0.eventType == .inputPrompt || $0.eventType == .inputAutomation)
        && $0.runId == nil && !revoked.contains($0.id)
    }.sorted { left, right in
      let leftIsPrompt = left.eventType == .inputPrompt
      let rightIsPrompt = right.eventType == .inputPrompt
      if leftIsPrompt != rightIsPrompt { return leftIsPrompt }
      if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
      return left.id < right.id
    }.map(\.id)

    var messages: [ChatMessage] = []
    var previousRun: String?
    var previousModel: ChatUserMessage.Model?
    var hasPreviousRun = false
    for row in rows where !revoked.contains(row.id) {
      let text: String
      var attachments: [ChatMessageAttachment] = []
      let role: ChatMessage.Role
      let isError: Bool
      var userMessage: ChatUserMessage?
      var modelChange: ChatModelChange?
      switch row.eventType {
      case .inputPrompt, .inputRejected, .inputAutomation:
        if row.eventType == .inputAutomation && row.payload?.userMessage == nil { continue }
        guard let document = row.payload?.userMessage, document.version == 1 else {
          throw ChatError.invalidContract("Unsupported user message document.")
        }
        try document.validate()
        userMessage = document
        attachments = try document.attachments()
        let body = document.displayText
        text = row.payload?.error.map { body + "\n\n" + $0 } ?? body
        if let run = row.runId.map({ "run:\($0)" })
          ?? document.model.map({ _ in "event:\(row.id)" }),
          run != previousRun
        {
          if hasPreviousRun, let previousModel, let model = document.model {
            if !previousModel.selectsSameModel(as: model) {
              modelChange = .model(model)
            } else if previousModel.isFast != model.isFast {
              modelChange = .fastMode(model.isFast)
            }
          }
          previousRun = run
          previousModel = document.model
          hasPreviousRun = true
        }
        role = .user
        isError = row.eventType == .inputRejected
      case .outputMessage:
        guard let content = row.payload?.content else {
          throw ChatError.invalidContract("Assistant output is missing its content.")
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
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
        && userMessage?.annotation == nil
      {
        continue
      }
      messages.append(
        ChatMessage(
          id: row.id, role: role, text: text, attachments: attachments, createdAt: row.createdAt,
          runID: row.runId, isQueued: queuedInputs.contains(row.id), isError: isError,
          userMessage: userMessage, inputError: role == .user ? row.payload?.error : nil,
          modelChange: modelChange))
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
    let work = ChatWorkProjection.build(rows: rows, messages: messages)
    return ChatHistory(
      messages: work.messages, executionState: state,
      activeRunIDs: activeRuns.subtracting(interrupted).sorted(),
      activityRunID: state == .running ? orderedRuns.last : nil, queuedEventIDs: queuedInputs,
      persistedEventIDs: Set(rows.map(\.id)), workSections: work.sections,
      latestRunFinishAt: rows.filter { $0.eventType.isTerminal }.map(\.createdAt).max(),
      recommendedFollowups: ChatFollowupProjection.source(
        rows: rows, active: state.isActive))
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
