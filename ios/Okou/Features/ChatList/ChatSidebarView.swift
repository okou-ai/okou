import CCStateSwiftUI
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
  @LoadableValue private var projectRead: Loadable<[ChatProject]>
  @LoadableValue private var listRead: Loadable<Void>
  @LoadableValue private var presentation: Loadable<ChatSidebarPresentation>

  init(
    store: WorkspaceStore, authentication: AuthenticationService, workspaceID: String,
    notifications: NotificationService, headerHeight: CGFloat,
    accountError: Binding<String?>, close: @escaping () -> Void, newChat: @escaping () -> Void
  ) {
    self.store = store
    self.authentication = authentication
    self.workspaceID = workspaceID
    self.notifications = notifications
    self.headerHeight = headerHeight
    _accountError = accountError
    self.close = close
    self.newChat = newChat
    _projectRead = LoadableValue(task: store.projects.listValue, keepLast: true)
    _listRead = LoadableValue(task: store.list.listValue)
    _presentation = LoadableValue(store.sidebar.presentation)
  }

  private struct ProjectEditor {
    let dialog: OkouNameDialog.Request
    /// The Project being renamed; nil names a new one.
    let projectID: String?
  }

  @State private var projectEditor: ProjectEditor?
  @State private var membershipThread: ChatThread?
  @State private var deletingProject: ChatProject?
  @State private var projectAction: Task<Void, Never>?
  @State private var fadingThreadIDs: Set<String> = []
  @State private var showsSettings = false
  /// Rows have scrolled under the top bar, so the workspace name gives way to them.
  @State private var isScrolled = false
  @Environment(\.newChatActivation) private var newChatActivation
  /// The scheme the page behind the Settings sheet resolved: the chosen one, or the system's.
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  /// One leading edge for the header, every heading, row content and the footer buttons.
  private let rowInset = OkouControl.pageInset
  /// The chat rows' status column, which a project's folder shares so the names line up.
  @ScaledMetric(relativeTo: .body) private var statusColumn = OkouControl.statusColumn
  /// Where titles begin after the status column: a project's name, and the indent of its
  /// chats, so they sit under that name.
  private var projectIndent: CGFloat { statusColumn + OkouSpace.ten }

  private var threadFilter: Binding<ChatListFilter> {
    Binding(get: { store.sidebar.filter }, set: { store.sidebar.select($0) })
  }

  private var listError: String? {
    listRead.error?.localizedDescription ?? store.list.error
  }

  /// Animate membership changes from the same presentation the list renders, without
  /// animating title or live indicator updates.
  private var threadRowIDs: [[String]] {
    guard case .hasData(let contents) = presentation else { return [] }
    return contents.projects.map { $0.section.rows.map(\.id) } + [contents.chats.rows.map(\.id)]
  }

  var body: some View {
    List {
      if listRead.state == .loading && !store.list.hasLoadedThreads {
        OkouLoadingRow("Loading chats…")
          .frame(maxWidth: .infinity)
          .listRowInsets(.horizontal, 0)
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if !store.list.hasLoadedThreads && listError != nil {
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
        // The inbox explains itself inside the section, below its projects.
        if !presentation.isInbox && presentation.isEmpty && listError == nil
          && store.error == nil
        {
          Text(emptyMessage(presentation.filter))
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
            .listRowInsets(.horizontal, rowInset)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
        if !presentation.isInbox {
          showAllChatsRow
        }
      }
    }
    .transaction(value: threadRowIDs) { transaction in
      transaction.animation = reduceMotion ? nil : OkouMotion.transition
      // Keep removed content invisible until the native list finishes closing its space.
      let removed = fadingThreadIDs.subtracting(threadRowIDs.flatMap { $0 })
      if !removed.isEmpty {
        transaction.addAnimationCompletion(criteria: .removed) {
          fadingThreadIDs.subtract(removed)
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
    // The list starts a step below the header, so the first row's selection never touches
    // the glass buttons.
    .safeAreaBar(edge: .top, spacing: OkouSpace.md) {
      VStack(spacing: 0) {
        // Sync problems float with the rest of the chat feedback, outside the sliding sidebar.
        header.padding(.horizontal, rowInset)
      }
    }
    .safeAreaBar(edge: .bottom, spacing: 0) { footer }
    // VoiceOver's escape gesture returns to the chat.
    .accessibilityAction(.escape, close)
    .background { chatNumberShortcuts }
    .background(OkouColor.sidebar)
    .task { await store.projects.activate() }
    .task { await store.activateDrafts() }
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
    .onChange(of: store.sidebar.filter) { _, _ in fadingThreadIDs.removeAll() }
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
  /// beside it with no arrow, and on the right the chat filter and the way back to the chat in
  /// one glass group. The name leaves once rows scroll under the bar; the glass buttons stay.
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
      headerActions
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

  /// Projects first, oldest first, then the chats outside them. Each list leads with its pins
  /// in their manual order (a pin on the row marks them); the other chats follow by activity.
  private func threadSection(_ contents: ChatSidebarPresentation) -> some View {
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
      ForEach(contents.projects) { group in
        projectRow(group)
        if store.projects.isExpanded(group.id) {
          if group.section.isEmpty {
            Text("No chats yet")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
              .listRowInsets(.horizontal, rowInset + projectIndent)
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
            // An empty project still leads to the archived chats it holds.
            if group.hasHiddenArchivedChats {
              filterRow("Show archived chats", filter: .archived, indentation: projectIndent)
            }
          }
          // A project lists every chat it holds.
          ForEach(group.section.rows) { row in
            threadRow(
              row, showsStatusColumn: group.section.showsStatusColumn,
              indentation: projectIndent, pinNeighbors: contents.pinNeighbors(of: row.id))
          }
        }
      }
      let inboxEmpty =
        contents.isInbox && chats.isEmpty && listError == nil && store.error == nil
      if !contents.projects.isEmpty && (!chats.isEmpty || inboxEmpty) {
        // A hairline closes the projects, so their chats never run into the list below.
        OkouListDivider()
          .listRowInsets(
            EdgeInsets(
              top: OkouSpace.sm, leading: rowInset, bottom: OkouSpace.sm, trailing: rowInset)
          )
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      }
      ForEach(chats.rows) { row in
        // Beside folders the status column always shows, so titles share the names' edge.
        threadRow(
          row, showsStatusColumn: chats.showsStatusColumn || !contents.projects.isEmpty,
          pinNeighbors: contents.pinNeighbors(of: row.id))
      }
      // The inbox explains an empty list below any projects: its archived chats are one
      // filter away, and without any it waits for the first chat.
      if inboxEmpty {
        Text(
          contents.hasHiddenArchivedChats ? "Your inbox is empty" : "Your chats will appear here."
        )
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
        .listRowInsets(.horizontal, rowInset)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        if contents.hasHiddenArchivedChats {
          filterRow("Show archived chats", filter: .archived)
        }
      }
    }
  }

  private func emptyMessage(_ filter: ChatListFilter) -> LocalizedStringKey {
    switch filter {
    case .recent: "Your chats will appear here."
    case .unread: "No unread chats"
    case .archived: "No archived chats"
    case .muted: "No muted chats"
    }
  }

  /// Unread, Archived and Muted end with the way back to every chat, as the web's lists do.
  private var showAllChatsRow: some View {
    filterRow("Show all chats", filter: .recent)
  }

  /// A quiet row that switches the list's filter.
  private func filterRow(
    _ title: LocalizedStringKey, filter: ChatListFilter, indentation: CGFloat = 0
  ) -> some View {
    Button {
      store.sidebar.select(filter)
    } label: {
      Text(title)
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(maxWidth: .infinity, minHeight: OkouControl.minimumTarget, alignment: .leading)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier(filter == .recent ? "show-all-chats" : "show-archived-chats")
    .listRowInsets(.horizontal, rowInset + indentation)
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  /// With a hardware keyboard, ⌘1–⌘9 open the first nine chats outside Projects, as the web's
  /// number shortcuts do; chats inside Projects have none. The sidebar stays mounted behind
  /// the chat, so the shortcuts work whether or not it is open.
  @ViewBuilder private var chatNumberShortcuts: some View {
    if case .hasData(let contents) = presentation {
      ForEach(Array(contents.chats.rows.prefix(9).enumerated()), id: \.element.id) {
        index, row in
        Button(row.title) {
          store.selectChat(row.id)
          close()
        }
        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
      }
      .frame(width: 0, height: 0)
      .opacity(0)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
    }
  }

  private func projectRow(_ group: ChatSidebarPresentation.ProjectGroup) -> some View {
    let project = group.project
    let expanded = store.projects.isExpanded(project.id)
    // An open project leaves unread to its chats' own dots.
    let unread = !expanded && group.section.hasUnread
    return Button {
      withAnimation(reduceMotion ? nil : OkouMotion.disclosure) {
        store.projects.toggle(project.id)
      }
    } label: {
      // The chat rows' geometry: the folder in the status column, so the name starts on the
      // chat titles' edge.
      HStack(spacing: OkouSpace.ten) {
        // A folded project badges its folder, as the menu button does for the whole list: the
        // trailing column keeps the chevron, in line with the chats' own dots.
        OkouIcon(expanded ? "folder-open" : "folder", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.mutedForeground)
          .modifier(OkouUnreadBadge(isVisible: unread))
          .frame(width: statusColumn, alignment: .leading)
        // Unread takes priority over working in a folded project.
        Text(verbatim: project.name).font(.okou(.body)).lineLimit(1)
          .okouShimmerText(!expanded && !unread && group.section.isWorking)
        Spacer(minLength: 0)
        // The fold's own mark ends the row in the trailing column, turning from down (open)
        // to right (folded) with the disclosure.
        OkouIcon("chevron-down", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.quietMark)
          .rotationEffect(.degrees(expanded ? 0 : -90))
          .accessibilityHidden(true)
      }
      .frame(minHeight: OkouControl.listRow)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("project-\(project.id)")
    // The badge is drawn only, so the value names it, as the menu button's does.
    .accessibilityValue(
      [
        expanded ? String(localized: "Expanded") : String(localized: "Collapsed"),
        unread ? String(localized: "Unread") : nil,
      ].compactMap { $0 }.joined(separator: ", ")
    )
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

  /// A new Project joins the end of the Projects, unfolded, as the web's Create Project does.
  private var creationEditor: ProjectEditor {
    ProjectEditor(
      dialog: OkouNameDialog.Request(
        title: String(localized: "New project"),
        placeholder: String(localized: "Project name"), name: "",
        maximumLength: 120, accessibilityIdentifier: "project-name"),
      projectID: nil)
  }

  private func saveProjectName(_ name: String) {
    guard let request = projectEditor else { return }
    projectEditor = nil
    projectAction?.cancel()
    projectAction = Task {
      let saved =
        if let projectID = request.projectID {
          await store.projects.rename(projectID, name: name)
        } else {
          await store.projects.create(name: name) != nil
        }
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
    showsStatusColumn: Bool = false, indentation: CGFloat = 0,
    pinNeighbors: ChatSidebarPresentation.PinNeighbors? = nil
  ) -> some View {
    let thread = row.thread
    let isFading = fadingThreadIDs.contains(thread.id)
    return Button {
      store.selectChat(thread.id)
      close()
    } label: {
      ChatSidebarThreadLabel(row: row, workspace: store, showsStatusColumn: showsStatusColumn)
    }
    .buttonStyle(.plain)
    .opacity(isFading ? 0 : 1)
    .allowsHitTesting(!isFading)
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
        .opacity(isFading ? 0 : 1)
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
          workspace: store, threadID: thread.id, moveToProject: { membershipThread = $0 },
          pinNeighbors: pinNeighbors, archive: { archiveThread($0.id, leaveDetail: true) }))
    } preview: {
      ChatThreadPreview(thread: thread, workspace: store)
    }
    .menuOrder(.fixed)
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if !thread.isMuted {
        readAction(thread, read: thread.isUnread).tint(OkouSwipeTint.readState)
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button {
        archiveThread(thread.id)
      } label: {
        Label(thread.isArchived ? "Unarchive" : "Archive", okouSymbol: "archive")
      }
      .tint(OkouSwipeTint.neutral)
      .disabled(isFading || !store.list.canUpdate(thread.id) || store.needsUpgrade)
    }

  }

  private func archiveThread(_ id: String, leaveDetail: Bool = false) {
    guard !store.needsUpgrade, store.list.canUpdate(id), !fadingThreadIDs.contains(id),
      let thread = store.list.threads.first(where: { $0.id == id })
    else { return }
    let archived = !thread.isArchived
    let removesRow =
      (store.sidebar.filter == .recent && archived)
      || (store.sidebar.filter == .archived && !archived)
    let commit: () -> Void = {
      Task {
        await store.setArchived(id, archived: archived, leaveDetail: leaveDetail)
        guard !Task.isCancelled else { return }
        // A rejected action leaves the row in place; restore its content without collapsing it.
        if store.list.threads.first(where: { $0.id == id })?.isArchived != archived {
          withAnimation(reduceMotion ? nil : OkouMotion.press) {
            fadingThreadIDs.subtract([id])
          }
        }
      }
    }
    guard removesRow, !reduceMotion else {
      commit()
      return
    }
    // A List can close a swiped row's gap while its old label is still visible. Finish the
    // opacity animation before publishing the removal, rather than racing those animations.
    withAnimation(OkouMotion.press, completionCriteria: .removed) {
      fadingThreadIDs.formUnion([id])
    } completion: {
      commit()
    }
  }

  /// Top right, one glass capsule as iOS groups related bar buttons: the chat list menu on the
  /// left (the filters, Mark all as read and New project) and the way back to the chat on the
  /// right, toward the page it returns to. On the default Chats the menu is an icon; any other
  /// filter names itself, so a filtered list never reads as missing chats.
  private var headerActions: some View {
    HStack(spacing: 0) {
      ChatListFilterMenu(
        store: store, selection: threadFilter,
        newProject: { showEditor(creationEditor) }
      )
      .frame(height: OkouControl.minimumTarget)
      .fixedSize(horizontal: true, vertical: false)
      Button(action: close) {
        OkouToolbarIcon("arrow-right")
          .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close sidebar")
      .accessibilityIdentifier("close-sidebar")
    }
    .modifier(OkouGlassControl(shape: .capsule))
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
        store.prepareSettings()
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
      if row.isUnread {
        .unread
      } else if workspace.hasDraft(row.id) {
        .draft
      } else if row.isPinned {
        .pinned
      } else {
        .none
      }
    if showsStatusColumn {
      OkouChatRowLabel(row.title, isWorking: row.isWorking, trailing: trailing) {
        OkouChatStatusMark(emoji: row.emoji)
      }
    } else {
      OkouChatRowLabel(row.title, isWorking: row.isWorking, trailing: trailing)
    }
  }
}
