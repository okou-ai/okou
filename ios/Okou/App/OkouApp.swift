import ChatData
import Foundation
import SwiftUI

@main
struct OkouApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var delegate
  @State private var authentication: AuthenticationService?
  private let configuration = Result { try AppConfiguration() }

  init() {
    // The XCTest host runs real services with isolated HTTP fixtures, never production auth.
    let isTestHost = NSClassFromString("XCTestCase") != nil
    let authentication = isTestHost ? nil : AuthenticationService()
    _authentication = State(initialValue: authentication)
    if let authentication, case .success(let configuration) = configuration {
      delegate.notifications.configure(authentication: authentication, configuration: configuration)
    }
  }

  var body: some Scene {
    WindowGroup {
      Group {
        if let authentication {
          switch configuration {
          case .success(let configuration):
            AppRootView(
              authentication: authentication, configuration: configuration,
              notifications: delegate.notifications)
          case .failure(let error):
            ContentUnavailableView(
              "Unable to start Okou", systemImage: "exclamationmark.triangle",
              description: Text(error.localizedDescription))
          }
        } else {
          Color.clear
        }
      }
      .modifier(OkouAppearance())
      .task { await authentication?.start() }
      .onOpenURL { url in Task { await authentication?.handleURL(url) } }
    }
  }
}

struct AppRootView: View {
  let authentication: AuthenticationService
  let configuration: AppConfiguration
  let session: URLSession
  let notifications: NotificationService
  @State private var workspaceData: NotificationWorkspace?
  @State private var presentedScopeID: String?
  @State private var accountError: String?
  @State private var foregroundRefresh: Task<Void, Never>?
  @Environment(\.scenePhase) private var scenePhase

  init(
    authentication: AuthenticationService, configuration: AppConfiguration,
    session: URLSession = .shared, notifications: NotificationService
  ) {
    self.authentication = authentication
    self.configuration = configuration
    self.session = session
    self.notifications = notifications
  }

  var body: some View {
    AppStartupContainer(isLoading: authentication.isLoading || authentication.isSwitchingWorkspace)
    {
      if let scopeID = authentication.scopeID,
        let workspaceID = authentication.activeWorkspaceID,
        let userID = authentication.userID
      {
        if let workspaceData, workspaceData.scopeID == scopeID,
          scenePhase == .active || presentedScopeID == scopeID
        {
          WorkspaceRootView(
            authentication: authentication, configuration: configuration,
            workspaceID: workspaceID, userID: userID, scopeID: scopeID,
            accountError: $accountError, data: workspaceData, notifications: notifications
          )
          .id(scopeID)
        } else {
          ProgressView()
        }
      } else {
        SignInView(authentication: authentication, webURL: configuration.webURL)
      }
    }
    .task(id: authentication.scopeID) {
      let data = notifications.data(
        authentication: authentication, configuration: configuration, session: session)
      workspaceData = data
      if scenePhase == .active { presentedScopeID = data?.scopeID }
      await notifications.update(workspace: data)
      if !authentication.isLoading {
        await notifications.refreshNotificationState(userID: authentication.userID)
      }
      if scenePhase == .active { await notifications.flushPrefetchReports() }
    }
    .task(
      id: NotificationNavigationIdentity(
        userID: authentication.userID, isLoading: authentication.isLoading,
        destination: notifications.pendingDestination)
    ) {
      notifications.preparePending(authentication: authentication)
      if !authentication.isLoading {
        await notifications.refreshNotificationState(userID: authentication.userID)
      }
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      notifications.setForeground(phase == .active)
      if phase == .active { presentedScopeID = authentication.scopeID }
      foregroundRefresh?.cancel()
      foregroundRefresh =
        phase == .active
        ? Task {
          await authentication.refresh()
          await notifications.refreshRegistration()
          if !authentication.isLoading {
            await notifications.refreshNotificationState(userID: authentication.userID)
          }
          await notifications.flushPrefetchReports()
        } : nil
    }
    .onDisappear { foregroundRefresh?.cancel() }
    .onChange(of: notifications.error) { _, error in accountError = error }
    .alert(
      "Unable to update account",
      isPresented: Binding(
        get: { accountError != nil }, set: { if !$0 { accountError = nil } }
      )
    ) {
      Button("OK") { accountError = nil }
    } message: {
      Text(accountError ?? "")
    }
  }
}

