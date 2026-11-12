import CCStateSwiftUI
import ChatData
import Foundation
import SwiftUI

@main
struct OkouApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var delegate
  @State private var authentication: AuthenticationService?
  @State private var lifecycle: AppLifecycle?
  private let configuration = Result { try AppConfiguration() }

  private static var isDesignPreview: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("--mobile-design-system") || isResultStyles
        || isChatSyncStatus || isComputerAuthorizationPreview
    #else
      false
    #endif
  }

  /// The page of every result style in a chat (`ResultStylesGallery`), without signing in.
  private static var isResultStyles: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("--result-styles")
    #else
      false
    #endif
  }

  private static var isChatSyncStatus: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("--chat-sync-status")
    #else
      false
    #endif
  }

  private static var isComputerAuthorizationPreview: Bool {
    #if DEBUG
      ProcessInfo.processInfo.arguments.contains("--computer-access-cards")
    #else
      false
    #endif
  }

  init() {
    #if DEBUG || STAGING
      if case .success(let configuration) = configuration {
        StagingPreviewAccess.configure(
          apiURL: configuration.apiURL,
          bypass: ProcessInfo.processInfo.environment["OKOU_PREVIEW_API_BYPASS"])
      }
    #endif
    if !Self.isDesignPreview { CrashReporting.start() }
    OkouNavigationBar.applyBackIndicator()
    OkouNavigationBar.applySearchField()
    // The XCTest host runs real services with isolated HTTP fixtures, never production auth.
    let isTestHost = NSClassFromString("XCTestCase") != nil
    let authentication = isTestHost || Self.isDesignPreview ? nil : AuthenticationService()
    _authentication = State(initialValue: authentication)
    if let authentication, case .success(let configuration) = configuration {
      delegate.notifications.configure(authentication: authentication, configuration: configuration)
      _lifecycle = State(
        initialValue: AppLifecycle(
          authentication: authentication, configuration: configuration,
          notifications: delegate.notifications))
    }
  }

  var body: some Scene {
    WindowGroup {
      Group {
        #if DEBUG
          if Self.isComputerAuthorizationPreview {
            NavigationStack { ComputerAuthorizationGallery() }
          } else if Self.isChatSyncStatus {
            NavigationStack { ChatSyncStatusGallery() }
          } else if Self.isResultStyles {
            NavigationStack { ResultStylesPage() }
          } else if Self.isDesignPreview {
            NavigationStack { OkouDesignSystemCatalog() }
          } else {
            productRoot
          }
        #else
          productRoot
        #endif
      }
      .modifier(OkouAppearance())
      .task {
        if let lifecycle {
          await lifecycle.run()
        } else {
          await authentication?.start()
        }
      }
      .onOpenURL { url in Task { await authentication?.handleURL(url) } }
    }
  }

  private var productRoot: some View {
    Group {
      if authentication != nil {
        switch configuration {
        case .success:
          if let lifecycle { AppRootView(lifecycle: lifecycle) }
        case .failure(let error):
          OkouEmptyState(
            "Unable to start Okou", icon: "triangle-alert",
            description: Text(error.localizedDescription))
        }
      } else {
        Color.clear
      }
    }
  }
}

struct AppRootView: View {
  let lifecycle: AppLifecycle
  @State private var accountError: String?
  @Environment(\.scenePhase) private var scenePhase

  private var authentication: AuthenticationService { lifecycle.authentication }
  private var configuration: AppConfiguration { lifecycle.configuration }
  private var notifications: NotificationService { lifecycle.notifications }

