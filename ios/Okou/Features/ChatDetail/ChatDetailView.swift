import ChatDomain
import SwiftUI

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  private var thread: ChatThread { conversation.thread }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var scrolling: ConversationScrollCoordinator

  init(conversation: ConversationStore) {
    self.conversation = conversation
    _scrolling = State(initialValue: ConversationScrollCoordinator(conversation: conversation))
  }

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
      rows: rows, markdown: conversation.messageMarkdown, anchor: scrolling.anchor,
      scroll: scrolling.scroll,
      followsBottom: scrolling.followsBottom,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      refresh: { await conversation.refresh() }, content: rowContent
    )
    .onAppear { scrolling.activate(reduceMotion: reduceMotion) }
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
    .onChange(of: displayedMessages) { _, _ in scrolling.messagesChanged() }
    .onChange(of: conversation.readingPosition?.messageID) { previousID, id in
      scrolling.readingPositionChanged(previousID: previousID, currentID: id)
    }
    .onDisappear { scrolling.deactivate() }
    .onChange(of: history.executionState) { _, _ in scrolling.executionStateChanged() }
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