private struct WorkspaceRootView: View {
  let authentication: AuthenticationService
  let workspaceID: String
  let userID: String
  let notifications: NotificationService
  @State private var store: WorkspaceStore
  @State private var sidebar = SidebarInteraction()
  @State private var topContentHeight: CGFloat = 0
  @Binding private var accountError: String?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let headerHeight: CGFloat = 44

  init(
    authentication: AuthenticationService, configuration: AppConfiguration,
    workspaceID: String, userID: String, scopeID: String,
    accountError: Binding<String?>, data: NotificationWorkspace, notifications: NotificationService
  ) {
    self.authentication = authentication
    self.workspaceID = workspaceID
    self.userID = userID
    _accountError = accountError
    self.notifications = notifications
    _store = State(
      initialValue: WorkspaceStore(
        client: data.client, webURL: configuration.webURL, sharedSync: data.sync,
        draftStorage: ChatDraftStorage(
          scope: ChatCacheScope(
            apiBaseURL: configuration.apiURL, userID: userID, workspaceID: workspaceID)),
        didRefreshReadState: { notifications.requestNotificationStateRefresh() }))
  }

  var body: some View {
    GeometryReader { geometry in
      let sidebarWidth = min(300, geometry.size.width - 56)
      let topInset = geometry.safeAreaInsets.top
      let screenHeight = geometry.size.height + topInset + geometry.safeAreaInsets.bottom
      let sidebarOffset = min(
        max((sidebar.isOpen ? sidebarWidth : 0) + (sidebar.translation ?? 0), 0), sidebarWidth)
      let sidebarProgress = sidebarOffset / sidebarWidth
      let panelCornerRadius = 30 * sidebarProgress
      ZStack(alignment: .leading) {
        Color(uiColor: .systemBackground).ignoresSafeArea()

        ChatSidebarView(
          store: store, authentication: authentication, workspaceID: workspaceID,
          notifications: notifications,
          headerHeight: headerHeight,
          accountError: $accountError,
          close: closeSidebar,
          newChat: startNewChat
        )
        .frame(width: sidebarWidth, height: geometry.size.height)
        .allowsHitTesting(sidebar.isOpen)
        .accessibilityHidden(!sidebar.isOpen)

        Group {
          if let conversation = store.selectedConversation {
            ChatDetailView(
              conversation: conversation, topContentInset: topContentHeight, sidebar: sidebar,
              mentionSource: ComposerMentionSource(
                agentID: conversation.thread.agentID, agents: store.list.agents,
                threads: store.list.threads)
            )
            .id(conversation.thread.id)
          } else {
            newChatHome
              .safeAreaBar(edge: .bottom, spacing: 0) {
                @Bindable var composer = store.newComposer
                ChatComposerView(
                  draft: $composer.text, isBusy: store.isCreating,
                  showsProgress: store.isCreating, canStop: false,
                  needsUpgrade: store.needsUpgrade,
                  error: store.error ?? store.list.actionError, attachmentURL: store.webURL,
                  attachments: composer.attachments,
                  draftState: composer,
                  submit: { await store.sendNewChat() }, refresh: nil,
                  modelSelection: store.newModelSelection,
                  connectorSelection: store.newModelSelection.connectors,
                  mentionSource: ComposerMentionSource(
                    agentID: store.selectedAgentID, agents: store.list.agents,
                    threads: store.list.threads),
                  workflowSource: store.composerWorkflows, agentID: store.selectedAgentID)
              }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaBar(edge: .top, spacing: 0) {
          VStack(spacing: 0) {
            ChatWorkspaceHeader(store: store, height: headerHeight, openSidebar: openSidebar)
            if let error = store.list.syncError {
              ChatSyncFailureView(message: error, isRefreshing: store.list.isLoading) {
                await store.refresh()
              }
            }
          }
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: {
            topContentHeight = $0
          }
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        .accessibilityHidden(sidebar.isOpen)
        .background(alignment: .top) {
          RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous)
            .fill(Color(uiColor: .systemBackground))
            .frame(width: geometry.size.width, height: screenHeight)
            .offset(y: -topInset)
        }
        .overlay(alignment: .top) {
          Button(action: closeSidebar) {
            Color(uiColor: .secondarySystemBackground)
              .frame(width: geometry.size.width, height: screenHeight)
              .clipShape(RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous))
              .opacity(0.82 * sidebarProgress)
              .offset(y: -topInset)
          }
          .buttonStyle(.plain)
          .allowsHitTesting(sidebar.isOpen)
          .accessibilityLabel("Close sidebar")
          .accessibilityIdentifier("close-sidebar")
          .accessibilityHidden(!sidebar.isOpen)
        }
        .mask(alignment: .top) {
          RoundedRectangle(cornerRadius: panelCornerRadius, style: .continuous)
            .frame(width: geometry.size.width, height: screenHeight)
            .offset(y: -topInset)
        }
        .compositingGroup()
        .shadow(color: .black.opacity(0.3 * sidebarProgress), radius: 18, x: -5)
        .offset(x: sidebarOffset)
      }
      .frame(width: geometry.size.width, height: geometry.size.height, alignment: .leading)
      .gesture(
        SidebarPanGesture(
          interaction: sidebar, sidebarWidth: sidebarWidth,
          changed: { translation in
            if sidebar.translation == nil {
              UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
            sidebar.dragChanged(translation)
          },
          ended: { translation, velocity, cancelled in
            let wasOpen = sidebar.isOpen
            withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
              sidebar.endDrag(
                translation: translation, velocity: velocity, cancelled: cancelled,
                sidebarWidth: sidebarWidth)
            }
            if sidebar.isOpen && !wasOpen { Task { await store.refreshNavigation() } }
          })
      )
    }
    .modifier(ChatLinkNavigation(store: store, didOpen: closeSidebar))
    .background { ChatThreadRenameDialog(list: store.list).frame(width: 0, height: 0) }
    .overlay(alignment: .bottom) {
      if let feedback = store.threadFeedback {
        ChatThreadFeedbackView(store: store, feedback: feedback)
          .padding(.bottom, 100)
      }
    }
    .task {
      let target = store
      notifications.didSynchronize = { [weak target] in
        target?.requestRefresh(.history(threadID: $0))
      }
      store.setForeground(scenePhase == .active)
      await store.start(userID: userID, workspaceID: workspaceID)
      await openPendingNotification()
    }
    .task(id: notifications.pendingDestination) {
      await openPendingNotification()
    }
    .onDisappear {
      sidebar.cancelDrag()
      store.close()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)
    ) { _ in
      Task { await store.reduceMemory() }
    }
    .onChange(of: scenePhase) { _, phase in
      store.setForeground(phase == .active)
      if phase == .active { store.requestRefresh() }
    }
    .alert(
      "Unable to update chats",
      isPresented: Binding(
        get: {
          store.selectedConversation != nil && store.list.actionError != nil
            && store.list.renameRequest == nil && !store.list.isSavingRename
        },
        set: { if !$0 { store.list.dismissError() } }
      )
    ) {
      Button("OK") { store.list.dismissError() }
    } message: {
      Text(store.list.actionError ?? "")
    }
    .fullScreenCover(isPresented: Binding(get: { store.needsUpgrade }, set: { _ in })) {
      ContentUnavailableView {
        Label("Update required", systemImage: "arrow.down.app")
      } description: {
        Text(
          "This build no longer supports the current API. Install the latest Okou build to continue."
        )
      } actions: {
        Link("Open TestFlight", destination: URL(string: "itms-beta://")!)
      }
      .interactiveDismissDisabled()
    }
  }

