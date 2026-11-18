import ChatData
import ChatDomain
import SwiftUI

@MainActor
struct ConversationRowProjection {
  let conversation: ConversationStore
  private var history: ChatHistory { conversation.history ?? .empty }

  var rows: [ConversationCollectionRow] {
    let items = conversation.visibleItems
    if conversation.sharing.isSelecting {
      let sharing = conversation.sharing
      let visibleIDs = Set(items.compactMap(\.message).map(\.id))
      var rows: [ConversationCollectionRow] = conversation.hasEarlierMessages ? [.earlier] : []
      rows += sharing.groups.filter { !$0.eventIDs.allSatisfy { !visibleIDs.contains($0) } }
        .enumerated().map { index, group in
          // The preceding row already reserves the selection background's bottom inset.
          .share(group, topSpacing: index == 0 ? OkouSpace.xl : OkouSpace.xxl - OkouSpace.sm)
        }
      return rows
    }
    var result: [ConversationCollectionRow] = []
    if conversation.hasEarlierMessages {
      result.append(.earlier)
    }
    for (index, item) in items.enumerated() {
      let continuesGroup =
        index > 0 && items[index - 1].role == item.role && !item.beginsWorkSection
        && item.message?.modelChange == nil
        && item.message?.userMessage?.annotation?.type != "automation"
        && items[index - 1].message?.userMessage?.annotation?.type != "automation"
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
          var topSpacing = spacing
          var providerMessage: String?
          if case .message(let previous, _, let previousSpacing, _, _, _, _) = result.last,
            isProviderMessage(previous, failure: message, in: items)
          {
            result.removeLast()
            providerMessage = previous.text
            topSpacing = previousSpacing
          }
          result.append(
            .failure(
              message, conversation.failureState(failure), topSpacing: topSpacing,
              providerMessage: providerMessage))
          continue
        }
        let pendingRetry = conversation.pending.first { $0.id == message.id }?.needsRetry
        result.append(
          .message(
            message, showsAvatar: !continuesGroup, topSpacing: spacing,
            pendingRetry: pendingRetry,
            isSending: pendingRetry == true && conversation.isSending, isWorkHistory: isWorkHistory,
            showsActions: !conversation.sharing.isSelecting && !isWorkHistory
              && pendingRetry == nil && endsTurn(at: index, in: items))
        )
      case .usage(let runID):
        result.append(.usage(runID: runID))
      }
    }
    // Text still streaming from the running run, until its durable event takes the same id.
    for output in conversation.streamedOutputs {
      var continues = false
      if case .message(let previous, _, _, _, _, _, _) = result.last {
        continues = previous.role != .user
      } else if case .work = result.last {
        continues = true
      }
      result.append(
        .message(
          ChatMessage(
            id: output.eventID, role: .assistant, text: output.text, createdAt: output.createdAt,
            runID: output.runID, isQueued: false, isError: false),
          showsAvatar: !continues, topSpacing: continues ? 8 : 24, pendingRetry: nil,
          isSending: false))
    }
    if let source = history.recommendedFollowups, conversation.pending.isEmpty {
      result.append(.followups(source, finishedAt: history.latestRunFinishAt))
    }
    let showsActivityAvatar =
      history.executionState.isActive
      && items.last(where: { $0.message?.isQueued != true })?.role != .assistant
    result.append(.footer(history.executionState, showsAvatar: showsActivityAvatar))
    return result
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
    for item in items {
      if case .work(let section, _) = item, section.anchorMessageID == message.id {
        return section.stepCount == 0
      }
    }
    return true
  }
}