  var body: some View {
    Group {
      if let scopeID = authentication.presentationScopeID,
        let workspaceID = authentication.presentationWorkspaceID,
        let userID = authentication.userID
      {
        if let workspace = lifecycle.workspace, workspace.data.scopeID == scopeID,
          scenePhase != .background || lifecycle.presentedScopeID == scopeID
        {
          WorkspaceRootView(
            authentication: authentication,
            workspaceID: workspaceID, userID: userID,
            accountError: $accountError, lifecycle: workspace, notifications: notifications
          )
          .id(scopeID)
        } else {
          OkouColor.background.ignoresSafeArea()
        }
      } else {
        SignInView(authentication: authentication, webURL: configuration.webURL)
      }
    }
    .task(id: authentication.presentationScopeID) { await lifecycle.updateScope() }
    .task(id: lifecycle.notificationIdentity) { await lifecycle.updateNotificationDemand() }
    .onChange(of: scenePhase, initial: true) { _, phase in lifecycle.setPhase(phase) }
    .onReceive(
      NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)
    ) { _ in
      Task { await lifecycle.reduceMemory() }
    }
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
  let lifecycle: WorkspaceLifecycle
  private var store: WorkspaceStore { lifecycle.store }
  @State private var sidebar = SidebarInteraction()
  @State private var topContentHeight: CGFloat = 0
  @State private var taglineIndex = Int.random(in: 0..<64)
  @Binding private var accountError: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let headerHeight: CGFloat = 44

  init(
    authentication: AuthenticationService,
    workspaceID: String, userID: String,
    accountError: Binding<String?>, lifecycle: WorkspaceLifecycle,
    notifications: NotificationService
  ) {
    self.authentication = authentication
    self.workspaceID = workspaceID
    self.userID = userID
    _accountError = accountError
    self.notifications = notifications
    self.lifecycle = lifecycle
  }