  private var newChatHome: some View {
    VStack {
      Spacer(minLength: 24)
      HStack(spacing: 16) {
        if let agent = store.list.agents.first(where: { $0.agentId == store.selectedAgentID }),
          !agent.isDefaultAgent
        {
          Text(String((agent.displayName ?? "A").prefix(1)))
            .font(.system(size: 28, weight: .medium))
            .frame(width: 56, height: 56)
            .background(
              Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        } else {
          Image("AssistantAvatar")
            .resizable()
            .scaledToFit()
            .frame(width: 56, height: 56)
            .background(
              Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        }
        Text(greetingText)
          .font(.system(size: 24, weight: .semibold))
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 24)
      .accessibilityElement(children: .combine)
      Spacer(minLength: 24)
    }
  }

  private var greetingText: String {
    let name = authentication.firstName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let name, !name.isEmpty {
      return "What are we working on, \(name)?"
    }
    return "What are we working on?"
  }

  private func openPendingNotification() async {
    if await notifications.openPending(authentication: authentication, store: store) {
      closeSidebar()
    }
  }

  private func openSidebar() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
      sidebar.setOpen(true)
    }
    Task { await store.refreshNavigation() }
  }

  private func closeSidebar() {
    withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.88)) {
      sidebar.setOpen(false)
    }
  }

  private func startNewChat(_ agentID: String? = nil) {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    store.startNewChat(agentID: agentID)
    closeSidebar()
  }
}

private struct NotificationNavigationIdentity: Hashable {
  let userID: String?
  let isLoading: Bool
  let destination: NotificationDestination?
}
