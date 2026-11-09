import ChatData
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
  let newChat: () -> Void

  /// The shared chat filters, with Chats as the native default label.
  private enum ThreadFilter {
    case recent, unread, archived, muted
  }

  private func filterTitle(_ filter: ThreadFilter) -> LocalizedStringKey {
    switch filter {
    case .recent: "Chats"
    case .unread: "Unread"
    case .archived: "Archived"
    case .muted: "Muted"
    }
  }

  private struct ProjectEditor {
    let dialog: OkouNameDialog.Request
    let projectID: String?
    let fromThreadID: String?
  }

  @State private var projectEditor: ProjectEditor?
  @State private var pendingProjectEditor: ProjectEditor?
  @State private var membershipThread: ChatThread?
  @State private var deletingProject: ChatProject?
  @State private var projectAction: Task<Void, Never>?
  @State private var showArchived = false
  @State private var showMuted = false
  @State private var showsSettings = false
  /// Rows have scrolled under the top bar, so the workspace name gives way to them.
  @State private var isScrolled = false
  @Environment(\.newChatActivation) private var newChatActivation
  /// The scheme the page behind the Settings sheet resolved: the chosen one, or the system's.
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var workspaceName: String {
    authentication.workspaces.first(where: { $0.id == workspaceID })?.name ?? "Workspace"
  }

  @State private var menuLogos = OkouWorkspaceMenuLogos()
  @Namespace private var searchTransition
  /// One leading edge for the header, every heading, row content and the footer buttons.
  private let rowInset = OkouControl.pageInset

  /// A section shows a status column only when one of its own chats has a status emoji;
  /// a section without any keeps its titles flush.
  private func usesStatusColumn(_ threads: [ChatThread]) -> Bool {
    threads.contains { $0.titleParts.emoji != nil }
  }

  private var contents: ChatListContents {
    ChatListContents(
      projects: store.projects.projects, threads: store.list.threads,
      agentID: store.selectedAgentID, onlyUnread: store.list.onlyUnread,
      archived: showArchived, muted: showMuted)
  }

  private var visibleThreads: [ChatThread] { contents.threads }

  private var threadFilter: Binding<ThreadFilter> {
    Binding(
      get: {
        if store.list.onlyUnread { return .unread }
        if showMuted { return .muted }
        if showArchived { return .archived }
        return .recent
      },
      set: {
        store.list.onlyUnread = $0 == .unread
        showArchived = $0 == .archived
        showMuted = $0 == .muted
      })
  }

  var body: some View {
    List {
      if store.list.isLoading && !store.list.hasLoadedThreads {
        OkouLoadingRow("Loading chats…")
          .frame(maxWidth: .infinity)
          .listRowInsets(.horizontal, 0)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if !store.list.hasLoadedThreads && store.list.syncError != nil {
        Text("Your chats could not be loaded. Try updating again.")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          .listRowInsets(.horizontal, rowInset)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else {
        threadSection
        if visibleThreads.isEmpty && contents.projects.isEmpty && store.list.error == nil
          && store.error == nil
        {
          Text("Your chats will appear here.")
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
            .listRowInsets(.horizontal, rowInset)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
      }
    }
    .foregroundStyle(OkouColor.sidebarForeground)
    .listStyle(.plain)
    .listSectionSpacing(.compact)
    .listRowSpacing(0)
    .environment(\.defaultMinListRowHeight, 0)
    .environment(\.defaultMinListHeaderHeight, 0)
    .scrollContentBackground(.hidden)
    // The top is the system's soft edge (the app's default): rows blur away under the glass
    // buttons. The workspace name would sit over chat titles there, so it leaves as soon as
    // rows scroll under the bar, as Slack's does. The bottom has no edge effect, as
    // everywhere in the app: rows pass plainly under the footer's glass.
    .scrollEdgeEffectHidden(true, for: .bottom)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > OkouSpace.xs
    } action: { _, scrolled in
      isScrolled = scrolled
    }
    .safeAreaBar(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        // Sync problems float with the rest of the chat feedback, outside the sliding sidebar.
        header.padding(.horizontal, rowInset)
      }
    }
    .safeAreaBar(edge: .bottom, spacing: 0) { footer }
    .background(OkouColor.sidebar)
    .task { await store.projects.activate() }
    .onDisappear { projectAction?.cancel() }
    .background {
      OkouNameDialog(
        request: projectEditor?.dialog,
        cancel: { projectEditor = nil }, save: saveProjectName
      ).frame(width: 0, height: 0)
    }
    .sheet(
      item: $membershipThread,
      onDismiss: {
        if let pendingProjectEditor {
          showEditor(pendingProjectEditor)
          self.pendingProjectEditor = nil
        }
      }
    ) { thread in
      ChatProjectPicker(workspace: store, thread: thread) {
        pendingProjectEditor = editor(fromThreadID: thread.id)
        membershipThread = nil
      }
      .okouSheetBackground()
    }
    .alert(
      "Delete project?",
      isPresented: Binding(
        get: { deletingProject != nil },
        set: { if !$0 { deletingProject = nil } }
      ), presenting: deletingProject
    ) { project in
      Button("Cancel", role: .cancel) {}
      Button("Delete project", role: .destructive) {
        projectAction?.cancel()
        projectAction = Task {
          if await store.projects.delete(project.id), store.newChatProjectID == project.id {
            store.removeNewChatProject()
          }
        }
      }
    } message: { _ in
      Text("Your chats will be kept and moved out of this project.")
    }
    .onChange(of: newChatActivation) { _, _ in showsSettings = false }
    // Search is a page of its own: it grows out of the search capsule and fills the screen.
    .fullScreenCover(
      isPresented: Binding(
        get: { store.search.isPresented },
        set: { if !$0 { store.search.dismiss() } }
      )
    ) {
      ChatSearchView(
        workspace: store, showsArchived: showArchived, didOpen: close,
        openWorkflow: { workflow in
          store.search.dismiss()
          newChat()
          store.useWorkflow(named: workflow.name)
        }
      )
      .navigationTransition(.zoom(sourceID: "search", in: searchTransition))
    }
  }

  /// As Slack's: the workspace's logo as a glass button that opens the switcher, its name
  /// beside it with no arrow, and on the right the way back to the chat the sidebar covers.
  /// The name leaves once rows scroll under the bar; the glass buttons stay.
  private var header: some View {
    HStack(spacing: OkouSpace.md) {
      workspaceSwitcher
      Text(workspaceName)
        .font(.okou(.headline))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isScrolled ? 0 : 1)
        .animation(OkouMotion.transition, value: isScrolled)
        // The switcher's label already names the workspace.
        .accessibilityHidden(true)
      Button(action: close) {
        OkouToolbarIcon("chevrons-right").modifier(OkouGlassControl(shape: .circle))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back to chat")
      .accessibilityIdentifier("back-to-chat")
    }
    .frame(minHeight: headerHeight)
  }

  private var workspaceSwitcher: some View {
    Menu {
      // A picker draws the system's check beside the current workspace, and every row
      // carries its logo, as the web's switcher does.
      Picker("Workspace", selection: workspaceSelection) {
        ForEach(authentication.workspaces) { workspace in
          Label {
            Text(workspace.name)
          } icon: {
            menuLogos.image(
              workspaceID: workspace.id, imageURL: workspace.imageURL,
              hasImage: workspace.hasImage)
          }
          .tag(workspace.id)
        }
      }
      .pickerStyle(.inline)
      .labelsHidden()
    } label: {
      let workspace = authentication.workspaces.first(where: { $0.id == workspaceID })
      OkouWorkspaceGlassLogo(
        workspaceID: workspaceID, name: workspaceName,
        imageURL: workspace?.imageURL, hasImage: workspace?.hasImage ?? false
      )
      .accessibilityHidden(true)
    }
    .buttonStyle(.plain)
    .disabled(authentication.isSwitchingWorkspace || authentication.workspaces.isEmpty)
    .accessibilityLabel("Workspace: \(workspaceName)")
    .task(id: authentication.workspaces) {
      for workspace in authentication.workspaces {
        await menuLogos.load(
          workspaceID: workspace.id, imageURL: workspace.imageURL, hasImage: workspace.hasImage)
      }
    }
  }

  private var workspaceSelection: Binding<String> {
    Binding {
      workspaceID
    } set: { id in
      Task {
        do { try await authentication.switchWorkspace(id) } catch {
          accountError = error.localizedDescription
        }
      }
    }
  }

  private var threadSection: some View {
    let contents = contents
    return Section {
      threadMenu
      if let error = store.projects.readError {
        OkouBanner(Text(error), icon: "folder", tone: .problem) {
          Button("Retry") { Task { await store.projects.refresh() } }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      if let error = store.projects.actionError {
        OkouBanner(
          Text(error), icon: "circle-alert", tone: .problem,
          dismiss: store.projects.dismissError
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      ForEach(contents.projects) { group in
        projectRow(group.project)
        if store.projects.isExpanded(group.id) {
          if group.threads.isEmpty {
            Text("No chats yet")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
              .listRowInsets(.horizontal, rowInset + OkouSpace.xxl)
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
          }
          ForEach(group.threads.prefix(store.projects.limit(for: group.id))) { thread in
            threadRow(
              thread, showsStatusColumn: usesStatusColumn(group.threads),
              indentation: OkouSpace.xxl)
          }
          if group.threads.count > store.projects.limit(for: group.id) {
            Button("Show more") { store.projects.showMore(group.id) }
              .font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
              .listRowInsets(.horizontal, rowInset + OkouSpace.xxl)
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
          }
        }
      }
      ForEach(contents.threads) { thread in
        threadRow(thread, showsStatusColumn: usesStatusColumn(contents.threads))
      }
    }
  }

  private func projectRow(_ project: ChatProject) -> some View {
    let expanded = store.projects.isExpanded(project.id)
    return Button {
      withAnimation(reduceMotion ? nil : OkouMotion.transition) {
        store.projects.toggle(project.id)
      }
    } label: {
      HStack(spacing: OkouSpace.sm) {
        OkouIcon(expanded ? "chevron-down" : "chevron-right", size: OkouIconSize.inline)
          .foregroundStyle(OkouColor.mutedForeground)
        OkouIcon(expanded ? "folder-open" : "folder", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.mutedForeground)
        Text(verbatim: project.name).font(.okou(.body)).lineLimit(1)
        Spacer(minLength: 0)
      }
      .frame(minHeight: OkouControl.listRow)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("project-\(project.id)")
    .accessibilityValue(expanded ? Text("Expanded") : Text("Collapsed"))
    .listRowInsets(EdgeInsets(top: 0, leading: rowInset, bottom: 0, trailing: rowInset))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
    .contextMenu {
      Button("New chat", okouSymbol: "square-pen") {
        store.startNewChat(projectID: project.id)
        close()
      }
      .disabled(store.isCreating || store.needsUpgrade)
      Button("Rename", okouSymbol: "pencil") { showEditor(editor(project: project)) }
      Button("Delete project", okouSymbol: "trash-2", role: .destructive) {
        deletingProject = project
      }
    }
    .disabled(store.needsUpgrade || store.projects.pending.contains(project.id))
  }

  private func editor(project: ChatProject? = nil, fromThreadID: String? = nil) -> ProjectEditor {
    ProjectEditor(
      dialog: OkouNameDialog.Request(
        title: project == nil
          ? String(localized: "New project") : String(localized: "Rename project"),
        placeholder: String(localized: "Project name"), name: project?.name ?? "",
        maximumLength: 120, accessibilityIdentifier: "project-name"),
      projectID: project?.id, fromThreadID: fromThreadID)
  }

  private func saveProjectName(_ name: String) {
    guard let request = projectEditor else { return }
    projectEditor = nil
    projectAction?.cancel()
    projectAction = Task {
      let saved: Bool
      if let id = request.projectID {
        saved = await store.projects.rename(id, name: name)
      } else {
        saved = await store.projects.create(name: name, fromThreadID: request.fromThreadID) != nil
      }
      guard !Task.isCancelled, !saved else { return }
      projectEditor = ProjectEditor(
        dialog: OkouNameDialog.Request(
          title: request.dialog.title, placeholder: request.dialog.placeholder,
          name: name, error: store.projects.actionError,
          maximumLength: 120, accessibilityIdentifier: "project-name"),
        projectID: request.projectID, fromThreadID: request.fromThreadID)
    }
  }

  private func showEditor(_ request: ProjectEditor) {
    projectAction?.cancel()
    projectEditor = request
  }

  private func threadRow(
    _ thread: ChatThread,
    showsStatusColumn: Bool = false, indentation: CGFloat = 0
  ) -> some View {
    Button {
      store.selectChat(thread.id)
      close()
    } label: {
      let parts = thread.titleParts
      let trailing: OkouChatTrailing = thread.pinnedAt != nil ? .pinned : .none
      if showsStatusColumn {
        // Every row in the section fills the column, so titles share one left edge.
        OkouChatRowLabel(parts.text, trailing: trailing) {
          OkouChatStatusMark(emoji: parts.emoji)
        }
      } else {
        OkouChatRowLabel(parts.text, trailing: trailing)
      }
    }
    .buttonStyle(.plain)
    .listRowInsets(
      EdgeInsets(top: 0, leading: rowInset + indentation, bottom: 0, trailing: rowInset)
    )
    .listRowSeparator(.hidden)
    .listRowBackground(
      RoundedRectangle(cornerRadius: OkouRadius.control)
        .fill(
          store.selectedThreadID == thread.id
            ? OkouColor.stateSelected : .clear
        )
        .padding(.horizontal, OkouSpace.md)
    )
    .accessibilityIdentifier("chat-\(thread.id)")
    .accessibilityAddTraits(store.selectedThreadID == thread.id ? .isSelected : [])
    .accessibilityValue(thread.pinnedAt != nil ? "Pinned" : "")
    .contextMenu {
      Button("Move to project", okouSymbol: "folder-input") { membershipThread = thread }
        .disabled(store.needsUpgrade || !store.list.canUpdate(thread.id))
      if !thread.isMuted {
        readAction(thread, read: true)
        readAction(thread, read: false)
      }
      Button(
        thread.pinnedAt == nil ? "Pin" : "Unpin",
        okouSymbol: thread.pinnedAt == nil ? "pin" : "pin-off"
      ) {
        Task { await store.list.togglePinned(thread.id) }
      }
      .disabled(!store.list.canPin(thread.id) || store.needsUpgrade)
      Button("Rename", okouSymbol: "pencil") {
        store.list.beginRename(thread.id)
      }
      .disabled(
        !store.list.canUpdate(thread.id) || store.list.isSavingRename || store.needsUpgrade)
      Button(
        thread.isArchived ? "Unarchive" : "Archive",
        okouSymbol: thread.isArchived ? "archive-restore" : "archive"
      ) {
        Task { await store.setArchived(thread.id, archived: !thread.isArchived) }
      }
      .disabled(!store.list.canUpdate(thread.id) || store.needsUpgrade)
    }
    // Every row action is on the right swipe: a left swipe anywhere in the sidebar closes it.
    .swipeActions(edge: .leading, allowsFullSwipe: false) {
      if !thread.isMuted {
        readAction(thread, read: thread.isUnread).tint(OkouSwipeTint.readState)
      }
      Button {
        Task { await store.setArchived(thread.id, archived: !thread.isArchived) }
      } label: {
        Label(thread.isArchived ? "Unarchive" : "Archive", okouSymbol: "archive")
      }
      .tint(OkouSwipeTint.neutral)
      .disabled(!store.list.canUpdate(thread.id) || store.needsUpgrade)
    }

  }

  private var threadMenu: some View {
    HStack {
      Menu {
        Picker("Chats", selection: threadFilter) {
          Text(filterTitle(.recent)).tag(ThreadFilter.recent)
          Text(filterTitle(.unread)).tag(ThreadFilter.unread)
          Text(filterTitle(.archived)).tag(ThreadFilter.archived)
          Text(filterTitle(.muted)).tag(ThreadFilter.muted)
        }
        .pickerStyle(.inline)
        if let agentID = store.selectedAgentID {
          Divider()
          Button("Mark all as read") {
            Task { await store.list.markAgentRead(agentID) }
          }
          .disabled(
            store.list.markingAgentRead || !store.list.updatingThreads.isEmpty
              || !store.list.unreadAgentIDs.contains(agentID))
        }
      } label: {
        HStack(spacing: 5) {
          Text(filterTitle(threadFilter.wrappedValue))
            .lineLimit(1)
          OkouIcon("chevron-down", size: OkouIconSize.inline)
            .accessibilityHidden(true)
        }
        .font(.okou(.subheadline).weight(.semibold))
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(minHeight: OkouControl.minimumTarget)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Chat list")
      .accessibilityValue(Text(filterTitle(threadFilter.wrappedValue)))
      .accessibilityAddTraits(.isHeader)
      .accessibilityIdentifier("chat-list-filter")
      // The menu opens from what it is attached to: the label's own width, so it drops from
      // "Chats ⌄" on the left instead of from the middle of a full-width row.
      .frame(maxWidth: .infinity, alignment: .leading)
      Button("New project", okouSymbol: "folder-plus") { showEditor(editor()) }
        .labelStyle(.iconOnly)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .disabled(store.needsUpgrade || store.projects.pending.contains("create"))
        .accessibilityIdentifier("new-project")
    }
    .buttonStyle(.plain)
    .listRowInsets(EdgeInsets(top: 2, leading: rowInset, bottom: 0, trailing: rowInset))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func readAction(_ thread: ChatThread, read: Bool) -> some View {
    Button(
      read ? "Mark as read" : "Mark as unread",
      okouSymbol: read ? "mail-open" : "mail"
    ) { Task { await store.setRead(thread, read: read) } }
    .disabled(store.list.updatingThreads.contains(thread.id) || store.list.markingAgentRead)
  }

  /// Thumb-reach bar: the account (settings) on the left, search in the middle, and the one
  /// primary action, a new chat, on the right.
  private var footer: some View {
    HStack(spacing: OkouSpace.md) {
      Button {
        showsSettings = true
      } label: {
        let profile = authentication.profile
        OkouProfileAvatar(
          imageURL: profile?.imageURL, hasImage: profile?.hasImage ?? false,
          size: OkouControl.minimumTarget)
      }
      .accessibilityLabel("Settings")
      .accessibilityIdentifier("settings")
      .sheet(isPresented: $showsSettings) {
        ChatSettingsView(
          store: store, authentication: authentication, notifications: notifications,
          accountError: $accountError
        )
        .okouSheetBackground()
        // The appearance is picked in this sheet while it is open. A sheet keeps the scheme
        // it opened with, and `preferredColorScheme(nil)` for System does not clear it, so
        // the sheet takes the scheme the page behind it resolved and switches with it.
        .preferredColorScheme(colorScheme)
      }
      Button {
        store.search.present()
      } label: {
        OkouSearchBar(prompt: "Search chats")
      }
      .buttonStyle(.plain)
      .matchedTransitionSource(id: "search", in: searchTransition)
      .accessibilityLabel("Search chats")
      .accessibilityIdentifier("search-chats")
      Button {
        newChat()
      } label: {
        OkouToolbarIcon("square-pen")
          .modifier(OkouGlassControl(shape: .circle))
      }
      .accessibilityLabel("New chat")
      .accessibilityIdentifier("new-chat")
    }
    .buttonStyle(.plain)
    .frame(height: ChatComposerView.compactHeight)
    .padding(.horizontal, rowInset)
    .padding(.top, OkouSpace.sm)
  }
}
