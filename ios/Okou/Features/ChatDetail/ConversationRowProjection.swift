import ChatData
import ChatDomain
import SwiftUI

@MainActor
struct ConversationRowProjection {
  let conversation: ConversationStore
  /// The conversation's graph value for this render; ChatDetailView resolves it.
  let transcript: ConversationProjection.Value
  /// The render window for this render, which ChatDetailView also resolves.
  let window: ConversationPresentation.Window
  /// Whether a send is in flight, from the delivery state ChatDetailView resolves.
  let isSending: Bool
  /// The model selection's graph value for this render, which ChatDetailView also resolves.
  let models: ChatModelSelectionStore.Presentation?
  var timeline = ConversationTimeline()
  private var history: ChatHistory { transcript.history ?? .empty }

  var rows: [ConversationCollectionRow] {
    timeline.rows(contents, items: window.items, latestRunID: history.latestRunID)
  }

  private var contents: [ConversationCollectionRow.Content] {
    let items = window.items
    if conversation.sharing.isSelecting {
      let sharing = conversation.sharing
      let visibleIDs = Set(items.compactMap(\.message).map(\.id))
      var rows: [ConversationCollectionRow.Content] = window.hasEarlierMessages ? [.earlier] : []
      rows += sharing.groups.filter { !$0.eventIDs.allSatisfy { !visibleIDs.contains($0) } }
        .enumerated().map { index, group in
          // The preceding row already reserves the selection background's bottom inset.
          .share(group, topSpacing: index == 0 ? OkouSpace.xl : OkouSpace.xxl - OkouSpace.sm)
        }
      return rows
    }
    var result: [ConversationCollectionRow.Content] = []
    if window.hasEarlierMessages {
      result.append(.earlier)
    }
    var answerForUsage: ChatMessage?
    for (index, item) in items.enumerated() {
      let continuesGroup = index > 0 && continues(item, after: items[index - 1])
      let spacing: CGFloat = index == 0 ? 20 : (continuesGroup ? 8 : 24)
      switch item {
      case .work(let section, let expanded):
        result.append(
          .work(
            section, expanded: expanded, showsAvatar: true, topSpacing: spacing,
            failed: turnFails(after: index, in: items)))
      case .message(let message, let isWorkHistory):
        if let failure = message.failure {
          // A provider's own error line from the same short run belongs inside the failure
          // card, so the reader sees one explanation instead of two that may disagree.
          var showsAvatar = !continuesGroup
          var topSpacing = spacing
          var providerMessage: String?
          if case .message(let previous, let previousAvatar, let previousSpacing, _, _, _, _) =
            result.last,
            isProviderMessage(previous, failure: message, in: items)
          {
            result.removeLast()
            showsAvatar = previousAvatar
            providerMessage = previous.text
            topSpacing = previousSpacing
          }
          result.append(
            .failure(
              message, conversation.failureState(failure, models: models),
              showsAvatar: showsAvatar, topSpacing: topSpacing, providerMessage: providerMessage))
          continue
        }
        let pendingRetry = transcript.pending.first { $0.id == message.id }?.needsRetry
        let showsActions = !isWorkHistory && pendingRetry == nil && endsTurn(at: index, in: items)
        if showsActions, let runID = message.runID,
          items.dropFirst(index + 1).first == .usage(runID: runID)
        {
          answerForUsage = message
        }
        result.append(
          .message(
            message, showsAvatar: !continuesGroup, topSpacing: spacing,
            pendingRetry: pendingRetry,
            isSending: pendingRetry == true && isSending, isWorkHistory: isWorkHistory,
            showsActions: showsActions && answerForUsage == nil)
        )
      case .usage(let runID):
        result.append(.usage(runID: runID, actionsFor: answerForUsage))
        answerForUsage = nil
      }
    }
    // Text still streaming from the running run, until its durable event takes the same id.
    var previousItem = items.last
    for output in transcript.streamed {
      let message = ChatMessage(
        id: output.eventID, role: .assistant, text: output.text, createdAt: output.createdAt,
        runID: output.runID, isQueued: false, isError: false)
      let item = ConversationItem.message(message)
      let continuesGroup = previousItem.map { continues(item, after: $0) } == true
      result.append(
        .message(
          message, showsAvatar: !continuesGroup, topSpacing: continuesGroup ? 8 : 24,
          pendingRetry: nil,
          isSending: false))
      previousItem = item
    }
    result.append(contentsOf: trailingRows(after: items))
    return result
  }

