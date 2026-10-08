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

  private struct ContentMetrics: Equatable {
    let height: CGFloat
    let offset: CGFloat
    let isNearTop: Bool
    let isAwayFromBottom: Bool
  }

  private var history: ChatHistory { conversation.history ?? .empty }
  var body: some View {
    let displayedMessages = conversation.visibleMessages
    ScrollViewReader { proxy in
      List {
        if conversation.hasEarlierMessages {
          Button {
            Task { await loadEarlierMessages() }
          } label: {
            HStack {
              Spacer()
              if conversation.isLoadingEarlier { ProgressView().controlSize(.small) }
              Text("Load earlier messages")
              Spacer()
            }
          }
          .disabled(conversation.isLoadingEarlier)
          .accessibilityIdentifier("load-earlier-messages")
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
        }
        ForEach(Array(displayedMessages.enumerated()), id: \.element.id) { index, message in
          let continuesAssistantGroup =
            message.role == .assistant && index > 0
            && displayedMessages[index - 1].role == .assistant
          messageRow(message, showsAvatar: !continuesAssistantGroup)
            .background(ConversationRowAnchor(messageID: message.id, anchor: scrollAnchor))
            .listRowInsets(
              EdgeInsets(
                top: index == 0 ? 20 : (continuesAssistantGroup ? 8 : 24),
                leading: 20, bottom: 0, trailing: 20)
            )
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
        VStack(alignment: .leading, spacing: 24) {
          if history.executionState.isActive {
            HStack(spacing: 10) {
              ProgressView().controlSize(.small)
              Text(history.executionState.label).font(.subheadline).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("execution-status")
          } else if history.executionState == .cancelled {
            Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
          }
          if !displayedMessages.isEmpty {
            Link(
              "Open conversation on web",
              destination: conversation.webURL.appending(path: "chats/\(thread.id)")
            )
            .font(.caption).foregroundStyle(.secondary)
          }
          Color.clear.frame(height: 1)
        }
        .listRowInsets(EdgeInsets(top: 24, leading: 20, bottom: 20, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .id("conversation-bottom")
      }
      .listStyle(.plain)
      .listRowSpacing(0)
      .environment(\.defaultMinListRowHeight, 0)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .refreshable { await conversation.refresh() }
      .background(ConversationViewportAnchor(anchor: scrollAnchor))
      .onAppear {
        scrollAnchor.revealRow = { proxy.scrollTo($0, anchor: .top) }
        scrollAnchor.viewportDidChange = {
          if hasPositionedHistory && followsLatestMessage { scrollAnchor.followBottom() }
        }
      }
      .onScrollPhaseChange { _, phase in
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
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY > 20
      } action: { _, awayFromBottom in
        isAwayFromBottom = awayFromBottom
      }
      .overlay(alignment: .bottom) {
        if isAwayFromBottom && hasPositionedHistory && !displayedMessages.isEmpty {
          Button {
            followsLatestMessage = true
            scrollAnchor.cancel()
            conversation.rememberReadingPosition(nil)
            resetsWindowAtBottom = true
            positionAtBottom(proxy, animated: true)
          } label: {
            Image(systemName: "arrow.down")
              .font(.system(size: 18, weight: .medium))
          }
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .controlSize(.large)
          .accessibilityLabel("Scroll to bottom")
          .accessibilityIdentifier("scroll-to-bottom")
          .padding(.bottom, 16)
        }
      }
      .simultaneousGesture(
        DragGesture(minimumDistance: 8).onChanged { value in
          if abs(value.translation.height) > abs(value.translation.width) {
            followsLatestMessage = false
            resetsWindowAtBottom = false
            scrollAnchor.cancel()
          }
        }
      )
      .onScrollGeometryChange(for: ContentMetrics.self) { geometry in
        ContentMetrics(
          height: geometry.contentSize.height,
          offset: geometry.contentOffset.y,
          isNearTop: geometry.visibleRect.minY - geometry.contentInsets.top < 100,
          isAwayFromBottom: geometry.contentSize.height + geometry.contentInsets.bottom
            - geometry.visibleRect.maxY > 20)
      } action: { previous, current in
        isNearTop = current.isNearTop
        scrollAnchor.layoutDidChange()
        if hasPositionedHistory && !followsLatestMessage && !isScrolling {
          saveReadingPosition()
        }
        if resetsWindowAtBottom && !current.isAwayFromBottom && !isScrolling {
          resetsWindowAtBottom = false
          conversation.resetRenderWindowToLatest()
        }
        // Correct an existing bottom request after text/images acquire their final height.
        // Measuring a row while already at the bottom, or while reading history, is a no-op.
        if hasPositionedHistory && followsLatestMessage && current.isAwayFromBottom
          && current.height != previous.height
        {
          positionAtBottom(proxy)
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
        // Incoming updates preserve the reading position; a local send follows its new bubble.
        guard
          !hasPositionedHistory || followsLatestMessage
            || conversation.pending.contains(where: { $0.id == displayedMessages.last?.id })
        else { return }
        followsLatestMessage = true
        scrollAnchor.cancel()
        conversation.rememberReadingPosition(nil)
        await Task.yield()
        guard !Task.isCancelled, followsLatestMessage else { return }
        if hasPositionedHistory {
          positionAtBottom(proxy, animated: true)
        } else {
          positionAtBottom(proxy)
          hasPositionedHistory = true
        }
      }
      .onChange(of: displayedMessages) { _, _ in
        guard hasPositionedHistory, !isScrolling else { return }
        if followsLatestMessage {
          positionAtBottom(proxy)
        } else if let position = conversation.readingPosition {
          scrollAnchor.restore(position)
        }
      }
      .onChange(of: conversation.readingPosition?.messageID) { previousID, id in
        if hasPositionedHistory && !followsLatestMessage && !isScrolling {
          if let position = conversation.readingPosition {
            if scrollAnchor.preservedPosition?.messageID != position.messageID {
              scrollAnchor.restore(position)
            } else {
              scrollAnchor.preserve(position)
            }
          } else if previousID != nil && id == nil {
            followsLatestMessage = true
            positionAtBottom(proxy)
          }
        }
      }
      .onDisappear {
        if !followsLatestMessage { saveReadingPosition() }
        scrollAnchor.cancel()
        scrollAnchor.revealRow = nil
        scrollAnchor.viewportDidChange = nil
      }
      .onChange(of: history.executionState) { _, _ in
        if hasPositionedHistory && followsLatestMessage {
          positionAtBottom(proxy)
        }
      }
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

  private func positionAtBottom(_ proxy: ScrollViewProxy, animated: Bool = false) {
    scrollAnchor.followBottom()
    withAnimation(animated && !reduceMotion ? .easeOut(duration: 0.25) : nil) {
      proxy.scrollTo("conversation-bottom", anchor: .bottom)
    }
  }

  private func saveReadingPosition() {
    if let position = scrollAnchor.preservedPosition ?? scrollAnchor.capture() {
      conversation.rememberReadingPosition(position)
      // Replay can revoke a row before List finishes reporting its old geometry.
      guard let accepted = conversation.readingPosition else { return }
      if accepted.messageID != position.messageID {
        scrollAnchor.restore(accepted)
      } else {
        scrollAnchor.preserve(accepted)
      }
    }
  }

  private func loadEarlierMessages() async {
    guard hasPositionedHistory, !isScrolling, conversation.hasEarlierMessages else { return }
    followsLatestMessage = false
    saveReadingPosition()
    await conversation.loadEarlierMessages()
    if !isScrolling, let position = conversation.readingPosition { scrollAnchor.preserve(position) }
  }

  private func messageRow(_ message: ChatMessage, showsAvatar: Bool) -> some View {
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
      if let pending = conversation.pending.first(where: { $0.id == message.id }) {
        HStack {
          Text(pending.needsRetry ? "Delivery not confirmed" : "Sending…")
            .font(.caption).foregroundStyle(.secondary)
          if pending.needsRetry {
            Button("Check and retry") { Task { await conversation.retry(pending) } }
              .font(.caption)
              .disabled(conversation.isSending)
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
