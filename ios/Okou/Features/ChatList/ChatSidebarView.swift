import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

struct ChatSidebarView: View {
  @Bindable var store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  let notifications: NotificationService
  let sidebar: SidebarInteraction
  let headerHeight: CGFloat
  @Binding var accountError: String?
  let close: () -> Void
  let newChat: () -> Void
  @LoadableValue private var projectRead: Loadable<[ChatProject]>
  @LoadableValue private var presentation: Loadable<ChatSidebarPresentation>

  init(
    store: WorkspaceStore, authentication: AuthenticationService, workspaceID: String,
    notifications: NotificationService, sidebar: SidebarInteraction, headerHeight: CGFloat,
    accountError: Binding<String?>, close: @escaping () -> Void, newChat: @escaping () -> Void
  ) {
    self.store = store
    self.authentication = authentication
    self.workspaceID = workspaceID
    self.notifications = notifications
    self.sidebar = sidebar
    self.headerHeight = headerHeight
    _accountError = accountError
    self.close = close
    self.newChat = newChat
    _projectRead = LoadableValue(task: store.projects.listValue, keepLast: true)
    _presentation = LoadableValue(store.sidebar.presentation)
  }

  private struct ProjectEditor {
    let dialog: OkouNameDialog.Request
    let projectID: String
  }

  @State private var projectEditor: ProjectEditor?
  @State private var membershipThread: ChatThread?
  @State private var deletingProject: ChatProject?
  @State private var projectAction: Task<Void, Never>?
  @State private var showsSettings = false
  /// Rows have scrolled under the top bar, so the workspace name gives way to them.
  @State private var isScrolled = false
  @AppStorage("okou.sidebar.pinnedCollapsed") private var pinnedCollapsed = false
  @Environment(\.newChatActivation) private var newChatActivation
  /// The scheme the page behind the Settings sheet resolved: the chosen one, or the system's.
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  /// One leading edge for the header, every heading, row content and the footer buttons.
  private let rowInset = OkouControl.pageInset

