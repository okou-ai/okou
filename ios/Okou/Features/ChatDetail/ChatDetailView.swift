import SwiftUI

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  private var thread: ChatThread { conversation.thread }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var hasPositionedHistory = false
  @State private var followsLatestMessage = true
  @State private var isAwayFromBottom = false
  @State private var isScrolling = false
  @State private var isNearTop = false
  @State private var resetsWindowAtBottom = false
  @State private var scrollAnchor = ConversationScrollAnchor()
  @State private var scroll = ConversationCollectionScroll()
  @State private var previousHeight: CGFloat = 0

  private var history: ChatHistory { conversation.history ?? .empty }
  private var rows: [ConversationCollectionRow] {
    let messages = conversation.visibleMessages
    var result: [ConversationCollectionRow] = []
    if conversation.hasEarlierMessages {
      result.append(.earlier(isLoading: conversation.isLoadingEarlier))
    }
    for (index, message) in messages.enumerated() {
      let continuesGroup =
        message.role == .assistant && index > 0 && messages[index - 1].role == .assistant
      let pendingRetry = conversation.pending.first { $0.id == message.id }?.needsRetry
      result.append(
        .message(
          message, showsAvatar: !continuesGroup,
          topSpacing: index == 0 ? 20 : (continuesGroup ? 8 : 24),
          pendingRetry: pendingRetry,
          isSending: pendingRetry == true && conversation.isSending))
    }
    result.append(.footer(history.executionState, hasMessages: !messages.isEmpty))
    return result
  }

  var body: some View {
    let displayedMessages = conversation.visibleMessages
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, anchor: scrollAnchor, scroll: scroll,
      followsBottom: followsLatestMessage,
      phaseChanged: handleScrollPhase, metricsChanged: handleMetrics,
      refresh: { await conversation.refresh() }, content: rowContent
    )
    .onAppear {
      scrollAnchor.revealRow = { scroll.scrollTo($0, anchor: .top) }
      scrollAnchor.readingPositionDidChange = { position in
        guard hasPositionedHistory && !followsLatestMessage && !isScrolling else { return }
        conversation.rememberReadingPosition(scrollAnchor.preservedPosition ?? position)
      }
      scrollAnchor.viewportDidChange = {
        guard hasPositionedHistory else { return }
        if followsLatestMessage {
          scrollAnchor.followBottom()
        } else if let position = conversation.readingPosition {
          scrollAnchor.preserve(position)
        }
      }
    }
    .overlay(alignment: .bottom) {
      if isAwayFromBottom && hasPositionedHistory && !displayedMessages.isEmpty {
        Button {
          followsLatestMessage = true
          scrollAnchor.cancel()
          conversation.rememberReadingPosition(nil)
          resetsWindowAtBottom = true
          positionAtBottom(animated: true)
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
    .task(id: displayedMessages.last) {
      guard !displayedMessages.isEmpty else { return }
      if !hasPositionedHistory, let position = conversation.readingPosition {
        followsLatestMessage = false
        await Task.yield()
        guard !Task.isCancelled, !isScrolling else { return }
        scrollAnchor.restore(position)
        hasPositionedHistory = true
        return
      }
      guard
        !hasPositionedHistory || followsLatestMessage
          || conversation.pending.contains(where: { $0.id == displayedMessages.last?.id })
      else { return }
      followsLatestMessage = true
      scrollAnchor.cancel()
      conversation.rememberReadingPosition(nil)
      await Task.yield()
      guard !Task.isCancelled, followsLatestMessage else { return }
      positionAtBottom(animated: hasPositionedHistory)
      hasPositionedHistory = true
    }
    .onChange(of: displayedMessages) { _, _ in
      guard hasPositionedHistory, !isScrolling else { return }
      if followsLatestMessage {
        positionAtBottom()
      } else if let position = conversation.readingPosition {
        scrollAnchor.restore(position)
      }
    }
    .onChange(of: conversation.readingPosition?.messageID) { previousID, id in
      if hasPositionedHistory && !followsLatestMessage && !isScrolling,
        previousID != nil && id == nil
      {
        followsLatestMessage = true
        positionAtBottom()
      }
    }
    .onDisappear {
      if !followsLatestMessage { saveReadingPosition() }
      scrollAnchor.readingPositionDidChange = nil
      scrollAnchor.cancel()
      scrollAnchor.revealRow = nil
      scrollAnchor.viewportDidChange = nil
    }
    .onChange(of: history.executionState) { _, _ in
      if hasPositionedHistory && followsLatestMessage { positionAtBottom() }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      ChatComposerView(
        draft: $conversation.draft, isBusy: conversation.isSending || conversation.isStopping,
        showsProgress: false, canStop: history.canStop, needsUpgrade: conversation.needsUpgrade,
        error: conversation.error,
        attachmentURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
        submit: {
          if history.canStop
            && conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          {
            await conversation.stop()
          } else {
            await conversation.send()
          }
        }, refresh: { await conversation.refresh() })
    }
    .task(id: thread.id) { await conversation.refresh() }
    .overlay {
      if conversation.isLoading && conversation.history == nil {
        ProgressView("Loading conversation…").padding(20).background(
          .regularMaterial, in: Capsule())
      }
    }
  }

  private func positionAtBottom(animated: Bool = false) {
    scrollAnchor.followBottom()
    scroll.scrollTo("conversation-bottom", anchor: .bottom, animated: animated && !reduceMotion)
  }

  private func handleScrollPhase(_ phase: ScrollPhase) {
    isScrolling = phase != .idle
    scrollAnchor.isScrolling = isScrolling
    if phase == .tracking || phase == .interacting {
      followsLatestMessage = false
      resetsWindowAtBottom = false
      scrollAnchor.cancel()
      conversation.rememberReadingPosition(scrollAnchor.capture())
    }
    if phase == .idle && hasPositionedHistory && !isAwayFromBottom {
      followsLatestMessage = true
      conversation.rememberReadingPosition(nil)
      if resetsWindowAtBottom {
        resetsWindowAtBottom = false
        conversation.resetRenderWindowToLatest()
      }
    } else if phase == .idle && hasPositionedHistory && !followsLatestMessage {
      saveReadingPosition()
      if isNearTop { Task { await loadEarlierMessages() } }
    }
  }

  private func handleMetrics(_ metrics: ConversationCollectionMetrics) {
    let oldHeight = previousHeight
    previousHeight = metrics.height
    isNearTop = metrics.isNearTop
    isAwayFromBottom = metrics.isAwayFromBottom
    scrollAnchor.layoutDidChange()
    if hasPositionedHistory && !followsLatestMessage && !isScrolling { saveReadingPosition() }
    if resetsWindowAtBottom && !metrics.isAwayFromBottom && !isScrolling {
      resetsWindowAtBottom = false
      conversation.resetRenderWindowToLatest()
    }
    if hasPositionedHistory && followsLatestMessage && metrics.isAwayFromBottom
      && metrics.height != oldHeight
    {
      positionAtBottom()
    }
  }

  @ViewBuilder
  private func rowContent(_ row: ConversationCollectionRow, anchor: ConversationScrollAnchor?)
    -> some View
  {
    switch row {
    case .earlier(let isLoading):
      Button {
        Task { await loadEarlierMessages() }
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
    case .message(let message, let showsAvatar, let topSpacing, let pendingRetry, let isSending):
      messageRow(
        message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .footer(let executionState, let hasMessages):
      VStack(alignment: .leading, spacing: 24) {
        if executionState.isActive {
          HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(executionState.label).font(.subheadline).foregroundStyle(.secondary)
          }.accessibilityIdentifier("execution-status")
        } else if executionState == .cancelled {
          Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
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

  private func saveReadingPosition() {
    // Recording user scrolling does not start a reading-position correction.
    if let position = scrollAnchor.preservedPosition ?? scrollAnchor.capture() {
      conversation.rememberReadingPosition(position)
    }
  }

  private func loadEarlierMessages() async {
    guard hasPositionedHistory, !isScrolling, conversation.hasEarlierMessages else { return }
    followsLatestMessage = false
    saveReadingPosition()
    await conversation.loadEarlierMessages()
    if !isScrolling, let position = conversation.readingPosition { scrollAnchor.preserve(position) }
  }

  private func messageRow(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if message.role == .assistant {
        if showsAvatar {
          Image("AssistantAvatar")
            .resizable().scaledToFit()
            .frame(width: 28, height: 28)
            .accessibilityLabel("Okou")
            .accessibilityIdentifier("assistant-avatar")
        }
      } else if message.role == .system {
        Text("Notice")
          .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      }
      MessageBodyView(
        text: message.text, baseURL: conversation.webURL, markdown: conversation.messageMarkdown
      )
      .equatable()
      .foregroundStyle(message.isError ? Color.red : Color.primary)
      .padding(.leading, message.role == .assistant ? 6 : 0)
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
    .padding(message.role == .user ? 14 : 0)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      message.role == .user ? Color(.secondarySystemBackground) : .clear,
      in: RoundedRectangle(cornerRadius: 16)
    )
    .contextMenu {
      Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
    }
  }

}
