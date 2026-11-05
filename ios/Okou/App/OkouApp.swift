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
      ProcessInfo.processInfo.arguments.contains("--mobile-design-system")
    #else
      false
    #endif
  }

  init() {
    if !Self.isDesignPreview { CrashReporting.start() }
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
          if Self.isDesignPreview {
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
  @State private var showsAgent = false
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
        draftStorage: ChatDraftStorage(scope: cacheScope), measurementScope: cacheScope,
        didRefreshReadState: { notifications.requestNotificationStateRefresh() }))
  }

  var body: some View {
    GeometryReader { geometry in
      // Full width: chat titles are long. The two pages cross-fade through a blur, as in Grok:
      // the chat drifts a quarter screen right as it blurs away and the list drifts in from a
      // quarter screen left as it comes into focus. Neither slides as a card, so no edge of
      // either page ever crosses the screen.
      let sidebarWidth = geometry.size.width
      let sidebarProgress =
        min(
          max((sidebar.isOpen ? sidebarWidth : 0) + (sidebar.translation ?? 0), 0), sidebarWidth)
        / sidebarWidth
      let drift = sidebarWidth * OkouMotion.sidebarParallax
      let topInset = geometry.safeAreaInsets.top
      let screenHeight = geometry.size.height + topInset + geometry.safeAreaInsets.bottom
      // The edge each page leads with fades out over part of the screen while it moves, so the
      // two pages meet in the blur instead of along a line.
      let chatFeather = min(sidebarProgress, OkouMotion.sidebarFeather)
      let sidebarFeather = min(1 - sidebarProgress, OkouMotion.sidebarFeather)
      ZStack(alignment: .leading) {
        OkouColor.background.ignoresSafeArea()

        ChatSidebarView(
          store: store, authentication: authentication, workspaceID: workspaceID,
          notifications: notifications,
          headerHeight: headerHeight,
          accountError: $accountError,
          close: closeSidebar,
          newChat: startNewChat
        )
        .frame(width: sidebarWidth, height: geometry.size.height)
        .blur(radius: OkouElevation.sidebarBlur * (1 - sidebarProgress))
        .opacity(sidebarProgress)
        .mask(alignment: .top) {
          LinearGradient(
            stops: [
              .init(color: .black, location: 1 - sidebarFeather), .init(color: .clear, location: 1),
            ], startPoint: .leading, endPoint: .trailing
          )
          .frame(width: sidebarWidth, height: screenHeight)
          .offset(y: -topInset)
        }
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
                agentID: conversation.thread.agentID, agents: store.list.agents,
                threads: store.list.threads),
              onFirstMessagePresented: { store.newChatSubmission?.presentMessage($0) }
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
                    agentID: store.selectedAgentID, agents: store.list.agents,
                    threads: store.list.threads),
                  workflowSource: store.composerWorkflows, agentID: store.selectedAgentID,
                  placeholder: String(localized: "Message \(store.currentAgentName)"))
              }
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(store.newChatSubmission?.isPresenting != true)
        .accessibilityHidden(store.newChatSubmission?.isPresenting == true)
        // Owned by the container so the header can open it from a chat and from home.
        .sheet(isPresented: $showsAgent) {
          AgentProfileSheet(
            store: store,
            agentID: store.list.threads.first(where: { $0.id == store.selectedThreadID })?.agentID
              ?? store.selectedAgentID ?? "",
            newChat: { startNewChat($0) })
        }
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
              openAgent: { showsAgent = true },
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
        .blur(radius: OkouElevation.sidebarBlur * sidebarProgress)
        .mask(alignment: .top) {
          LinearGradient(
            stops: [
              .init(color: .clear, location: 0), .init(color: .black, location: chatFeather),
            ],
            startPoint: .leading, endPoint: .trailing
          )
          .frame(width: sidebarWidth, height: screenHeight)
          .offset(y: -topInset)
        }
        .opacity(1 - sidebarProgress)
        .offset(x: drift * sidebarProgress)
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
      .composerWorkflowOverlay(
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
    // Siri / Shortcuts "Ask Okou": a new chat with the request in the composer, unsent.
    .task(id: PendingAppRequest.shared.prompt) {
      guard let prompt = PendingAppRequest.shared.prompt else { return }
      PendingAppRequest.shared.prompt = nil
      startNewChat()
      guard !prompt.isEmpty else { return }
      try? await Task.sleep(for: .milliseconds(400))
      store.newComposer.editor.appendText(prompt)
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

  private var newChatHome: some View {
    let agent = store.list.agents.first(where: { $0.agentId == store.selectedAgentID })
    return VStack(spacing: OkouSpace.xxl) {
      Spacer(minLength: 24)
      // Restarts the web's word-by-word entrance for each agent and each return home.
      NewChatGreeting(
        avatarURL: agent?.avatarUrl, agentName: agent?.displayName ?? "Okou",
        isDefaultAgent: agent?.isDefaultAgent ?? true, text: greetingText,
        openAgent: { showsAgent = true }
      )
      .id("\(store.selectedAgentID ?? "")-\(taglineIndex)")
      // A custom agent says what it is for under its greeting.
      if agent?.isDefaultAgent == false,
        let description = agent?.description?.trimmingCharacters(in: .whitespacesAndNewlines),
        !description.isEmpty
      {
        Text(description)
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .multilineTextAlignment(.center)
          .lineLimit(4)
      }
      Spacer(minLength: 24)
    }
    .frame(maxWidth: 440)
    .padding(.horizontal, OkouSpace.xxl)
    .frame(maxWidth: .infinity)
    .onChange(of: store.selectedAgentID) { _, _ in taglineIndex = Int.random(in: 0..<64) }
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