  private var threadFilter: Binding<ChatListFilter> {
    Binding(get: { store.sidebar.filter }, set: { store.sidebar.select($0) })
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
      } else if case .hasError(let error) = presentation {
        Text(error.localizedDescription)
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          .listRowInsets(.horizontal, rowInset)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if case .hasData(let presentation) = presentation {
        threadSection(presentation)
        if presentation.isEmpty && store.list.error == nil && store.error == nil {
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
    // Pinned's fold is stored in UserDefaults, whose updates arrive outside the toggle's
    // transaction, so the list animates on the value itself: the pinned rows slide away under
    // the heading as its chevron turns.
    .animation(reduceMotion ? nil : OkouMotion.disclosure, value: pinnedCollapsed)
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
    // The list starts a step below the header, so the first row's selection never touches
    // the glass buttons.
    .safeAreaBar(edge: .top, spacing: OkouSpace.md) {
      VStack(spacing: 0) {
        // Sync problems float with the rest of the chat feedback, outside the sliding sidebar.
        header.padding(.horizontal, rowInset)
      }
    }
    .safeAreaBar(edge: .bottom, spacing: 0) { footer }
    // VoiceOver's escape gesture returns to the chat, as the left swipe does.
    .accessibilityAction(.escape, close)
    .background(OkouColor.sidebar)
    .task { await store.projects.activate() }
    .onDisappear { projectAction?.cancel() }
    .background {
      OkouNameDialog(
        request: projectEditor?.dialog,
        cancel: { projectEditor = nil }, save: saveProjectName
      ).frame(width: 0, height: 0)
    }
    .chatProjectMembershipPicker(workspace: store, thread: $membershipThread)
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
          await store.deleteProject(project.id)
        }
      }
    } message: { _ in
      Text("Your chats will be kept and moved out of this project.")
    }
    .onChange(of: newChatActivation) { _, _ in showsSettings = false }
    .sheet(
      isPresented: Binding(
        get: { store.search.isPresented },
        set: { if !$0 { store.search.dismiss() } }
      )
    ) {
      ChatSearchView(
        workspace: store, showsArchived: store.sidebar.filter == .archived, didOpen: close,
        openWorkflow: { workflow in
          store.search.dismiss()
          newChat()
          store.useWorkflow(named: workflow.name)
        }
      )
      .presentationDetents([.large])
      .presentationDragIndicator(.visible)
      .okouSheetBackground(OkouColor.background)
    }
  }

  /// As Slack's: the workspace's logo as a glass button that opens the switcher, its name
  /// beside it with no arrow, and on the right the chat filter. A left swipe returns to the
  /// chat the sidebar covers. The name leaves once rows scroll under the bar; the glass
  /// buttons stay.
  private var header: some View {
    HStack(spacing: OkouSpace.md) {
      workspaceSwitcher
      Text(workspaceName)
        .redacted(
          reason: authentication.workspacePresentation(workspaceID) == nil ? .placeholder : []
        )
        .font(.okou(.headline))
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(isScrolled ? 0 : 1)
        .animation(OkouMotion.transition, value: isScrolled)
        // The switcher's label already names the workspace.
        .accessibilityHidden(true)
      threadFilterMenu
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
            OkouWorkspaceMenuLogos.image(
              workspaceID: workspace.id, hasImage: workspace.hasImage,
              cachedImage: authentication.presentation?.image("workspace:" + workspace.id))
          }
          .tag(workspace.id)
        }
      }
      .pickerStyle(.inline)
      .labelsHidden()
    } label: {
      let workspace = authentication.workspacePresentation(workspaceID)
      OkouWorkspaceGlassLogo(
        workspaceID: workspaceID, name: workspaceName,
        imageURL: workspace?.imageURL, hasImage: workspace?.hasImage ?? false,
        cachedImage: authentication.presentation?.image("workspace:" + workspaceID),
        usesSharedImage: true, metadataKnown: workspace != nil
      )
      .accessibilityHidden(true)
    }
    .buttonStyle(.plain)
    .disabled(authentication.isSwitchingWorkspace || authentication.workspaces.isEmpty)
    .accessibilityLabel("Workspace: \(workspaceName)")
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

  private func threadSection(_ contents: ChatSidebarPresentation) -> some View {
    let pinned = contents.pinned
    let chats = contents.chats
    return Section {
      if case .hasError(let error) = projectRead {
        OkouBanner(Text(error.localizedDescription), icon: "folder", tone: .problem) {
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
      if !pinned.isEmpty {
        pinnedHeading(pinned)
        if !pinnedCollapsed {
          ForEach(pinned.rows) { row in
            threadRow(row, showsStatusColumn: pinned.showsStatusColumn)
          }
        }
        if !contents.projects.isEmpty || !chats.isEmpty {
          OkouListDivider()
            .listRowInsets(
              EdgeInsets(
                top: OkouSpace.sm, leading: rowInset, bottom: OkouSpace.sm, trailing: rowInset)
            )
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
      }
      ForEach(contents.projects) { group in
        projectRow(group)
        if store.projects.isExpanded(group.id) {
          if group.section.isEmpty {
            Text("No chats yet")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
              .listRowInsets(.horizontal, rowInset + OkouSpace.xxl)
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
          }
          ForEach(group.section.rows.prefix(store.projects.limit(for: group.id))) { row in
            threadRow(
              row, showsStatusColumn: group.section.showsStatusColumn,
              indentation: OkouSpace.xxl)
          }
          if group.section.rows.count > store.projects.limit(for: group.id) {
            Button("Show more") { store.projects.showMore(group.id) }
              .font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground)
              .listRowInsets(.horizontal, rowInset + OkouSpace.xxl)
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
          }
        }
      }
      ForEach(chats.rows) { row in
        threadRow(row, showsStatusColumn: chats.showsStatusColumn)
      }
    }
  }

  /// Pinned folds as Manus's does: the whole 44 pt heading toggles it, the chevron at its end
  /// turns with the fold, and the choice is remembered. Folded, it shows what its chats are
  /// doing — the name shimmers while one works and the unread dot sits before the chevron — so
  /// nothing finishes out of sight.
  private func pinnedHeading(_ pinned: ChatSidebarPresentation.Section) -> some View {
    Button {
      pinnedCollapsed.toggle()
    } label: {
      OkouListHeading(
        "Pinned", isExpanded: !pinnedCollapsed,
        isWorking: pinnedCollapsed && pinned.isWorking,
        summary: pinnedCollapsed && pinned.hasUnread ? .unread : .none
      )
      .frame(minHeight: OkouControl.minimumTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityValue(pinnedCollapsed ? Text("Collapsed") : Text("Expanded"))
    .accessibilityIdentifier("pinned-section")
    .listRowInsets(EdgeInsets(top: 0, leading: rowInset, bottom: 0, trailing: rowInset))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func projectRow(_ group: ChatSidebarPresentation.ProjectGroup) -> some View {
    let project = group.project
    let expanded = store.projects.isExpanded(project.id)
    let trailing: OkouChatTrailing = group.section.hasUnread ? .unread : .none
    return Button {
      withAnimation(reduceMotion ? nil : OkouMotion.disclosure) {
        store.projects.toggle(project.id)
      }
    } label: {
      HStack(spacing: OkouSpace.sm) {
        OkouIcon(expanded ? "folder-open" : "folder", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.mutedForeground)
        // Unread takes priority over working in a folded project; an open one leaves it to its chats.
        Text(verbatim: project.name).font(.okou(.body)).lineLimit(1)
          .okouShimmerText(
            !expanded && trailing != .unread && group.section.isWorking)
        Spacer(minLength: 0)
        if !expanded {
          OkouChatTrailingMark(trailing: trailing)
        }
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

  private func editor(project: ChatProject) -> ProjectEditor {
    ProjectEditor(
      dialog: OkouNameDialog.Request(
        title: String(localized: "Rename project"),
        placeholder: String(localized: "Project name"), name: project.name,
        maximumLength: 120, accessibilityIdentifier: "project-name"),
      projectID: project.id)
  }

  private func saveProjectName(_ name: String) {
    guard let request = projectEditor else { return }
    projectEditor = nil
    projectAction?.cancel()
    projectAction = Task {
      let saved = await store.projects.rename(request.projectID, name: name)
      guard !Task.isCancelled, !saved else { return }
      projectEditor = ProjectEditor(
        dialog: OkouNameDialog.Request(
          title: request.dialog.title, placeholder: request.dialog.placeholder,
          name: name, error: store.projects.actionError,
          maximumLength: 120, accessibilityIdentifier: "project-name"),
        projectID: request.projectID)
    }
  }

  private func showEditor(_ request: ProjectEditor) {
    projectAction?.cancel()
    projectEditor = request
  }

  private func threadRow(
    _ row: ChatSidebarPresentation.Row,
    showsStatusColumn: Bool = false, indentation: CGFloat = 0
  ) -> some View {
    let thread = row.thread
    return Button {
      store.selectChat(thread.id)
      close()
    } label: {
      ChatSidebarThreadLabel(row: row, workspace: store, showsStatusColumn: showsStatusColumn)
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
        .padding(.leading, OkouSpace.md + indentation)
        .padding(.trailing, OkouSpace.md)
    )
    .accessibilityIdentifier("chat-\(thread.id)")
    .accessibilityAddTraits(store.selectedThreadID == thread.id ? .isSelected : [])
    .accessibilityValue(
      thread.indicator == .active
        ? Text("Working") : thread.pinnedAt != nil ? Text("Pinned") : Text(verbatim: "")
    )
    .contextMenu {
      ChatThreadMenuContent(
        menu: ChatThreadMenu(
          workspace: store, threadID: thread.id, moveToProject: { membershipThread = $0 }))
    } preview: {
      ChatThreadPreview(thread: thread, workspace: store)
    }
    .menuOrder(.fixed)
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

  /// The chat filter, top right. On the default Chats it is a glass circle; any other filter
  /// names itself in a capsule, so a filtered list never reads as missing chats.
  private var threadFilterMenu: some View {
    ChatListFilterMenu(sidebar: sidebar, store: store, selection: threadFilter)
      .frame(height: OkouControl.minimumTarget)
      .fixedSize(horizontal: true, vertical: false)
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
          size: OkouControl.minimumTarget, name: profile?.name ?? profile?.email,
          cachedImage: authentication.presentation?.image("profile"), usesSharedImage: true)
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
    .frame(height: OkouControl.minimumTarget + OkouSpace.md)
    .padding(.horizontal, rowInset)
    .padding(.top, OkouSpace.sm)
  }
}

/// Draft observation belongs to this row, not the workspace's list projection.
private struct ChatSidebarThreadLabel: View {
  let row: ChatSidebarPresentation.Row
  let workspace: WorkspaceStore
  let showsStatusColumn: Bool

  var body: some View {
    let trailing: OkouChatTrailing =
      row.isUnread
      ? .unread
      : workspace.hasDraft(row.id) ? .draft : .none
    if showsStatusColumn {
      OkouChatRowLabel(row.title, isWorking: row.isWorking, trailing: trailing) {
        OkouChatStatusMark(emoji: row.emoji)
      }
    } else {
      OkouChatRowLabel(row.title, isWorking: row.isWorking, trailing: trailing)
    }
  }
}