  private func trailingRows(after items: [ConversationItem])
    -> [ConversationCollectionRow.Content]
  {
    var rows: [ConversationCollectionRow.Content] = []
    let lastRunMessage = items.last { item in
      guard let message = item.message else { return false }
      return history.latestRunID == nil || message.runID == nil
        || message.runID == history.latestRunID
    }
    let statusNeedsAvatar = transcript.streamed.isEmpty && lastRunMessage?.role != .assistant
    if let completion = transcript.completion {
      let source =
        models?.snapshot.usesFollowupPlaceholder == true ? nil : completion.recommendedFollowups
      rows.append(
        .finished(
          label: timeline.finishedLabel(
            completion, followups: source, finishedAt: history.latestRunFinishAt),
          followups: source, showsAvatar: statusNeedsAvatar))
    }
    let hasOptimisticInput = transcript.pending.contains {
      !$0.needsRetry && !history.persistedEventIDs.contains($0.id)
    }
    let footerState = Self.footerState(
      executionState: history.executionState, hasOptimisticInput: hasOptimisticInput)
    let showsActivity = ConversationFooterView.showsActivity(for: footerState)
    rows.append(.footer(footerState, showsAvatar: showsActivity && statusNeedsAvatar))
    return rows
  }

  /// A pending prompt without a delivery failure starts an optimistic running footer.
  private static func footerState(
    executionState: ChatExecutionState, hasOptimisticInput: Bool
  ) -> ChatExecutionState {
    if ConversationFooterView.showsActivity(for: executionState) {
      return executionState
    }
    return hasOptimisticInput ? .running : executionState
  }

  private func continues(_ item: ConversationItem, after previous: ConversationItem) -> Bool {
    guard previous.role == item.role, !item.beginsWorkSection,
      item.message?.modelChange == nil,
      item.message?.userMessage?.annotation?.type != "automation",
      previous.message?.userMessage?.annotation?.type != "automation"
    else { return false }
    guard let message = item.message else { return true }
    switch previous {
    case .message(let before, _) where message.role == .user:
      return timeline.calendar.isDate(message.createdAt, inSameDayAs: before.createdAt)
    case .message(let before, _):
      return before.runID == message.runID || before.runID == nil || message.runID == nil
    case .usage(let runID):
      return runID == message.runID || message.runID == nil
    case .work:
      return true
    }
  }

  /// The last assistant answer of a turn gets the copy / share / open actions.
  private func endsTurn(at index: Int, in items: [ConversationItem]) -> Bool {
    guard let message = items[index].message, message.role == .assistant, !message.isError,
      !message.text.isEmpty
    else { return false }
    var next = index + 1
    while next < items.count {
      switch items[next] {
      case .usage:
        next += 1
      case .work:
        return true
      case .message(let following, let isWorkHistory):
        if isWorkHistory {
          next += 1
          continue
        }
        if following.failure != nil { return false }
        return following.role != .assistant
      }
    }
    return !history.executionState.isActive
  }

  /// A work section whose run ended in a failure (not a user pause) shows a failed header.
  private func turnFails(after index: Int, in items: [ConversationItem]) -> Bool {
    var next = index + 1
    while next < items.count {
      switch items[next] {
      case .work:
        return false
      case .usage:
        next += 1
      case .message(let message, _):
        if message.role == .user { return false }
        if let failure = message.failure {
          let outputError = failure.outputError ?? ""
          return outputError.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            != "run cancelled"
        }
        next += 1
      }
    }
    return false
  }

  /// The only output of a run that then failed, short and on one line, is the provider's error.
  private func isProviderMessage(
    _ message: ChatMessage, failure: ChatMessage, in items: [ConversationItem]
  ) -> Bool {
    guard message.role == .assistant, message.failure == nil, message.attachments.isEmpty,
      let runID = message.runID, runID == failure.runID,
      message.text.count <= 400, !message.text.contains("\n")
    else { return false }
    // Billing cards supply their own explanation. Keep an actual partial answer in the transcript.
    if failure.failure?.billingReason != nil,
      ChatFailure.BillingReason(diagnostic: message.text) == nil
    {
      return false
    }
    for item in items {
      if case .work(let section, _) = item, section.anchorMessageID == message.id {
        return section.stepCount == 0
      }
    }
    return true
  }
}
