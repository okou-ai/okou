import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

struct ChatSidebarView: View {
  let store: WorkspaceStore
  let authentication: AuthenticationService
  let workspaceID: String
  let notifications: NotificationService
  let headerHeight: CGFloat
  @Binding var accountError: String?
  let close: () -> Void
  let newChat: () -> Void
  @LoadableValue private var forYouSummary: Loadable<Bool>
  @LoadableValue private var projectRead: Loadable<[ChatProject]>
  @LoadableValue private var listRead: Loadable<Void>
  @LoadableValue private var presentation: Loadable<ChatSidebarPresentation>
  /// Whether workspace search is presented, kept in the workspace session's Store.
  @ResolvedValue private var searchPresented: Bool?
  /// Project actions and disclosure, kept in the workspace session's Store.
  @ResolvedValue private var resolvedProjects: ChatProjectStore.Presentation?
  /// The confirmed chats, kept in the workspace session's Store.
  @ResolvedValue private var resolvedThreads: [ChatThread]?
  /// Whether a chat list has been published, kept in the workspace session's Store.
  @ResolvedValue private var resolvedLoaded: Bool?
  /// Chats the read-state snapshot marks unread, kept in the workspace session's Store.
  @ResolvedValue private var resolvedUnread: Set<String>?
  /// The selected chat, kept in the workspace session's Store.
  @ResolvedValue private var resolvedSelection: String??
  /// Mark-all-read and the indicators failure, kept in the workspace session's Store.
  @ResolvedValue private var resolvedListStatus: ThreadListStore.Status?
  /// Chats with a write in flight and the last chat action's failure, kept in the same Store.
  @ResolvedValue private var resolvedMutations: ThreadListMutations.Activity?
  /// The update requirement, a new chat being created and the workspace's last failure, kept in
  /// the workspace session's Store.
  @ResolvedValue private var resolvedActionStatus: WorkspaceStore.ActionStatus?

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
    _forYouSummary = LoadableValue(task: store.forYou.summary, keepLast: true)
    _projectRead = LoadableValue(task: store.projects.listValue, keepLast: true)
    _listRead = LoadableValue(task: store.list.listValue)
    _presentation = LoadableValue(store.sidebar.presentation)
    _searchPresented = ResolvedValue(store.search.presented)
    _resolvedProjects = ResolvedValue(store.projects.presentation)
    _resolvedThreads = ResolvedValue(store.list.threadsValue)
    _resolvedLoaded = ResolvedValue(store.list.hasLoadedThreadsValue)
    _resolvedUnread = ResolvedValue(store.list.unreadThreadIDsValue)
    _resolvedSelection = ResolvedValue(store.selectedThreadValue)
    _resolvedListStatus = ResolvedValue(store.list.statusValue)
    _resolvedMutations = ResolvedValue(store.list.mutationsValue)
    _resolvedActionStatus = ResolvedValue(store.actionStatusValue)
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
  @State private var deletingThreadID: String?
  @State private var showsSettings = false
  @State private var showsForYouEmptySheet = false
  /// Rows have scrolled under the top bar, so the workspace name gives way to them.
  @State private var isScrolled = false
  @Environment(\.newChatActivation) private var newChatActivation
  /// The scheme the page behind the Settings sheet resolved: the chosen one, or the system's.
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

  private var hasLoadedThreads: Bool { resolvedLoaded ?? store.list.hasLoadedThreads }

  private var listStatus: ThreadListStore.Status { resolvedListStatus ?? store.list.status }

  private var mutations: ThreadListMutations.Activity {
    resolvedMutations ?? store.list.mutations
  }

  private var actionStatus: WorkspaceStore.ActionStatus {
    resolvedActionStatus ?? store.actionStatus
  }

  private var listError: String? {
    listRead.error?.localizedDescription ?? mutations.actionError ?? listStatus.syncError
  }

  /// Animate membership changes from the same presentation the list renders, without
  /// animating title or live indicator updates.
  private var threadRowIDs: [[String]] {
    guard case .hasData(let contents) = presentation else { return [] }
    return contents.projects.map { $0.section.rows.map(\.id) } + [contents.chats.rows.map(\.id)]
  }

