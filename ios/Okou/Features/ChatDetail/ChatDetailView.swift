import SwiftUI

struct ChatDetailView: View {
  @Bindable var store: WorkspaceStore
  let thread: ChatThread
  @FocusState private var isComposing: Bool

  private var history: ChatHistory { store.histories[thread.id] ?? .empty }
  private var messages: [ChatMessage] { store.messages(for: thread.id) }
  private var draft: Binding<String> {
    Binding(get: { store.drafts[thread.id] ?? "" }, set: { store.drafts[thread.id] = $0 })
  }

  var body: some View {
    let displayedMessages = messages
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(displayedMessages.enumerated()), id: \.element.id) { index, message in
              let continuesAssistantGroup =
                message.role == .assistant && index > 0
                && displayedMessages[index - 1].role == .assistant
              messageRow(message, showsAvatar: !continuesAssistantGroup)
                .padding(.top, index == 0 || continuesAssistantGroup ? 0 : 16)
                .id(message.id)
            }
          }
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
              destination: store.webURL.appending(path: "chats/\(thread.id)")
            )
            .font(.caption).foregroundStyle(.secondary)
          }
          Color.clear.frame(height: 1).id("conversation-bottom")
        }
        .padding(20)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .scrollDismissesKeyboard(.interactively)
      .refreshable { await store.loadHistory(thread.id) }
      .onChange(of: displayedMessages.last?.id) {
        withAnimation { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
      }
    }
    .navigationTitle(thread.displayTitle)
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom, spacing: 0) { composer }
    .task(id: thread.id) { await store.loadHistory(thread.id) }
    .overlay {
      if store.loadingThreads.contains(thread.id) && store.histories[thread.id] == nil {
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
      MessageBodyView(text: message.text, baseURL: store.webURL)
        .foregroundStyle(message.isError ? Color.red : Color.primary)
        .padding(.leading, message.role == .assistant ? 6 : 0)
      if let pending = store.pending[thread.id]?.first(where: { $0.id == message.id }) {
        HStack {
          Text(pending.needsRetry ? "Delivery not confirmed" : "Sending…")
            .font(.caption).foregroundStyle(.secondary)
          if pending.needsRetry {
            Button("Check and retry") { Task { await store.retry(pending, in: thread) } }
              .font(.caption)
              .disabled(store.sendingThreads.contains(thread.id))
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

  private var composer: some View {
    VStack(spacing: 10) {
      if let error = store.threadErrors[thread.id] {
        VStack(alignment: .leading, spacing: 6) {
          Text(error).font(.caption).foregroundStyle(.red)
          HStack {
            Button("Refresh") { Task { await store.loadHistory(thread.id) } }
            Spacer()
            Link("Open on web", destination: store.webURL.appending(path: "chats/\(thread.id)"))
          }.font(.caption)
        }
      }
      HStack(alignment: .bottom, spacing: 10) {
        TextField("Message Okou", text: draft, axis: .vertical)
          .lineLimit(1...6)
          .focused($isComposing)
          .padding(.horizontal, 14).padding(.vertical, 12)
          .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
          .accessibilityIdentifier("message-input")
        Button {
          Task {
            if showsStop { await store.stop(thread) } else { await store.send(in: thread) }
          }
        } label: {
          Image(systemName: showsStop ? "stop.fill" : "arrow.up")
            .font(.system(size: 18, weight: .semibold))
            .frame(width: 42, height: 42)
        }
        .buttonStyle(.borderedProminent).buttonBorderShape(.circle)
        .accessibilityLabel(showsStop ? "Stop" : "Send message")
        .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
        .disabled(
          (!showsStop && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || store.sendingThreads.contains(thread.id)
            || store.stoppingThreads.contains(thread.id) || store.needsUpgrade)
      }
    }
    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
    .background(.bar)
  }

  private var showsStop: Bool {
    history.canStop && draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}
