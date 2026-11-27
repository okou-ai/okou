import CCStateSwiftUI
import ChatData
import ChatDomain
import Foundation
import SwiftUI

@main
struct OkouApp: App {
  @UIApplicationDelegateAdaptor(NotificationAppDelegate.self) private var delegate
  @State private var authentication: AuthenticationService?
  @State private var lifecycle: AppLifecycle?
  private let configuration = Result { try AppConfiguration() }

  private static var isDesignPreview: Bool {
    if isSSHAuthorizationPreview || isForYouDeck { return true }
    #if DEBUG
      return ProcessInfo.processInfo.arguments.contains("--mobile-design-system") || isResultStyles
        || isChatSyncStatus || isComputerAuthorizationPreview
    #else
      return false
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

  /// The For you deck against a local fixture (`ForYouDeckGallery`), without signing in.
  private static var isForYouDeck: Bool {
    #if DEBUG || STAGING
      ProcessInfo.processInfo.arguments.contains("--for-you-deck")
    #else
      false
    #endif
  }

  private static var isSSHAuthorizationPreview: Bool {
    #if DEBUG || STAGING
      ProcessInfo.processInfo.arguments.contains("--ssh-access-cards")
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
        #if DEBUG || STAGING
          if Self.isSSHAuthorizationPreview {
            NavigationStack { SSHAuthorizationGallery() }
          } else if Self.isForYouDeck {
            ForYouDeckGallery()
          } else {
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
      .onOpenURL { url in
        if OkouWidgetLinks.shared.receive(url) { return }
        if ConnectorProviderAuthorization.returnAttemptID(url) != nil { return }
        if ConnectorProviderAuthorization.isProviderCallback(url) { return }
        Task { await authentication?.handleURL(url) }
      }
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
  private var sidebar: SidebarInteraction { store.sidebarInteraction }
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
    // Every workspace view reads the session's graph from this one provider.
    StoreProvider(store.graph) { workspace }
  }

  private var workspace: some View {
    // The page is held while a For you action runs, which the session graph records.
    ForYouBusyReader(forYou: store.forYou) { forYouBusy in
      workspaceNavigation(forYouBusy: forYouBusy)
    }
    .sensoryFeedback(.selection, trigger: sidebar.isOpen)
    .task(id: sidebar.path.contains(.forYou)) {
      if sidebar.path.contains(.forYou) { await store.forYou.beginVisit() }
    }
    .task(id: store.threadFeedback?.id) {
      guard let feedback = store.threadFeedback else { return }
      UIAccessibility.post(notification: .announcement, argument: feedback.message)
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
    // The widgets show this workspace's confirmed chat list; republish only when it changes.
    .background {
      SelectedConversationReader(store: store) { selected in
        WorkspaceWidgetPublisher(
          store: store, selected: selected, workspaceID: workspaceID,
          name: authentication.firstName?.trimmingCharacters(in: .whitespacesAndNewlines))
      }
    }
    .task(id: OkouWidgetLinks.shared.requestID) {
      guard let threadID = OkouWidgetLinks.shared.takeChat(in: workspaceID) else { return }
      if await store.openChatLink(.thread(id: threadID, runID: nil)) { closeSidebar() }
    }
    .modifier(
      NewChatNavigation(
        workspace: store, isAuthenticated: !authentication.isLoading,
        didOpen: closeSidebar)
    )
    .onDisappear {
      // Signing out or switching workspaces leaves no chat titles behind for the widgets.
      OkouWidgetPublishing.clear()
    }
    .modifier(ChatListActionAlert(list: store.list))
    .modifier(RequiredUpdateCover(store: store))
  }

  private func workspaceNavigation(forYouBusy: Bool) -> some View {
    WorkspaceNavigation(sidebar: sidebar, forYouBusy: forYouBusy) {
      // Mount the sidebar after identity and its complete local baseline are restored.
      RestoredSidebarGate(store: store) {
        if authentication.presentation?.userID == userID,
          authentication.presentation?.preparedWorkspaceID == workspaceID
        {
          ChatSidebarView(
            store: store, authentication: authentication, workspaceID: workspaceID,
            notifications: notifications,
            headerHeight: headerHeight,
            accountError: $accountError,
            close: closeSidebar,
            newChat: startNewChat
          )
          .id(ObjectIdentifier(store))
          .chatFeedbackOverlay(store: store, isPresented: sidebar.isOpen)
        }
      }
    } forYou: {
      ForYouView(workspace: store, showChat: closeSidebar, goBack: sidebar.goBack)
    } chat: {
      chatPage
    }
    .ignoresSafeArea()
  }

  private var chatPage: some View {
    SelectedConversationReader(store: store) { selected in chatPage(selected: selected) }
  }

  private func chatPage(selected: ConversationStore?) -> some View {
    Group {
      if let conversation = selected {
        WorkspaceChatDetail(
          store: store, conversation: conversation,
          workspaceName: authentication.workspacePresentation(workspaceID)?.name,
          notifications: notifications, topContentInset: topContentHeight
        )
        .id(conversation.thread.id)
      } else {
        newChatHome
          .frame(minHeight: 0, maxHeight: .infinity)
          .safeAreaInset(edge: .bottom, spacing: 0) {
            newChatComposer
              .chatFeedbackAnchor()
          }
          .modifier(NewChatVoiceAnimation(store: store, reduceMotion: reduceMotion))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .modifier(NewChatSubmissionCover(store: store, conversation: selected))
    .safeAreaBar(edge: .top, spacing: 0) {
      ChatWorkspaceHeader(store: store, height: headerHeight)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          topContentHeight = $0
        }
    }
    .background { OkouColor.background.ignoresSafeArea() }
    .sheet(
      item: Binding(get: { store.fork }, set: { if $0 == nil { store.dismissFork() } })
    ) { flow in
      WorkspaceForkSheet(store: store, flow: flow)
    }
    .chatFeedbackOverlay(store: store, isPresented: sidebar.showsChat)
    .composerSuggestionOverlay(
      topInset: topContentHeight, isEnabled: sidebar.showsChat && !sidebar.isTransitioning
    )
  }

  @ViewBuilder private var newChatComposer: some View {
    WorkspaceNewChatComposer(
      store: store, notifications: notifications, reduceMotion: reduceMotion
    )
    .transition(.identity)
  }

  private var newChatHome: some View {
    return VStack(spacing: OkouSpace.xxl) {
      Spacer(minLength: 24)
      // Background restoration keeps the entrance; user navigation starts a fresh greeting.
      NewChatGreeting(
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
    .modifier(NewChatTaglineReset(store: store, taglineIndex: $taglineIndex))
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

  private func closeSidebar() {
    sidebar.setOpen(false)
  }

  private func startNewChat() {
    NewChatRequests.shared.request()
  }
}

/// Resolves whether a For you action is running from the workspace session's graph, for the
/// navigation that holds the page while one runs. It applies under the workspace's Store
/// provider.
private struct ForYouBusyReader<Content: View>: View {
  let forYou: ForYouStore
  let content: (Bool) -> Content
  @ResolvedValue private var busy: Bool?

  init(forYou: ForYouStore, @ViewBuilder content: @escaping (Bool) -> Content) {
    self.forYou = forYou
    self.content = content
    _busy = ResolvedValue(forYou.busyValue)
  }

  var body: some View { content(busy ?? forYou.busy) }
}

/// Shows its content once the workspace has restored the sidebar's cached chats, Projects and
/// disclosure. The status is read from the workspace session's graph, so this applies under the
/// workspace's Store provider. The content is built by the parent, so a status change does not
/// rebuild it.
private struct RestoredSidebarGate<Content: View>: View {
  let store: WorkspaceStore
  let content: Content
  @ResolvedValue private var shell: WorkspaceStore.Shell?

  init(store: WorkspaceStore, @ViewBuilder content: () -> Content) {
    self.store = store
    self.content = content()
    _shell = ResolvedValue(store.shellValue)
  }

  var body: some View {
    if (shell ?? store.shell).hasRestoredSidebar { content }
  }
}

/// Animates the new chat's composer for voice input. The composer is read from the workspace
/// session's graph, so this applies under the workspace's Store provider.
private struct NewChatVoiceAnimation: ViewModifier {
  let store: WorkspaceStore
  let reduceMotion: Bool
  @ResolvedValue private var shell: WorkspaceStore.Shell?

  init(store: WorkspaceStore, reduceMotion: Bool) {
    self.store = store
    self.reduceMotion = reduceMotion
    _shell = ResolvedValue(store.shellValue)
  }

  func body(content: Content) -> some View {
    content.modifier(
      ComposerVoiceAnimation(
        voice: (shell ?? store.shell).newComposer.voice,
        animation: reduceMotion ? nil : .easeInOut(duration: 0.22)))
  }
}

/// Covers the chat page with the new chat's first message while it is presented, and keeps the
/// page beneath from taking input. The submission is read from the workspace session's graph,
/// so this applies under the workspace's Store provider.
private struct NewChatSubmissionCover: ViewModifier {
  let store: WorkspaceStore
  let conversation: ConversationStore?
  @ResolvedValue private var shell: WorkspaceStore.Shell?

  init(store: WorkspaceStore, conversation: ConversationStore?) {
    self.store = store
    self.conversation = conversation
    _shell = ResolvedValue(store.shellValue)
  }

  func body(content: Content) -> some View {
    let submission = (shell ?? store.shell).newChatSubmission
    content
      .allowsHitTesting(submission?.isPresenting != true)
      .accessibilityHidden(submission?.isPresenting == true)
      .overlay {
        if let submission, submission.isPresenting {
          NewChatSubmissionView(
            submission: submission, conversation: conversation, webURL: store.webURL
          )
          .id(submission.message.id)
          .background { OkouColor.background.ignoresSafeArea() }
        }
      }
  }
}

/// Covers the workspace once the API requires an update. The requirement is read from the
/// workspace session's graph, so this applies under the workspace's Store provider.
private struct RequiredUpdateCover: ViewModifier {
  let store: WorkspaceStore
  @ResolvedValue private var actionStatus: WorkspaceStore.ActionStatus?

  init(store: WorkspaceStore) {
    self.store = store
    _actionStatus = ResolvedValue(store.actionStatusValue)
  }

  func body(content: Content) -> some View {
    let needsUpgrade = (actionStatus ?? store.actionStatus).needsUpgrade
    content.fullScreenCover(isPresented: Binding(get: { needsUpgrade }, set: { _ in })) {
      RequiredUpdateView()
        .background(OkouColor.background)
        .interactiveDismissDisabled()
    }
  }
}

/// Resolves the selected chat's owner from the workspace session's graph, for content under the
/// workspace's Store provider.
private struct SelectedConversationReader<Content: View>: View {
  let store: WorkspaceStore
  let content: (ConversationStore?) -> Content
  @ResolvedValue private var selected: ConversationStore??

  init(store: WorkspaceStore, @ViewBuilder content: @escaping (ConversationStore?) -> Content) {
    self.store = store
    self.content = content
    _selected = ResolvedValue(store.selectedConversationValue, equals: { $0 === $1 })
  }

  var body: some View { content(selected ?? store.selectedConversation) }
}

/// Publishes the widget snapshot. The selected chat's draft mark and the API's draft list are
/// read from the session graph, so the publisher sits under the workspace's Store provider.
private struct WorkspaceWidgetPublisher: View {
  let store: WorkspaceStore
  let workspaceID: String
  let name: String?
  private let selectedThreadID: String?
  @ResolvedValue private var selectedDraft: Bool?
  @ResolvedValue private var listedDrafts: Set<String>?
  @ResolvedValue private var threads: [ChatThread]?

  init(store: WorkspaceStore, selected: ConversationStore?, workspaceID: String, name: String?) {
    self.store = store
    self.workspaceID = workspaceID
    self.name = name
    selectedThreadID = selected?.thread.id
    _selectedDraft = ResolvedValue(
      selected?.composer.unsentContent ?? ComposerDraftSignals.noContent)
    _listedDrafts = ResolvedValue(store.listedDraftIDs)
    _threads = ResolvedValue(store.list.threadsValue)
  }

  var body: some View {
    let listed = listedDrafts
    let snapshot = OkouWidgetPublishing.snapshot(
      workspaceID: workspaceID, threads: threads ?? store.list.threads, name: name,
      hasDraft: { id in
        id == selectedThreadID ? selectedDraft == true : store.hasDraft(id, listed: listed)
      })
    Color.clear
      .frame(width: 0, height: 0)
      .task(id: snapshot) { [snapshot] in OkouWidgetPublishing.publish(snapshot) }
  }
}

/// Reports a failed chat action once no rename editor is open or saving. The failure and the
/// rename state are read from the workspace session's graph, so this applies under the
/// workspace's Store provider.
private struct ChatListActionAlert: ViewModifier {
  let list: ThreadListStore
  @ResolvedValue private var status: ThreadListStore.Status?
  @ResolvedValue private var mutations: ThreadListMutations.Activity?

  init(list: ThreadListStore) {
    self.list = list
    _status = ResolvedValue(list.statusValue)
    _mutations = ResolvedValue(list.mutationsValue)
  }

  func body(content: Content) -> some View {
    let current = status ?? list.status
    let error = (mutations ?? list.mutations).actionError
    content.alert(
      "Unable to update chats",
      isPresented: Binding(
        get: { error != nil && current.renameRequest == nil && !current.isSavingRename },
        set: { if !$0 { list.dismissError() } })
    ) {
      Button("OK") { list.dismissError() }
    } message: {
      Text(error ?? "")
    }
  }
}

/// Picks a new tagline when the selection clears. The selection is read from the workspace
/// session's graph, so this applies under the workspace's Store provider.
private struct NewChatTaglineReset: ViewModifier {
  @Binding var taglineIndex: Int
  @ResolvedValue private var selection: String??

  init(store: WorkspaceStore, taglineIndex: Binding<Int>) {
    _taglineIndex = taglineIndex
    _selection = ResolvedValue(store.selectedThreadValue)
  }

  func body(content: Content) -> some View {
    content.onChange(of: selection ?? nil) { _, id in
      if id == nil { taglineIndex = Int.random(in: 0..<64) }
    }
  }
}

/// The selected chat. Its mention candidates are read from the workspace session's graph, so
/// the detail sits under the workspace's Store provider.
private struct WorkspaceChatDetail: View {
  let store: WorkspaceStore
  let conversation: ConversationStore
  let workspaceName: String?
  let notifications: NotificationService
  let topContentInset: CGFloat
  @ResolvedValue private var threads: [ChatThread]?

  init(
    store: WorkspaceStore, conversation: ConversationStore, workspaceName: String?,
    notifications: NotificationService, topContentInset: CGFloat
  ) {
    self.store = store
    self.conversation = conversation
    self.workspaceName = workspaceName
    self.notifications = notifications
    self.topContentInset = topContentInset
    _threads = ResolvedValue(store.list.threadsValue)
  }

  var body: some View {
    ChatDetailView(
      conversation: conversation, workspaceName: workspaceName,
      didSend: { await notifications.requestAfterSend() },
      topContentInset: topContentInset,
      mentionSource: ComposerMentionSource(threads: threads ?? store.list.threads),
      onFirstMessagePresented: { store.newChatSubmission?.presentMessage($0) },
      fork: { store.startFork($0, from: conversation) }
    )
  }
}

/// The new chat's composer. Its Project is read from the workspace session's graph, so the
/// composer sits under the workspace's Store provider.
private struct WorkspaceNewChatComposer: View {
  let store: WorkspaceStore
  let notifications: NotificationService
  let reduceMotion: Bool
  @ResolvedValue private var projects: [ChatProject]?
  @ResolvedValue private var threads: [ChatThread]?
  @ResolvedValue private var resolvedShell: WorkspaceStore.Shell?

  init(store: WorkspaceStore, notifications: NotificationService, reduceMotion: Bool) {
    self.store = store
    self.notifications = notifications
    self.reduceMotion = reduceMotion
    _projects = ResolvedValue(store.projects.confirmedValue)
    _threads = ResolvedValue(store.list.threadsValue)
    _resolvedShell = ResolvedValue(store.shellValue)
  }

  var body: some View {
    let shell = resolvedShell ?? store.shell
    ChatComposerView(
      isBusy: shell.isCreating,
      showsProgress: shell.isCreating, canStop: false,
      needsUpgrade: shell.needsUpgrade,
      error: shell.error, attachmentURL: store.webURL,
      draftState: shell.newComposer,
      submit: {
        await store.sendNewChat(
          sendTransition: ConversationSendTransition(), reduceMotion: reduceMotion)
        await notifications.requestAfterSend()
      },
      refresh: nil,
      modelSelection: store.newModelSelection,
      connectorSelection: store.newModelSelection.connectors,
      mentionSource: ComposerMentionSource(threads: threads ?? store.list.threads),
      workflowSource: store.composerWorkflows,
      project: shell.newChatProjectID.flatMap { id in
        (projects ?? store.projects.projects).first { $0.id == id }
      },
      removeProject: store.removeNewChatProject
    )
  }
}

/// The fork sheet. Its Project is read from the workspace session's graph.
private struct WorkspaceForkSheet: View {
  let store: WorkspaceStore
  let flow: ChatForkStore
  @ResolvedValue private var projects: [ChatProject]?
  @ResolvedValue private var threads: [ChatThread]?
  @ResolvedValue private var actionStatus: WorkspaceStore.ActionStatus?

  init(store: WorkspaceStore, flow: ChatForkStore) {
    self.store = store
    self.flow = flow
    _projects = ResolvedValue(store.projects.confirmedValue)
    _threads = ResolvedValue(store.list.threadsValue)
    _actionStatus = ResolvedValue(store.actionStatusValue)
  }

  var body: some View {
    ChatForkView(
      flow: flow, webURL: store.webURL, threads: threads ?? store.list.threads,
      project: (projects ?? store.projects.projects).first { $0.id == flow.projectID },
      needsUpgrade: (actionStatus ?? store.actionStatus).needsUpgrade, dismiss: store.dismissFork)
  }
}

private struct RequiredUpdateView: View {
  @State private var distribution: ClientDistribution?
  @State private var attempt = 0

  var body: some View {
    OkouEmptyState(
      "Update required", icon: "download",
      description: Text(
        "This build no longer supports the current API. Install the latest Okou build to continue."
      )
    ) {
      switch distribution {
      case .appStore:
        Link("Open App Store", destination: URL(string: "https://apps.apple.com/app/id6815550027")!)
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
      case .testFlight:
        Link("Open TestFlight", destination: URL(string: "itms-beta://")!)
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
      case .unknown:
        Button("Try again") { attempt += 1 }
          .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
      case nil:
        ProgressView()
      }
    }
    .task(id: attempt) {
      distribution = await InstallationDistribution.shared.current(retryUnknown: attempt > 0)
    }
  }
}
