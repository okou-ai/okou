import SwiftUI

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  private var thread: ChatThread { conversation.thread }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var hasPositionedHistory = false
  @State private var followsLatestMessage = true
  @State private var isAwayFromBottom = false

  private struct ContentMetrics: Equatable {
    let height: CGFloat
    let isAwayFromBottom: Bool
  }

  private var history: ChatHistory { conversation.history ?? .empty }
  private var messages: [ChatMessage] { conversation.messages }
  var body: some View {
    let displayedMessages = messages
    ScrollViewReader { proxy in
      List {
        ForEach(Array(displayedMessages.enumerated()), id: \.element.id) { index, message in
          let continuesAssistantGroup =
            message.role == .assistant && index > 0
            && displayedMessages[index - 1].role == .assistant
          messageRow(message, showsAvatar: !continuesAssistantGroup)
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
      .onScrollPhaseChange { _, phase in
        if phase == .tracking || phase == .interacting { followsLatestMessage = false }
        if phase == .idle && hasPositionedHistory && !isAwayFromBottom {
          followsLatestMessage = true
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
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
              proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
          } label: {
            Image(systemName: "arrow.down")
              .font(.system(size: 18, weight: .medium))
              .frame(width: 44, height: 44)
              .glassEffect(.regular.interactive(), in: Circle())
              .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Scroll to bottom")
          .accessibilityIdentifier("scroll-to-bottom")
          .padding(.bottom, 16)
        }
      }
      .simultaneousGesture(
        DragGesture(minimumDistance: 8).onChanged { value in
          if abs(value.translation.height) > abs(value.translation.width) {
            followsLatestMessage = false
          }
        }
      )
      .onScrollGeometryChange(for: ContentMetrics.self) { geometry in
        ContentMetrics(
          height: geometry.contentSize.height,
          isAwayFromBottom: geometry.contentSize.height + geometry.contentInsets.bottom
            - geometry.visibleRect.maxY > 20)
      } action: { previous, current in
        // Correct an existing bottom request after text/images acquire their final height.
        // Measuring a row while already at the bottom, or while reading history, is a no-op.
        if hasPositionedHistory && followsLatestMessage && current.isAwayFromBottom
          && current.height > previous.height
        {
          proxy.scrollTo("conversation-bottom", anchor: .bottom)
        }
      }
      .task(id: displayedMessages.last) {
        guard !displayedMessages.isEmpty else { return }
        // Incoming updates preserve the reading position; a local send follows its new bubble.
        guard
          !hasPositionedHistory || followsLatestMessage
            || conversation.pending.contains(where: { $0.id == displayedMessages.last?.id })
        else { return }
        followsLatestMessage = true
        await Task.yield()
        guard !Task.isCancelled else { return }
        if hasPositionedHistory {
          withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) {
            proxy.scrollTo("conversation-bottom", anchor: .bottom)
          }
        } else {
          proxy.scrollTo("conversation-bottom", anchor: .bottom)
          hasPositionedHistory = true
        }
      }
      .onChange(of: history.executionState) { _, _ in
        if hasPositionedHistory && followsLatestMessage {
          proxy.scrollTo("conversation-bottom", anchor: .bottom)
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