  var body: some View {
    WorkspaceNavigation(sidebar: sidebar) {
      // Identity restoration gates the sidebar, never the new-chat screen.
      Group {
        if authentication.presentation?.userID == userID,
          authentication.presentation?.preparedWorkspaceID == workspaceID
        {
          StoreProvider(store.projects.stateStore) {
            ChatSidebarView(
              store: store, authentication: authentication, workspaceID: workspaceID,
              notifications: notifications,
              headerHeight: headerHeight,
              accountError: $accountError,
              close: closeSidebar,
              newChat: startNewChat
            )
            .id(ObjectIdentifier(store))
          }
        }
      }
    } chat: {
      chatPage
    }
    .ignoresSafeArea()
    .sensoryFeedback(.selection, trigger: sidebar.isOpen)
    .onChange(of: sidebar.isOpen) { _, isOpen in
      if isOpen { Task { await store.refreshNavigation() } }
    }
    .overlay(alignment: .top) {
      ChatFeedbackBanner(store: store)
        .padding(.top, headerHeight)
    }
    .modifier(ChatLinkNavigation(store: store, didOpen: closeSidebar))
    .background { ChatThreadRenameDialog(list: store.list).frame(width: 0, height: 0) }
    .task {
      await lifecycle.start()
      if !Task.isCancelled { await openPendingNotification() }
    }
    .task(id: notifications.pendingDestination) {
      await openPendingNotification()
    }
    .modifier(
      NewChatNavigation(
        workspace: store, isAuthenticated: !authentication.isLoading,
        didOpen: closeSidebar)
    )
    .alert(
      "Unable to update chats",
      isPresented: Binding(
        get: {
          store.list.actionError != nil
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
      OkouEmptyState(
        "Update required", icon: "download",
        description: Text(
          "This build no longer supports the current API. Install the latest Okou build to continue."
        )
      ) {
        Link("Open TestFlight", destination: URL(string: "itms-beta://")!)
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
      }
      .background(OkouColor.background)
      .interactiveDismissDisabled()
    }
  }

  private var chatPage: some View {
    Group {
      if let conversation = store.selectedConversation {
        ChatDetailView(
          conversation: conversation,
          agents: store.list,
          didSend: { await notifications.requestAfterSend() },
          topContentInset: topContentHeight,
          mentionSource: ComposerMentionSource(
            agentID: conversation.thread.agentID,
            threads: store.list.threads),
          onFirstMessagePresented: { store.newChatSubmission?.presentMessage($0) }
        )
        .id(conversation.thread.id)
      } else {
        newChatHome
          .frame(minHeight: 0, maxHeight: .infinity)
          .safeAreaInset(edge: .bottom, spacing: 0) {
            newChatComposer
          }
          .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.22),
            value: store.newComposer.voice?.phase ?? .idle)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .allowsHitTesting(store.newChatSubmission?.isPresenting != true)
    .accessibilityHidden(store.newChatSubmission?.isPresenting == true)
    .overlay {
      if let submission = store.newChatSubmission, submission.isPresenting {
        NewChatSubmissionView(submission: submission, webURL: store.webURL)
          .id(submission.message.id)
          .background { OkouColor.background.ignoresSafeArea() }
      }
    }
    .safeAreaBar(edge: .top, spacing: 0) {
      ChatWorkspaceHeader(store: store, height: headerHeight, openSidebar: openSidebar)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          topContentHeight = $0
        }
    }
    .background { OkouColor.background.ignoresSafeArea() }
    .composerSuggestionOverlay(
      topInset: topContentHeight, isEnabled: !sidebar.isOpen && !sidebar.isTransitioning
    )
  }

  @ViewBuilder private var newChatComposer: some View {
    if store.defaultAgentID != nil {
      @Bindable var composer = store.newComposer
      ChatComposerView(
        draft: $composer.text, isBusy: store.isCreating,
        showsProgress: store.isCreating, canStop: false,
        needsUpgrade: store.needsUpgrade,
        error: store.error, attachmentURL: store.webURL,
        attachments: composer.attachments,
        draftState: composer,
        submit: {
          await store.sendNewChat(
            sendTransition: ConversationSendTransition(), reduceMotion: reduceMotion)
          await notifications.requestAfterSend()
        },
        refresh: nil,
        modelSelection: store.newModelSelection,
        connectorSelection: store.newModelSelection.connectors,
        mentionSource: ComposerMentionSource(
          agentID: store.defaultAgentID,
          threads: store.list.threads),
        workflowSource: store.composerWorkflows, agentID: store.defaultAgentID,
        placeholder: String(localized: "Message \(store.currentAgentName)"),
        project: store.newChatProject,
        removeProject: store.removeNewChatProject
      )
      .transition(.identity)
    } else {
      // Reserve the compact input's space without mounting the provisional editor.
      Color.clear
        .frame(height: OkouControl.composerCompactHeight + OkouSpace.sm)
        .accessibilityHidden(true)
    }
  }

  private var newChatHome: some View {
    let agent = store.list.agents.first(where: { $0.agentId == store.defaultAgentID })
    return VStack(spacing: OkouSpace.xxl) {
      Spacer(minLength: 24)
      // Background restoration keeps the entrance; user navigation starts a fresh greeting.
      NewChatGreeting(
        avatarURL: agent?.avatarUrl, agentName: agent?.displayName ?? "Okou",
        isDefaultAgent: agent?.isDefaultAgent ?? true,
        text: greetingText
      )
      .id(taglineIndex)
      Spacer(minLength: 24)
    }
    .frame(maxWidth: 440)
    .padding(.horizontal, OkouSpace.xxl)
    .frame(maxWidth: .infinity)
    .frame(maxHeight: .infinity)
    // A tap anywhere on the empty page puts the keyboard away, as on the transcript.
    .contentShape(Rectangle())
    .onTapGesture {
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
    .onChange(of: store.selectedAgentID) { previous, _ in
      if previous != nil { taglineIndex = Int.random(in: 0..<64) }
    }
    .onChange(of: store.selectedThreadID) { _, id in
      if id == nil { taglineIndex = Int.random(in: 0..<64) }
    }
  }

  private var greetingText: String {
    NewChatTagline.text(
      index: taglineIndex,
      name: authentication.firstName?.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  private func openPendingNotification() async {
    if await lifecycle.openPendingNotification(), !Task.isCancelled {
      closeSidebar()
    }
  }

  private func openSidebar() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    sidebar.setOpen(true)
  }

  private func closeSidebar() {
    sidebar.setOpen(false)
  }

  private func startNewChat() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    store.startNewChat()
    closeSidebar()
  }
}
