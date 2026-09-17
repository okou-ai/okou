import SwiftUI

struct ChatListView: View {
  @Bindable var store: WorkspaceStore

  var body: some View {
    List {
      if let error = store.error {
        Section {
          VStack(alignment: .leading, spacing: 10) {
            Label(error, systemImage: "exclamationmark.circle")
              .font(.subheadline)
            HStack {
              Button("Try again") { Task { await store.refresh() } }
              Spacer()
              Link("Open Okou on web", destination: store.webURL)
            }
          }
          .padding(.vertical, 6)
        }
      }
      if store.threads.isEmpty && !store.isLoading && store.error == nil {
        ContentUnavailableView {
          Label("Your conversations", systemImage: "bubble.left.and.bubble.right")
        } description: {
          Text("Start a chat with your workspace's default agent.")
        } actions: {
          Button("New chat") { Task { await store.createChat() } }
            .buttonStyle(.borderedProminent)
            .disabled(store.isCreating)
        }
        .listRowBackground(Color.clear)
      }
      ForEach(store.threads) { thread in
        Button {
          store.path.append(thread.id)
        } label: {
          HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
              Text(thread.displayTitle)
                .font(.body.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
              Text(thread.updatedAt, style: .relative)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if thread.indicator == .active {
              ProgressView().controlSize(.small)
                .accessibilityLabel("Working")
            } else if thread.indicator == .unread {
              Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                .accessibilityLabel("Unread")
            }
          }
          .padding(.vertical, 8)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-\(thread.id)")
      }
    }
    .listStyle(.plain)
    .overlay {
      if store.isLoading && store.threads.isEmpty { ProgressView("Loading chats…") }
    }
    .navigationTitle("Chats")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button {
          Task { await store.createChat() }
        } label: {
          if store.isCreating { ProgressView() } else { Image(systemName: "square.and.pencil") }
        }
        .accessibilityLabel("New chat")
        .accessibilityIdentifier("new-chat")
        .disabled(store.isCreating || store.needsUpgrade)
      }
    }
    .refreshable { await store.refresh() }
    .safeAreaInset(edge: .bottom) {
      if store.connectionStatus != "Connected" {
        Text(store.connectionStatus)
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .padding(8)
          .background(.bar)
      }
    }
  }
}
