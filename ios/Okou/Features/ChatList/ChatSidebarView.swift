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

  /// The web's chat filters: Inbox, Unread, Archived, Muted.
  private enum ThreadFilter {
    case recent, unread, archived, muted
  }

  private func filterTitle(_ filter: ThreadFilter) -> LocalizedStringKey {
    switch filter {
    case .recent: "Inbox"
    case .unread: "Unread"
    case .archived: "Archived"
    case .muted: "Muted"
    }
  }

  @State private var showArchived = false
  @State private var showMuted = false
  @State private var showsSettings = false
  /// Rows have scrolled under the top bar, so the workspace name gives way to them.
  @State private var isScrolled = false
  @Environment(\.newChatActivation) private var newChatActivation
  /// The scheme the page behind the Settings sheet resolved: the chosen one, or the system's.
  @Environment(\.colorScheme) private var colorScheme

  private var workspaceName: String {
    authentication.workspacePresentation(workspaceID)?.name ?? "Workspace"
  }

  @Namespace private var searchTransition
  /// One leading edge for the header, every heading, row content and the footer buttons.
  private let rowInset = OkouControl.pageInset

  /// A section shows a status column only when one of its own chats has a status emoji;
  /// a section without any keeps its titles flush.
  private func usesStatusColumn(_ threads: [ChatThread]) -> Bool {
    threads.contains { $0.titleParts.emoji != nil }
  }

  private var visibleThreads: [ChatThread] {
    if showMuted {
      return store.list.threads.filter { $0.agentID == store.selectedAgentID && $0.isMuted }
    }
    return store.list.threads(agentID: store.selectedAgentID, archived: showArchived)
  }

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
        if visibleThreads.isEmpty && store.list.error == nil && store.error == nil {
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
        .redacted(
          reason: authentication.workspacePresentation(workspaceID) == nil ? .placeholder : [])
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

  private var threadSection: some View {
    let showsStatusColumn = usesStatusColumn(visibleThreads)
    return Section {
      threadMenu
      if threadFilter.wrappedValue == .recent {
        ForEach(recentGroups) { group in
          groupHeading(group.title)
          ForEach(Array(group.threads.enumerated()), id: \.element.id) { index, thread in
            threadRow(
              thread, waveIndex: index, showsStatusColumn: showsStatusColumn)
          }
        }
      } else {
        ForEach(visibleThreads) { thread in
          threadRow(thread, showsStatusColumn: showsStatusColumn)
        }
      }
    }
  }

  private struct ThreadGroup: Identifiable {
    let id: String
    let title: LocalizedStringKey
    let threads: [ChatThread]
  }

  /// Pinned chats first, then by last activity, so the list reads like a timeline.
  private var recentGroups: [ThreadGroup] {
    let calendar = Calendar.current
    let weekAgo = calendar.date(byAdding: .day, value: -7, to: .now) ?? .now
    var pinned: [ChatThread] = []
    var today: [ChatThread] = []
    var yesterday: [ChatThread] = []
    var week: [ChatThread] = []
    var earlier: [ChatThread] = []
    for thread in visibleThreads {
      if thread.pinnedAt != nil {
        pinned.append(thread)
      } else if calendar.isDateInToday(thread.sortAt) {
        today.append(thread)
      } else if calendar.isDateInYesterday(thread.sortAt) {
        yesterday.append(thread)
      } else if thread.sortAt >= weekAgo {
        week.append(thread)
      } else {
        earlier.append(thread)
      }
    }
    let groups = [
      ThreadGroup(id: "pinned", title: "Pinned", threads: pinned),
      ThreadGroup(id: "today", title: "Today", threads: today),
      ThreadGroup(id: "yesterday", title: "Yesterday", threads: yesterday),
      ThreadGroup(id: "week", title: "Previous 7 days", threads: week),
      ThreadGroup(id: "earlier", title: "Earlier", threads: earlier),
    ]
    return groups.filter { !$0.threads.isEmpty }
  }

  private func groupHeading(_ title: LocalizedStringKey) -> some View {
    Text(title)
      .font(.okou(.footnote).weight(.medium))
      .foregroundStyle(OkouColor.mutedForeground)
      .lineLimit(1)
      .accessibilityAddTraits(.isHeader)
      .listRowInsets(EdgeInsets(top: 12, leading: rowInset, bottom: 4, trailing: rowInset))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
  }

  private func threadRow(
    _ thread: ChatThread, waveIndex: Int = 0,
    showsStatusColumn: Bool = false
  ) -> some View {
    Button {
      store.selectChat(thread.id)
      close()
    } label: {
      let parts = thread.titleParts
      let trailing = chatTrailing(thread, waveIndex: waveIndex)
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
    .listRowInsets(EdgeInsets(top: 0, leading: rowInset, bottom: 0, trailing: rowInset))
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
      if !thread.isMuted {
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
    // "Inbox ⌄" on the left instead of from the middle of a full-width row.
    .frame(maxWidth: .infinity, alignment: .leading)
    .listRowInsets(EdgeInsets(top: 2, leading: rowInset, bottom: 0, trailing: rowInset))
    .listRowSeparator(.hidden)
    .listRowBackground(Color.clear)
  }

  private func chatTrailing(_ thread: ChatThread, waveIndex: Int) -> OkouChatTrailing {
    if thread.indicator == .active {
      return .running(phase: Double(waveIndex) / OkouMotion.runningWaveRows)
    }
    if thread.indicator == .unread { return .unread }
    if thread.pinnedAt != nil && threadFilter.wrappedValue != .recent { return .pinned }
    return .none
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
          size: OkouControl.minimumTarget,
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
