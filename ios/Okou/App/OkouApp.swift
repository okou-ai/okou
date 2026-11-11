import CCStateSwiftUI
import ChatData
import Foundation
import SwiftUI

@main
struct OkouApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var delegate
  @State private var authentication: AuthenticationService?
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
      .task { await authentication?.start() }
      .onOpenURL { url in Task { await authentication?.handleURL(url) } }
    }
  }

  private var productRoot: some View {
    Group {
      if let authentication {
        switch configuration {
        case .success(let configuration):
          AppRootView(
            authentication: authentication, configuration: configuration,
            notifications: delegate.notifications)
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
    let data = notifications.data(
      authentication: authentication, configuration: configuration, session: session)
    _workspaceData = State(initialValue: data)
  }

  var body: some View {
    Group {
      if let scopeID = authentication.presentationScopeID,
        let workspaceID = authentication.presentationWorkspaceID,
        let userID = authentication.userID
      {
        if let workspaceData, workspaceData.scopeID == scopeID,
          scenePhase != .background || presentedScopeID == scopeID
        {
          WorkspaceRootView(
            authentication: authentication, configuration: configuration,
            workspaceID: workspaceID, userID: userID, scopeID: scopeID,
            accountError: $accountError, data: workspaceData, notifications: notifications
          )
          .id(scopeID)
        } else {
          OkouColor.background.ignoresSafeArea()
        }
      } else {
        SignInView(authentication: authentication, webURL: configuration.webURL)
      }
    }
    .task(id: authentication.presentationScopeID) {
      await authentication.preparePresentation()
    }
    .task(id: authentication.presentationScopeID) {
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
      if phase == .active { presentedScopeID = authentication.presentationScopeID }
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
  @State private var taglineIndex = Int.random(in: 0..<64)
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
    let cacheScope = ChatCacheScope(
      apiBaseURL: configuration.apiURL, userID: userID, workspaceID: workspaceID)
    _store = State(
      initialValue: WorkspaceStore(
        client: data.client, webURL: configuration.webURL, sharedSync: data.sync,
        draftStorage: ChatDraftStorage(scope: cacheScope),
        projectDisclosure: ProjectDisclosureStorage(scope: cacheScope),
        measurementScope: cacheScope,
        didRefreshReadState: { notifications.requestNotificationStateRefresh() }))
  }

  var body: some View {
    GeometryReader { geometry in
      // The sidebar takes most of the width and pushes the chat aside, as ChatGPT and Gmail do:
      // a strip of the chat stays on screen, dimmed, and a tap on it returns there, so leaving
      // the list never depends on knowing the swipe. The list drifts in from a quarter of its
      // width to the left as the chat slides over it.
      let sidebarWidth = (geometry.size.width * OkouControl.sidebarShare).rounded()
      let sidebarProgress =
        min(
          max((sidebar.isOpen ? sidebarWidth : 0) + (sidebar.translation ?? 0), 0), sidebarWidth)
        / sidebarWidth
      let drift = sidebarWidth * OkouMotion.sidebarParallax
      ZStack(alignment: .leading) {
        OkouColor.sidebar.ignoresSafeArea()

        Group {
          // Identity restoration gates the sidebar, never the new-chat screen.
          if authentication.presentation?.userID == userID,
            authentication.presentation?.preparedWorkspaceID == workspaceID
          {
            StoreProvider(store.projects.stateStore) {
              ChatSidebarView(
                store: store, authentication: authentication, workspaceID: workspaceID,
                notifications: notifications, sidebar: sidebar,
                headerHeight: headerHeight,
                accountError: $accountError,
                close: closeSidebar,
                newChat: startNewChat
              )
              .id(ObjectIdentifier(store))
            }
          }
        }
        .frame(width: sidebarWidth, height: geometry.size.height)
        .offset(x: -drift * (1 - sidebarProgress))
        .allowsHitTesting(sidebar.isOpen)
        .accessibilityHidden(!sidebar.isOpen)

        Group {
          if let conversation = store.selectedConversation {
            ChatDetailView(
              conversation: conversation,
              agents: store.list,
              didSend: { await notifications.requestAfterSend() },
              topContentInset: topContentHeight, sidebar: sidebar,
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
          VStack(spacing: 0) {
            // Sync problems float below the header with the rest of the chat feedback.
            ChatWorkspaceHeader(
              store: store, height: headerHeight, openSidebar: openSidebar,
              modelSelection: store.selectedConversation.map { $0.modelSelection }
                ?? store.newModelSelection)
          }
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: {
            topContentHeight = $0
          }
        }
        .frame(width: geometry.size.width, height: geometry.size.height)
        .background { OkouColor.background.ignoresSafeArea() }
        .accessibilityHidden(sidebar.isOpen)
        .allowsHitTesting(!sidebar.isOpen)
        .sensoryFeedback(.selection, trigger: sidebar.isOpen)
        // The strip of the chat beside the list frosts lightly as the list opens: the thinnest
        // material laid on top at part strength, not a blur of the chat itself, so the transcript
        // is never re-rendered (a blurred transcript re-read its safe area and jumped on the way
        // back) and its messages still show through the frost. The page turns into a card with large corners and a very faint edge.
        .overlay {
          Rectangle().fill(.ultraThinMaterial)
            .opacity(OkouElevation.sidebarFrost * sidebarProgress)
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .mask {
          RoundedRectangle(cornerRadius: OkouRadius.page * sidebarProgress, style: .continuous)
            .ignoresSafeArea()
        }
        .overlay {
          RoundedRectangle(cornerRadius: OkouRadius.page * sidebarProgress, style: .continuous)
            .strokeBorder(
              OkouColor.border.opacity(OkouElevation.sidebarEdgeLineOpacity * sidebarProgress),
              lineWidth: OkouSpace.hairline
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .background {
          // The edge's shadow comes from a plain card-shaped fill, so dragging never re-renders
          // the chat's own content for it.
          RoundedRectangle(cornerRadius: OkouRadius.page * sidebarProgress, style: .continuous)
            .fill(OkouColor.background)
            .shadow(
              color: .black.opacity(OkouElevation.sidebarEdgeOpacity * sidebarProgress),
              radius: OkouElevation.sidebarEdgeRadius
            )
            .ignoresSafeArea()
        }
        .offset(x: sidebarWidth * sidebarProgress)

        // The strip is the way back: a tap anywhere on it returns to the chat. It lies over the
        // chat, which takes no touches while the list is open.
        Color.clear
          .contentShape(Rectangle())
          .frame(width: max(geometry.size.width - sidebarWidth * sidebarProgress, 0))
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
          .ignoresSafeArea()
          .onTapGesture { closeSidebar() }
          .allowsHitTesting(sidebar.isOpen)
          .accessibilityElement()
          .accessibilityLabel("Close sidebar")
          .accessibilityAddTraits(.isButton)
          .accessibilityAction { closeSidebar() }
          .accessibilityHidden(!sidebar.isOpen)
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
      .composerSuggestionOverlay(
        topInset: topContentHeight, isEnabled: !sidebar.isOpen && sidebar.translation == nil
      )
    }
    .overlay(alignment: .top) {
      ChatFeedbackBanner(store: store)
        .padding(.top, headerHeight)
    }
    .modifier(ChatLinkNavigation(store: store, didOpen: closeSidebar))
    .background { ChatThreadRenameDialog(list: store.list).frame(width: 0, height: 0) }
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
    .modifier(
      NewChatNavigation(
        workspace: store, isAuthenticated: !authentication.isLoading,
        didOpen: closeSidebar)
    )
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

  private func startNewChat() {
    UIApplication.shared.sendAction(
      #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    store.startNewChat()
    closeSidebar()
  }
}

private struct NotificationNavigationIdentity: Hashable {
  let userID: String?
  let isLoading: Bool
  let destination: NotificationDestination?
}
