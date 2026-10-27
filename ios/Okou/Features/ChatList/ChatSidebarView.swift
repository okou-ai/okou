import ChatDomain
import SwiftUI

struct ChatSidebarView: View {
  @Bindable var store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  let notifications: NotificationService
  let headerHeight: CGFloat
  @Binding var accountError: String?
  let close: () -> Void
  let newChat: (String?) -> Void

  private enum ThreadFilter {
    case recent, unread, archived

    var title: LocalizedStringKey {
      switch self {
      case .recent: "Recent"
      case .unread: "Unread"
      case .archived: "Archived"
      }
    }
  }

  @State private var showArchived = false

  private var workspaceName: String {
    authentication.workspaces.first(where: { $0.id == workspaceID })?.name ?? "Workspace"
  }

  private var visibleThreads: [ChatThread] {
    store.list.threads(agentID: store.selectedAgentID, archived: showArchived)
  }

  private var threadFilter: Binding<ThreadFilter> {
    Binding(
      get: {
        store.list.onlyUnread
          ? .unread : (store.list.canArchiveChats && showArchived ? .archived : .recent)
      },
      set: {
        store.list.onlyUnread = $0 == .unread
        showArchived = $0 == .archived
      })
  }

  private var markAgentReadTitle: LocalizedStringKey {
    if let name = store.list.agents.first(where: { $0.agentId == store.selectedAgentID })?
      .displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
    {
      return "Mark all chats for \(name) as read"
    }
    return "Mark all as read for this agent"
  }