  var body: some View {
    List {
      if listRead.state == .loading && !hasLoadedThreads {
        OkouLoadingRow("Loading chats…", statusColumnWidth: statusColumn)
          .frame(minHeight: OkouControl.listRow)
          .listRowInsets(EdgeInsets(top: 0, leading: rowInset, bottom: 0, trailing: rowInset))
          .listRowSeparator(.hidden)
          .listRowBackground(Color.clear)
      } else if !hasLoadedThreads && listError != nil {
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
          && actionStatus.error == nil
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
    // The first snapshot establishes the list; subsequent membership changes animate.
    .transaction(value: hasLoadedThreads) { transaction in
      transaction.animation = nil
    }
    .transaction(value: threadRowIDs) { transaction in
      transaction.animation = reduceMotion ? nil : OkouMotion.transition
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
        header.padding(.horizontal, rowInset)
      }
    }
    .safeAreaBar(edge: .bottom, spacing: 0) { footer.chatFeedbackAnchor() }
    // VoiceOver's escape gesture returns to the chat.
    .accessibilityAction(.escape, close)
    .background { chatNumberShortcuts }
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
    // The list presents it, not the row: a row's dialog returns on the row that replaces it.
    .confirmationDialog(
      "Delete chat?",
      isPresented: Binding(
        get: { deletingThreadID != nil },
        set: { if !$0 { deletingThreadID = nil } }
      ), titleVisibility: .visible, presenting: deletingThreadID
    ) { id in
      Button("Delete", role: .destructive) {
        Task { await store.deleteThread(id) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      Text(
        "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. Any linked automations will be paused. This action cannot be undone."
      )
    }
    .onChange(of: newChatActivation) { _, _ in
      showsSettings = false
      showsForYouEmptySheet = false
    }
    .sheet(isPresented: $showsSettings) { settingsSheet }
    .sheet(isPresented: $showsForYouEmptySheet) { forYouEmptySheet }
    .sheet(
      isPresented: Binding(
        get: { searchPresented ?? store.search.isPresented },
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
  private var header: some View {
    ChatSidebarHeader(
      store: store, authentication: authentication, workspaceID: workspaceID,
      headerHeight: headerHeight, isScrolled: isScrolled, accountError: $accountError,
      threadFilter: threadFilter,
      hasUnreadChats: !(resolvedUnread ?? store.list.unreadThreadIDs).isEmpty
        || (resolvedThreads ?? store.list.threads).contains {
          !$0.isMuted && $0.indicator == .unread
        }, markingAllRead: listStatus.markingAllRead,
      updatingChats: !mutations.updatingThreads.isEmpty, needsUpgrade: actionStatus.needsUpgrade,
      close: close, newProject: { showEditor(creationEditor) },
      openSettings: {
        store.prepareSettings()
        showsSettings = true
      })
  }

  private var hasForYou: Bool {
    if case .hasData(true) = forYouSummary { return true }
    return false
  }

  /// Open the full For you deck when pending items exist, or a compact empty sheet otherwise.
  private func openForYou() {
    if hasForYou {
      store.sidebarInteraction.openForYou()
    } else {
      showsForYouEmptySheet = true
    }
  }

  private var settingsSheet: some View {
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

  private var forYouEmptySheet: some View {
    ForYouEmptySheet()
      .presentationDetents([.height(ForYouEmptySheet.detentHeight)])
      .presentationDragIndicator(.visible)
      .presentationCornerRadius(OkouRadius.sheet)
      .okouSheetBackground(ForYouCover.ground)
  }

  /// Projects, oldest first, then the chats outside them. Each list leads with its pins in
  /// their manual order (a pin on the row marks them); the other chats follow by activity.
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
      if let error = projectState.actionError {
        OkouBanner(
          Text(error), icon: "circle-alert", tone: .problem,
          dismiss: store.projects.dismissError
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
      }
      ForEach(contents.projects) { group in
        projectRow(group)
        if projectState.isExpanded(group.id) {
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
        contents.isInbox && chats.isEmpty && listError == nil && actionStatus.error == nil
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
      ForEach(Array(contents.chats.rows.prefix(9).enumerated()), id: \.element.id) { index, row in
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
    ChatSidebarProjectRow(
      group: group, store: store, expanded: projectState.isExpanded(group.id),
      isPending: projectState.pending.contains(group.id), needsUpgrade: actionStatus.needsUpgrade,
      isCreating: actionStatus.isCreating, rowInset: rowInset,
      statusColumn: statusColumn, close: close,
      rename: { showEditor(editor(project: group.project)) },
      delete: { deletingProject = group.project })
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
    // Opaque, as Messages' rows are, so the list's own removal animation covers a departing
    // row rather than showing its title through the row that takes its place.
    .listRowBackground(
      RoundedRectangle(cornerRadius: OkouRadius.control)
        .fill(
          selectedThreadID == thread.id
            ? OkouColor.stateSelected : .clear
        )
        .padding(.leading, OkouSpace.md + indentation)
        .padding(.trailing, OkouSpace.md)
        .background(OkouColor.sidebar)
    )
    .accessibilityIdentifier("chat-\(thread.id)")
    .accessibilityAddTraits(selectedThreadID == thread.id ? .isSelected : [])
    .contextMenu {
      ChatThreadMenuContent(
        menu: ChatThreadMenu(
          workspace: store, threadID: thread.id, moveToProject: { membershipThread = $0 },
          pinNeighbors: pinNeighbors,
          archive: { _ = await store.setArchived($0.id, archived: !$0.isArchived) }))
    } preview: {
      ChatThreadPreview(thread: thread, workspace: store)
    }
    .menuOrder(.fixed)
    // Icons only, as Messages draws them; each title stays the action's accessible name.
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if !thread.isMuted {
        readAction(thread, read: thread.isUnread).tint(OkouSwipeTint.readState)
      }
    }
    // The first trailing action is the full swipe. Where Archive takes the chat out of this
    // list, its destructive role lets the system slide the row away, as Messages' Delete does.
    // Delete only asks: a destructive role would remove the row before the user confirms.
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(
        thread.isArchived ? "Unarchive" : "Archive",
        okouSymbol: thread.isArchived ? "archive-restore" : "archive",
        role: archiveRemovesRow(thread) ? .destructive : nil
      ) {
        Task { await store.setArchived(thread.id, archived: !thread.isArchived) }
      }
      .labelStyle(.iconOnly)
      .tint(OkouSwipeTint.neutral)
      .disabled(!store.list.canUpdate(thread.id, mutations: mutations) || actionStatus.needsUpgrade)
      Button("Delete chat", okouSymbol: "trash-2") { deletingThreadID = thread.id }
        .labelStyle(.iconOnly)
        .tint(OkouSwipeTint.destructive)
        .disabled(
          !store.list.canUpdate(thread.id, mutations: mutations) || actionStatus.needsUpgrade)
    }
  }

  /// Archive takes a chat out of the inbox and Unarchive out of Archived; Unread and Muted
  /// keep the row either way.
  private func archiveRemovesRow(_ thread: ChatThread) -> Bool {
    switch store.sidebar.filter {
    case .recent: !thread.isArchived
    case .archived:
      thread.isArchived
        && !projectState.projects.contains {
          $0.id == thread.projectId && $0.isArchived
        }
    case .unread, .muted: false
    }
  }

  private func readAction(_ thread: ChatThread, read: Bool) -> some View {
    Button(
      read ? "Mark as read" : "Mark as unread",
      okouSymbol: read ? "message-square-check" : "message-square-dot"
    ) { Task { await store.setRead(thread, read: read) } }
    .labelStyle(.iconOnly)
    .disabled(mutations.updatingThreads.contains(thread.id) || listStatus.markingAllRead)
  }
  private var footer: some View {
    ChatSidebarFooter(
      store: store, hasForYou: hasForYou, openForYou: openForYou, newChat: newChat,
      rowInset: rowInset)
  }

}

extension ChatSidebarView {
  /// This render's selected chat, with the synchronous value for a first render.
  private var selectedThreadID: String? { resolvedSelection ?? store.selectedThreadID }

  /// This render's Project state, with the synchronous value for a first render.
  private var projectState: ChatProjectStore.Presentation {
    resolvedProjects ?? store.projects.currentPresentation
  }
}

private struct ChatSidebarProjectRow: View {
  let group: ChatSidebarPresentation.ProjectGroup
  let store: WorkspaceStore
  /// Disclosure and a mutation in flight, from the Project state the sidebar resolves.
  let expanded: Bool
  let isPending: Bool
  /// The update requirement and a new chat being created, from the workspace state the sidebar
  /// resolves.
  let needsUpgrade: Bool
  let isCreating: Bool
  let rowInset: CGFloat
  let statusColumn: CGFloat
  let close: () -> Void
  let rename: () -> Void
  let delete: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let project = group.project
    // An open project leaves unread and working to its chats' own marks. The folder shows one
    // badge, and unread wins.
    let unread = !expanded && group.section.hasUnread
    let working = !expanded && !unread && group.section.isWorking
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
          .modifier(OkouRunningBadge(isVisible: working))
          .frame(width: statusColumn, alignment: .leading)
        Text(verbatim: project.name).font(.okou(.body)).lineLimit(1)
        if project.isArchived {
          Text("Archived").font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        }
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
        working ? String(localized: "Working") : nil
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
      .disabled(isCreating || needsUpgrade)
      Button(project.isArchived ? "Restore project" : "Archive project", okouSymbol: "archive") {
        Task { await store.projects.setArchived(project.id, archived: !project.isArchived) }
      }
      Button("Rename", okouSymbol: "pencil", action: rename)
      Button("Delete project", okouSymbol: "trash-2", role: .destructive, action: delete)
    }
    .disabled(needsUpgrade || isPending)
  }
}

/// Draft observation belongs to this row, not the workspace's list projection.
private struct ChatSidebarThreadLabel: View {
  let row: ChatSidebarPresentation.Row
  let workspace: WorkspaceStore
  let showsStatusColumn: Bool
  /// The API's draft list and the selected chat's owner, kept in the workspace session's Store.
  @ResolvedValue private var listedDrafts: Set<String>?
  @ResolvedValue private var selected: ConversationStore??

  init(row: ChatSidebarPresentation.Row, workspace: WorkspaceStore, showsStatusColumn: Bool) {
    self.row = row
    self.workspace = workspace
    self.showsStatusColumn = showsStatusColumn
    _listedDrafts = ResolvedValue(workspace.listedDraftIDs)
    _selected = ResolvedValue(workspace.selectedConversationValue, equals: { $0 === $1 })
  }

  var body: some View {
    ChatSidebarThreadStates(
      row: row,
      composer: workspace.residentComposer(
        row.id, selected: selected ?? workspace.selectedConversation),
      listedDraft: listedDrafts?.contains(row.id) ?? workspace.hasListedDraft(row.id),
      showsStatusColumn: showsStatusColumn
    )
    .task { await workspace.activateDrafts() }
  }
}

/// A resident chat's draft mark follows its composer graph; other chats use the confirmed list.
private struct ChatSidebarThreadStates: View {
  let row: ChatSidebarPresentation.Row
  let listedDraft: Bool
  let showsStatusColumn: Bool
  private let isResident: Bool
  @ResolvedValue private var unsentContent: Bool?

  init(
    row: ChatSidebarPresentation.Row, composer: ComposerDraftStore?, listedDraft: Bool,
    showsStatusColumn: Bool
  ) {
    self.row = row
    self.listedDraft = listedDraft
    self.showsStatusColumn = showsStatusColumn
    isResident = composer != nil
    _unsentContent = ResolvedValue(composer?.unsentContent ?? ComposerDraftSignals.noContent)
  }

  var body: some View {
    var states: OkouChatStates = []
    if row.isWorking { states.insert(.working) }
    if row.isMuted { states.insert(.muted) }
    if row.isUnread { states.insert(.unread) }
    if isResident ? unsentContent == true : listedDraft { states.insert(.draft) }
    if row.isPinned { states.insert(.pinned) }
    return Group {
      if showsStatusColumn {
        OkouChatRowLabel(row.title, states: states) {
          OkouChatStatusMark(emoji: row.emoji)
        }
      } else {
        OkouChatRowLabel(row.title, states: states)
      }
    }
  }
}
