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
          loadingRow("Loading chats…")
        } else if let error = workspace.list.error {
          OkouLoadErrorRow(message: error, actionTitle: "Reload chats") {
            await workspace.list.refresh()
          }
        }
        if let error = search.openingError {
          Text(error).foregroundStyle(OkouColor.mutedForeground)
        }
        let titles = search.titleResults(in: titleThreads)
        if !titles.isEmpty {
          Section {
            ForEach(titles) { thread in
              resultButton(threadID: thread.id) {
                VStack(alignment: .leading, spacing: OkouSpace.xs) {
                  Text(thread.displayTitle).lineLimit(1)
                  Text(agentName(thread.agentID)).font(.okou(.caption)).foregroundStyle(
                    OkouColor.mutedForeground)
                }
              }
            }
          } header: {
            Text(search.keyword.isEmpty ? LocalizedStringKey("Recent chats") : "Chat titles")
              .okouSectionHeader()
          }
        }
        if !search.keyword.isEmpty {
          Section {
            // One row per chat: several matches in the same chat are counted, not repeated.
            ForEach(messageGroups, id: \.result.chatThreadId) { group in
              resultButton(threadID: group.result.chatThreadId) {
                VStack(alignment: .leading, spacing: OkouSpace.xs) {
                  Text(
                    workspace.list.threads.first { $0.id == group.result.chatThreadId }?
                      .displayTitle ?? group.result.agentName
                  )
                  .lineLimit(1)
                  Text(group.result.snippet).font(.okou(.subheadline)).foregroundStyle(
                    OkouColor.mutedForeground
                  ).lineLimit(2)
                  HStack(spacing: OkouSpace.xs) {
                    Text(group.result.matchedMessage.createdAt, style: .date)
                    if group.count > 1 {
                      Text(verbatim: "·")
                      Text("\(group.count) matches")
                    }
                  }
                  .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
                }
              }
              .accessibilityIdentifier("search-message-\(group.result.id)")
            }
            if search.isLoading {
              loadingRow("Searching messages…")
            } else if let error = search.error {
              OkouLoadErrorRow(message: error) { search.retry() }
            } else if search.messages.isEmpty {
              Text(titles.isEmpty ? "No matching chats or messages." : "No matching messages.")
                .foregroundStyle(OkouColor.mutedForeground)
            }
          } header: {
            Text("Messages").okouSectionHeader()
          } footer: {
            Group {
              Text("Recent messages may take time to appear in search.")
                .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)

            }
            .okouSectionNote()
          }
        } else {
          Text("Search chat titles and messages across this workspace.")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .okouGroupedBackground()
      .navigationTitle("Search chats")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(
        text: Binding(get: { search.query }, set: { search.updateQuery($0) }),
        placement: .navigationBarDrawer(displayMode: .always), prompt: "Search workspace chats"
      )
      .toolbar {
        OkouCloseToolbarItem { search.dismiss() }
      }
    }
  }

  private var messageGroups: [(result: ChatSearchResult, count: Int)] {
    var order: [String] = []
    var groups: [String: (result: ChatSearchResult, count: Int)] = [:]
    for result in search.messages {
      if let existing = groups[result.chatThreadId] {
        groups[result.chatThreadId] = (existing.result, existing.count + 1)
      } else {
        order.append(result.chatThreadId)
        groups[result.chatThreadId] = (result, 1)
      }
    }
    return order.compactMap { groups[$0] }
  }

  private func loadingRow(_ title: LocalizedStringKey) -> some View {
    OkouLoadingRow(title)
  }

  private func agentName(_ id: String) -> String {
    if workspace.list.singleAgentEnabled
      && workspace.list.agents.first(where: { $0.agentId == id })?.isDefaultAgent == true
    {
      return "Okou"
    }
    return workspace.list.agents.first { $0.agentId == id }?.displayName ?? id
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
