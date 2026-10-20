import ChatData
import ChatDomain
import SwiftUI

struct ChatSearchView: View {
  @Bindable var workspace: WorkspaceStore
  var showsArchived = false
  let didOpen: () -> Void
  @State private var openingID: String?
  private var search: ChatSearchStore { workspace.search }

  private var titleThreads: [ChatThread] {
    search.keyword.isEmpty
      ? workspace.list.threads(agentID: workspace.selectedAgentID, archived: showsArchived)
      : workspace.list.threads
  }

  var body: some View {
    NavigationStack {
      List {
        if workspace.list.isLoading && workspace.list.threads.isEmpty {
          ProgressView("Loading chats…")
        } else if let error = workspace.list.error {
          VStack(alignment: .leading, spacing: 8) {
            Text(error).foregroundStyle(.secondary)
            Button("Reload chats") { Task { await workspace.list.refresh() } }
          }
        }
        if let error = search.openingError { Text(error).foregroundStyle(.secondary) }
        let titles = search.titleResults(in: titleThreads)
        if !titles.isEmpty {
          Section(search.keyword.isEmpty ? "Recent chats" : "Chat titles") {
            ForEach(titles) { thread in
              resultButton(threadID: thread.id) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(thread.displayTitle).lineLimit(1)
                  Text(agentName(thread.agentID)).font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
        if !search.keyword.isEmpty {
          Section("Messages") {
            ForEach(search.messages) { result in
              resultButton(threadID: result.chatThreadId) {
                VStack(alignment: .leading, spacing: 4) {
                  Text(
                    workspace.list.threads.first { $0.id == result.chatThreadId }?.displayTitle
                      ?? result.agentName
                  )
                  .lineLimit(1)
                  Text(result.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                  Text(result.matchedMessage.createdAt, style: .date)
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
              .accessibilityIdentifier("search-message-\(result.id)")
            }
            if search.isLoading {
              ProgressView("Searching messages…")
            } else if let error = search.error {
              VStack(alignment: .leading, spacing: 8) {
                Text(error).foregroundStyle(.secondary)
                Button("Try again") { search.retry() }
              }
            } else if search.messages.isEmpty {
              Text(titles.isEmpty ? "No matching chats or messages." : "No matching messages.")
                .foregroundStyle(.secondary)
            }
          }
          Section {
            Text("Recent messages may take time to appear in search.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        } else {
          Text("Search chat titles and messages across this workspace.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Search chats")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(
        text: Binding(get: { search.query }, set: { search.updateQuery($0) }),
        placement: .navigationBarDrawer(displayMode: .always), prompt: "Search workspace chats"
      )
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { search.dismiss() }
        }
      }
    }
  }

  private func agentName(_ id: String) -> String {
    workspace.list.agents.first { $0.agentId == id }?.displayName ?? id
  }

  private func resultButton<Content: View>(threadID: String, @ViewBuilder label: () -> Content)
    -> some View
  {
    Button {
      openingID = threadID
      Task {
        defer { openingID = nil }
        if await workspace.openSearchResult(threadID) { didOpen() }
      }
    } label: {
      HStack {
        label().frame(maxWidth: .infinity, alignment: .leading)
        if openingID == threadID { ProgressView().controlSize(.small) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(openingID != nil)
  }
}
