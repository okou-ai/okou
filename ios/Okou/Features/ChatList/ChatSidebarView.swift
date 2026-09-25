import SwiftUI

struct ChatSidebarView: View {
  @Bindable var store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  @Binding var accountError: String?
  let close: () -> Void
  let newChat: (String?) -> Void

  @State private var showArchived = false
  @State private var renamingThread: ChatThread?
  @State private var renameTitle = ""

  private var workspaceName: String {
    authentication.workspaces.first(where: { $0.id == workspaceID })?.name ?? "Workspace"
  }

  private var visibleThreads: [ChatThread] {
    store.threads.filter { $0.agentID == store.selectedAgentID && $0.isArchived == showArchived }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 0)

      List {
        pinnedAgentsSection
        if let error = store.navigationError {
          Text(error)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        if let error = store.error {
          VStack(alignment: .leading, spacing: 8) {
            Text(error).font(.footnote).foregroundStyle(.secondary)
            Button("Try again") { Task { await store.refresh() } }
              .font(.footnote.weight(.semibold))
          }
        }
        if store.isLoading && store.threads.isEmpty {
          ProgressView("Loading chats…")
            .frame(maxWidth: .infinity)
        } else {
          threadSection
          if visibleThreads.isEmpty && store.error == nil {
            Text("Your conversations will appear here.")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        Color.clear
          .frame(height: 80)
          .listRowInsets(EdgeInsets())
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      .listStyle(.plain)
      .listSectionSpacing(.compact)
      .listRowSpacing(0)
      .environment(\.defaultMinListRowHeight, 0)
      .environment(\.defaultMinListHeaderHeight, 0)
      .scrollContentBackground(.hidden)
      .overlay(alignment: .bottom) { footer }
    }
    .background(Color(uiColor: .systemBackground))
    .alert(
      "Rename chat",
      isPresented: Binding(
        get: { renamingThread != nil },
        set: { if !$0 { renamingThread = nil } }
      )
    ) {
      TextField("Chat title", text: $renameTitle)
      Button("Cancel", role: .cancel) { renamingThread = nil }
      Button("Save") {
        if let thread = renamingThread {
          Task { await store.rename(thread, title: renameTitle) }
        }
        renamingThread = nil
      }
      .disabled(renameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }

  private var header: some View {
    workspaceSwitcher
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(height: 44)
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
      ForEach(store.visiblePinnedAgents, id: \.agentId) { agent in
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
    } header: {
      Text("Pinned Agents")
        .textCase(nil)
    }
  }

  private var threadSection: some View {
    Section {
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
        .contextMenu {
          Button(thread.pinnedAt == nil ? "Pin" : "Unpin", systemImage: "pin") {
            Task { await store.setPinned(thread, pinned: thread.pinnedAt == nil) }
          }
          Button("Rename", systemImage: "pencil") {
            renameTitle = thread.displayTitle
            renamingThread = thread
          }
          if store.canArchiveChats {
            Button(
              thread.isArchived ? "Unarchive" : "Archive",
              systemImage: thread.isArchived ? "archivebox.fill" : "archivebox"
            ) {
              Task { await store.setArchived(thread, archived: !thread.isArchived) }
            }
          }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if store.canArchiveChats {
            Button {
              Task { await store.setArchived(thread, archived: !thread.isArchived) }
            } label: {
              Label(thread.isArchived ? "Unarchive" : "Archive", systemImage: "archivebox")
            }
            .tint(.orange)
          }
        }
      }
    } header: {
      Text(showArchived ? "Archived" : "Recent")
        .lineLimit(1)
        .textCase(nil)
    }
  }

  private var footer: some View {
    HStack {
      Button {
        newChat(store.selectedAgentID)
      } label: {
        Label("Chat", systemImage: "square.and.pencil")
          .font(.system(size: 17, weight: .semibold))
          .padding(.horizontal, 18)
          .frame(height: 48)
          .foregroundStyle(Color(uiColor: .systemBackground))
          .background(Color.primary, in: Capsule())
      }
      .accessibilityLabel("New chat")
      .accessibilityIdentifier("new-chat")
      Spacer()
      Menu {
        if store.canArchiveChats {
          Button(
            showArchived ? "Show recent chats" : "Show archived chats", systemImage: "archivebox"
          ) {
            showArchived.toggle()
          }
        }
        Link("Open Okou on web", destination: store.webURL)
        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
          Task {
            do { try await authentication.signOut() } catch {
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
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 12)
  }
}
