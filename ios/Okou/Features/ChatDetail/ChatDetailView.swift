import ChatDomain
import SwiftUI
import Textual

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  let supportsAttachments: Bool
  let supportsActivitySummary: Bool
  let topContentInset: CGFloat
  private var thread: ChatThread { conversation.thread }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0
  @State private var activityOwner = UUID()

  init(
    conversation: ConversationStore, supportsAttachments: Bool = false,
    supportsActivitySummary: Bool = false, topContentInset: CGFloat = 0
  ) {
    self.conversation = conversation
    self.supportsAttachments = supportsAttachments
    self.supportsActivitySummary = supportsActivitySummary
    self.topContentInset = topContentInset
    _scrolling = State(initialValue: ConversationScrollCoordinator(conversation: conversation))
  }

  private var history: ChatHistory { conversation.history ?? .empty }
  private var rows: [ConversationCollectionRow] {
    let items = conversation.visibleItems
    var result: [ConversationCollectionRow] = []
    if conversation.hasEarlierMessages {
      result.append(.earlier(isLoading: conversation.isLoadingEarlier))
    }
    for (index, item) in items.enumerated() {
      let continuesGroup =
        index > 0 && items[index - 1].role == item.role && !item.beginsWorkSection
      let spacing: CGFloat = index == 0 ? 20 : (continuesGroup ? 8 : 24)
      switch item {
      case .work(let section, let expanded):
        result.append(
          .work(section, expanded: expanded, showsAvatar: true, topSpacing: spacing))
      case .message(let message, let isWorkHistory):
        let pendingRetry = conversation.pending.first { $0.id == message.id }?.needsRetry
        result.append(
          .message(
            message, showsAvatar: !continuesGroup, topSpacing: spacing,
            pendingRetry: pendingRetry,
            isSending: pendingRetry == true && conversation.isSending, isWorkHistory: isWorkHistory)
        )
      }
    }
    result.append(.footer(history.executionState, hasMessages: !items.isEmpty))
    return result
  }

  var body: some View {
    let displayedMessages = conversation.visibleMessages
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, measurements: conversation.measurements,
      contentInsets: EdgeInsets(
        top: topContentInset, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor,
      scroll: scrolling.scroll,
      followsBottom: scrolling.followsBottom,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      refresh: { await conversation.refresh() }, content: rowContent
    )
    .ignoresSafeArea(.container, edges: .vertical)
    .onAppear {
      scrolling.activate(reduceMotion: reduceMotion)
      conversation.setActivitySummaryEnabled(supportsActivitySummary)
      conversation.setDetailVisible(true, owner: activityOwner)
    }
    .onChange(of: supportsActivitySummary) { _, enabled in
      conversation.setActivitySummaryEnabled(enabled)
    }
    .onChange(of: reduceMotion) { _, value in scrolling.setReduceMotion(value) }
    .overlay(alignment: .bottom) {
      if scrolling.showsBottomButton {
        Button {
          scrolling.jumpToLatest()
        } label: {
          Image(systemName: "arrow.down").font(.system(size: 18, weight: .medium))
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .controlSize(.large)
        .accessibilityLabel("Scroll to bottom")
        .accessibilityIdentifier("scroll-to-bottom")
        .padding(.bottom, 16)
      }
    }
    .task(id: displayedMessages.last) { await scrolling.latestMessageChanged() }
    .onChange(of: conversation.visibleItems) { _, _ in scrolling.messagesChanged() }
    .onChange(of: conversation.readingPosition?.messageID) { previousID, id in
      scrolling.readingPositionChanged(previousID: previousID, currentID: id)
    }
    .onDisappear {
      scrolling.deactivate()
      conversation.setDetailVisible(false, owner: activityOwner)
    }
    .onChange(of: history.executionState) { _, _ in scrolling.executionStateChanged() }
    .safeAreaBar(edge: .bottom, spacing: 0) {
      ChatComposerView(
        draft: $conversation.draft, isBusy: conversation.isSending || conversation.isStopping,
        showsProgress: false, canStop: history.canStop, needsUpgrade: conversation.needsUpgrade,
        error: conversation.error,
        attachmentURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
        attachments: conversation.attachmentDraft, supportsAttachments: supportsAttachments,
        submit: {
          if history.canStop
            && conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !conversation.attachmentDraft.hasAttachments
          {
            await conversation.stop()
          } else {
            await conversation.send()
          }
        }, refresh: { await conversation.refresh() }
      )
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
    }
    .task(id: thread.id) { await conversation.refresh() }
    .overlay {
      if conversation.isLoading && conversation.history == nil {
        ConversationLoadingView()
      }
    }
  }

  @ViewBuilder
  private func rowContent(_ row: ConversationCollectionRow, anchor: ConversationScrollAnchor?)
    -> some View
  {
    switch row {
    case .earlier(let isLoading):
      Button {
        scrolling.loadEarlierMessages()
      } label: {
        HStack {
          Spacer()
          if isLoading { ProgressView().controlSize(.small) }
          Text("Load earlier messages")
          Spacer()
        }
      }
      .disabled(isLoading)
      .accessibilityIdentifier("load-earlier-messages")
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
    case .work(let section, let expanded, let showsAvatar, let topSpacing):
      VStack(alignment: .leading, spacing: 8) {
        if showsAvatar { assistantAvatar }
        ConversationWorkHeader(section: section, expanded: expanded) {
          scrolling.toggleWorkHistory(section.id)
        }
        .padding(.leading, 6)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: section.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .message(
      let message, let showsAvatar, let topSpacing, let pendingRetry, let isSending,
      let isWorkHistory):
      messageRow(
        message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
        isWorkHistory: isWorkHistory
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .footer(let executionState, let hasMessages):
      VStack(alignment: .leading, spacing: 24) {
        if executionState.isActive {
          ConversationActivityLabel(
            summary: conversation.activitySummary, state: executionState)
        }
        if hasMessages {
          Link(
            "Open conversation on web",
            destination: conversation.webURL.appending(path: "chats/\(thread.id)")
          )
          .font(.caption).foregroundStyle(.secondary)
        }
        Color.clear.frame(height: 1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(EdgeInsets(top: 24, leading: 20, bottom: 20, trailing: 20))
    }
  }

  private func messageRow(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool
  ) -> some View {
    Group {
      if message.role == .user {
        UserMessageBubbleLayout {
          messageContent(
            message, showsAvatar: false, pendingRetry: pendingRetry, isSending: isSending
          )
          .padding(14)
          .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        }
      } else {
        messageContent(
          message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
          isWorkHistory: isWorkHistory
        )
        .textual.fontScale(isWorkHistory ? 0.9 : 1)
        .foregroundStyle(isWorkHistory ? Color.secondary : Color.primary)
        .padding(.leading, isWorkHistory ? 28 : 0)
        .overlay(alignment: .leading) {
          if isWorkHistory {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 1).padding(.leading, 14)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    .contextMenu {
      Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
    }
  }

  private var assistantAvatar: some View {
    Image("AssistantAvatar")
      .resizable().scaledToFit()
      .frame(width: 28, height: 28)
      .accessibilityLabel("Okou")
      .accessibilityIdentifier("assistant-avatar")
  }

  private func messageContent(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool = false
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if message.role == .assistant && showsAvatar { assistantAvatar }
      if message.role == .system {
        Label(message.text, systemImage: message.isError ? "exclamationmark.circle" : "stop.circle")
          .font(.subheadline)
          .foregroundStyle(message.isError ? Color.red : Color.secondary)
          .textSelection(.enabled)
          .padding(.leading, 6)
      } else {
        MessageBodyView(
          text: message.text, baseURL: conversation.webURL, markdown: conversation.messageMarkdown
        )
        .equatable()
        .foregroundStyle(
          message.isError ? Color.red : (isWorkHistory ? Color.secondary : Color.primary)
        )
        .padding(.leading, message.role == .assistant ? 6 : 0)
      }
      if let pendingRetry {
        HStack {
          Text(pendingRetry ? "Delivery not confirmed" : "Sending…")
            .font(.caption).foregroundStyle(.secondary)
          if pendingRetry {
            Button("Check and retry") {
              guard let pending = conversation.pending.first(where: { $0.id == message.id }) else {
                return
              }
              Task { await conversation.retry(pending) }
            }
            .font(.caption)
            .disabled(isSending)
          }
        }
      }
    }
  }

}