  var body: some View {
    List {
      pinnedAgentsSection
      if let error = store.list.navigationError {
        Text(error)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      if let error = store.list.error ?? store.error {
        VStack(alignment: .leading, spacing: 8) {
          Text(error).font(.footnote).foregroundStyle(.secondary)
          Button("Try again") { Task { await store.refresh() } }
            .font(.footnote.weight(.semibold))
        }
      }
      if store.list.isLoading && !store.list.hasLoadedThreads {
        ProgressView("Loading chats…")
          .frame(maxWidth: .infinity)
      } else {
        threadSection
        if visibleThreads.isEmpty && store.list.error == nil && store.error == nil {
          Text("Your conversations will appear here.")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(.compact)
    .listRowSpacing(0)
    .environment(\.defaultMinListRowHeight, 0)
    .environment(\.defaultMinListHeaderHeight, 0)
    .scrollContentBackground(.hidden)
    .scrollEdgeEffectStyle(.soft, for: .top)
    .scrollEdgeEffectHidden(true, for: .bottom)
    .safeAreaBar(edge: .top, spacing: 0) {
      header
        .padding(.horizontal, 16)
    }
    .safeAreaBar(edge: .bottom, spacing: 0) { footer }
    .background(Color(uiColor: .systemBackground))
    .sheet(
      isPresented: Binding(
        get: { store.search.isPresented },
        set: { if !$0 { store.search.dismiss() } }
      )
    ) {
      ChatSearchView(workspace: store, showsArchived: showArchived, didOpen: close)
    }
  }

  private var header: some View {
    HStack {
      workspaceSwitcher.frame(maxWidth: .infinity, alignment: .leading)
      Button("Search", systemImage: "magnifyingglass") { store.search.present() }
        .labelStyle(.iconOnly)
        .buttonStyle(.glass)
        .accessibilityIdentifier("search-chats")
    }
    .frame(height: headerHeight)
  }

  private var workspaceSwitcher: some View {
    Menu {
      ForEach(authentication.workspaces) { workspace in
        Button {
          Task {
            do { try await authentication.switchWorkspace(workspace.id) } catch {
              accountError = error.localizedDescription
            }
          }
        } label: {
          if workspace.id == workspaceID {
            Label(workspace.name, systemImage: "checkmark")
          } else {
            Text(workspace.name)
          }
        }
      }
    } label: {
      HStack(spacing: 9) {
        Text(workspaceName)
          .font(.system(size: 22, weight: .semibold))
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(authentication.isSwitchingWorkspace || authentication.workspaces.isEmpty)
    .accessibilityLabel("Workspace: \(workspaceName)")
  }

  private var pinnedAgentsSection: some View {
    Section {
      scrollingSectionHeading("Pinned Agents")
      ForEach(store.list.visiblePinnedAgents, id: \.agentId) { agent in
        Button {
          newChat(agent.agentId)
        } label: {
          HStack(spacing: 10) {
            if agent.isDefaultAgent {
              Image("AssistantAvatar")
                .resizable()
                .scaledToFit()
                .frame(width: 26, height: 26)
            } else {
              Text(String((agent.displayName ?? "A").prefix(1)))
                .font(.system(size: 15, weight: .medium))
                .frame(width: 26, height: 26)
                .background(
                  Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 7))
            }
            Text(agent.displayName ?? "Okou")
              .font(.system(size: 18))
              .lineLimit(1)
            Spacer(minLength: 0)
          }
          .frame(height: 50)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
        .listRowSeparator(.hidden)
        .listRowBackground(
          RoundedRectangle(cornerRadius: 12)
            .fill(
              store.selectedThreadID == nil && store.selectedAgentID == agent.agentId
                ? Color(uiColor: .secondarySystemBackground) : .clear
            )
            .padding(.horizontal, 12)
        )
        .accessibilityIdentifier("agent-\(agent.agentId)")
      }
    }
  }

  private var threadSection: some View {
    Section {
      threadMenu
      ForEach(visibleThreads) { thread in
        Button {
          store.selectChat(thread.id)
          close()
        } label: {
          HStack(spacing: 10) {
            Text(thread.displayTitle)
              .font(.system(size: 17, weight: .regular))
              .lineLimit(1)
            Spacer(minLength: 0)
            if thread.indicator == .active {
              ProgressView()
                .controlSize(.small)
                .accessibilityLabel("Working")
            } else if thread.indicator == .unread {
              Circle()
                .fill(Color.accentColor)
                .frame(width: 7, height: 7)
                .accessibilityLabel("Unread")
            } else if thread.pinnedAt != nil {
              Image(systemName: "pin.fill")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
          }
          .frame(height: 48)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 24, bottom: 0, trailing: 24))
        .listRowSeparator(.hidden)
        .listRowBackground(
          RoundedRectangle(cornerRadius: 12)
            .fill(
              store.selectedThreadID == thread.id
                ? Color(uiColor: .secondarySystemBackground) : .clear
            )
            .padding(.horizontal, 12)
        )
        .accessibilityIdentifier("chat-\(thread.id)")
        .accessibilityAddTraits(store.selectedThreadID == thread.id ? .isSelected : [])
        .accessibilityValue(thread.pinnedAt != nil ? "Pinned" : "")
        .contextMenu {
          if !thread.isMuted {
            readAction(thread, read: true)
            readAction(thread, read: false)
          }
          Button(
            thread.pinnedAt == nil ? "Pin" : "Unpin",
            systemImage: thread.pinnedAt == nil ? "pin" : "pin.slash"
          ) {
            Task { await store.list.togglePinned(thread.id) }
          }
          .disabled(!store.list.canPin(thread.id) || store.needsUpgrade)
          Button("Rename", systemImage: "pencil") {
            store.list.beginRename(thread.id)
          }
          .disabled(
            !store.list.canUpdate(thread.id) || store.list.isSavingRename || store.needsUpgrade)
          if store.list.canArchiveChats {
            Button(
              thread.isArchived ? "Unarchive" : "Archive",
              systemImage: thread.isArchived ? "archivebox.fill" : "archivebox"
            ) {
              Task { await store.setArchived(thread.id, archived: !thread.isArchived) }
            }
            .disabled(!store.list.canUpdate(thread.id) || store.needsUpgrade)
          }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
          if !thread.isMuted {
            readAction(thread, read: thread.isUnread).tint(.blue)
          }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if store.list.canArchiveChats {
            Button {
              Task { await store.setArchived(thread.id, archived: !thread.isArchived) }
            } label: {
              Label(thread.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
            }
            .tint(.orange)
            .disabled(!store.list.canUpdate(thread.id) || store.needsUpgrade)
          }
        }
      }
    }
  }

  private var threadMenu: some View {
    Menu {
      Picker("Chats", selection: threadFilter) {
        Text("Recent").tag(ThreadFilter.recent)
        Text("Unread").tag(ThreadFilter.unread)
        if store.list.canArchiveChats {
          Text("Archived").tag(ThreadFilter.archived)
        }
      }
      .pickerStyle(.inline)
      if let agentID = store.selectedAgentID {
        Divider()
        Button(markAgentReadTitle, systemImage: "checkmark.message") {
          Task { await store.list.markAgentRead(agentID) }
        }
        .disabled(
          store.list.markingAgentRead || !store.list.updatingThreads.isEmpty
            || !store.list.unreadAgentIDs.contains(agentID))
      }
    } label: {
      HStack(spacing: 5) {
        Text(threadFilter.wrappedValue.title)
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.semibold))
          .accessibilityHidden(true)
      }
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Chat list")
    .accessibilityValue(Text(threadFilter.wrappedValue.title))
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier("chat-list-filter")
    .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 0, trailing: 16))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func readAction(_ thread: ChatThread, read: Bool) -> some View {
    Button(
      read ? "Mark as read" : "Mark as unread",
      systemImage: read ? "envelope.open" : "envelope.badge"
    ) { Task { await store.setRead(thread, read: read) } }
    .disabled(store.list.updatingThreads.contains(thread.id) || store.list.markingAgentRead)
  }

  private func scrollingSectionHeading(_ title: String) -> some View {
    Text(title)
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.secondary)
      .lineLimit(1)
      .accessibilityAddTraits(.isHeader)
      .listRowInsets(EdgeInsets(top: 14, leading: 16, bottom: 8, trailing: 16))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
  }

  private var footer: some View {
    HStack {
      Button {
        newChat(store.selectedAgentID)
      } label: {
        Label("Chat", systemImage: "square.and.pencil")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(.primary)
      }
      .buttonStyle(.glass)
      .buttonBorderShape(.capsule)
      .controlSize(.large)
      .accessibilityLabel("New chat")
      .accessibilityIdentifier("new-chat")
      Spacer()
      Menu {
        Link("Open Okou on web", destination: store.webURL)
        Button(
          notifications.status == .authorized ? "Notifications enabled" : "Enable notifications",
          systemImage: "bell"
        ) {
          Task { await notifications.enable() }
        }
        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
          Task {
            do {
              try await notifications.signOut(authentication: authentication)
            } catch {
              accountError = error.localizedDescription
            }
          }
        }
      } label: {
        Image(systemName: "gearshape")
          .font(.system(size: 21))
          .frame(width: 32, height: 32)
      }
      .buttonStyle(.glass)
      .accessibilityLabel("Account")
    }
    .buttonStyle(.plain)
    .frame(height: ChatComposerView.compactHeight)
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }
}
