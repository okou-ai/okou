import CCState
import ChatData
import Foundation

enum NativeOnboardingStep: Int, CaseIterable {
  case industry, sources, ready

  var draftStep: OnboardingStep {
    switch self {
    case .industry: .industry
    case .sources: .sources
    case .ready: .ready
    }
  }
}

/// One member's setup draft, confirmed writes and first-task attempt live in the session graph.
@MainActor
final class OnboardingStore {
  struct Snapshot: Equatable {
    var draft = OnboardingDraft()
    var isPrepared = false
    var isWorking = false
    var hasDraftConflict = false
    var error: String?
    var task: FirstTask?
    var completionConfirmed = false
    var didFinish = false

    static let steps = NativeOnboardingStep.allCases
    var step: NativeOnboardingStep {
      switch draft.step {
      case .industry, nil: .industry
      case .sources: .sources
      // Web owns these active draft positions; native resumes at its task review.
      case .experience, .skills, .slack, .capabilities, .ready: .ready
      }
    }
    var stepIndex: Int { step.rawValue }
    var canEdit: Bool { !isWorking && task == nil }
    func canContinue(connected: Bool) -> Bool {
      switch step {
      case .industry: draft.answers.industry != nil
      case .sources: connected
      case .ready:
        !draft.answers.startingPromptDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      }
    }
  }

  struct FirstTask: Equatable {
    let prompt: String
    let threadID = UUID().uuidString.lowercased()
    let eventID = UUID().uuidString.lowercased()
    let sortID = UUID().uuidString.lowercased()
    var created = false
    var sent = false
  }

  let resources: OnboardingResources
  let connectors: ComposerConnectorStore
  let value: Computed<Snapshot>
  private let state = CCState.State(Snapshot())
  private let replace: Command<Void, Snapshot>
  private let client: APIClient
  private let commands: ChatCommands
  private let locale: String
  private var realtime: RealtimeService?
  private let signOutAction: (@MainActor () async throws -> Void)?
  /// A confirmed task's thread, or nil when the member chooses to explore.
  private let didComplete: @MainActor (String?) async throws -> Void
  private let didFail: @MainActor (Error) -> Void
  private var operation: Task<Void, Never>?
  private var recommendationTask: Task<Void, Never>?
  private var closed = false

  init(
    client: APIClient, webURL: URL, graph: CCState.Store, locale: String = "en-US",
    memberAccessEnabled: @escaping @MainActor () -> Bool = { false },
    didFail: @escaping @MainActor (Error) -> Void,
    signOut: (@MainActor () async throws -> Void)? = nil,
    didComplete: @escaping @MainActor (String?) async throws -> Void
  ) {
    self.client = client
    self.locale = locale
    let state = state
    let value = Computed { try $0(state) }
    self.value = value
    replace = Command { context, snapshot in try context.set(state, snapshot) }
    let recommendationJob = Computed { try $0(value).draft.answers.recommendationJobId }
    resources = OnboardingResources(
      client: client, graph: graph, recommendationJob: recommendationJob, didFail: didFail)
    connectors = ComposerConnectorStore(
      service: ChatComposerAccess(client: client),
      authorizationService: ChatConnectorService(client: client), webURL: webURL, graph: graph,
      includesRemote: false, memberAccessEnabled: memberAccessEnabled, didFail: didFail)
    commands = ChatCommands(client: client, sync: ChatSync(client: client))
    self.didFail = didFail
    signOutAction = signOut
    self.didComplete = didComplete
  }

  var snapshot: Snapshot {
    // Non-failing local graph inputs; HTTP failures remain on their resource or operation.
    do { return try resources.store.get(value) } catch {
      preconditionFailure("Cannot read onboarding state: \(error)")
    }
  }
  private func update(_ change: (inout Snapshot) -> Void) {
    var next = snapshot
    change(&next)
    do { try resources.store.set(replace, next) } catch {
      preconditionFailure("Cannot publish onboarding state: \(error)")
    }
  }
  var draft: OnboardingDraft { snapshot.draft }
  var step: NativeOnboardingStep { snapshot.step }
  var canContinue: Bool { snapshot.canContinue(connected: !connectors.connectors.isEmpty) }
  var canSignOut: Bool { signOutAction != nil }

  func startLiveUpdates() {
    guard !closed, realtime == nil, let member = client.member else { return }
    let realtime = RealtimeService(
      userID: member.userID, workspaceID: member.workspaceID,
      tokenProvider: { [client] in
        try await client.data("/api/realtime/token", method: "POST", body: Data("{}".utf8)).data
      }, onChange: { _ in },
      onConnection: { [weak self] status in
        if status == .connected { self?.recommendationChanged() }
      }, onRecommendationChanged: { [weak self] in self?.recommendationChanged() })
    self.realtime = realtime
    realtime.setForeground(true)
    realtime.start()
  }

  func setForeground(_ active: Bool) { realtime?.setForeground(active) }

  func endPresentation() {
    realtime?.stop()
    realtime = nil
    connectors.authorization.cancel()
  }

  private func recommendationChanged() {
    guard !closed else { return }
    recommendationTask?.cancel()
    recommendationTask = Task { [weak self] in await self?.refreshReady() }
  }

  func signOut() async { await perform { try await self.signOutAction?() } }

  func prepare() async {
    await perform {
      guard !self.snapshot.isPrepared else { return }
      let draft =
        try await self.resources.store.get(self.resources.draft).value ?? OnboardingDraft()
      try self.checkCurrent()
      self.update {
        $0.draft = draft
        $0.isPrepared = true
      }
    }
  }

  func selectIndustry(_ industry: String) {
    guard !closed, snapshot.canEdit, draft.answers.industry != industry else { return }
    update {
      $0.draft.answers.industry = industry
      $0.draft.answers.startingPromptDraft = ""
      $0.draft.answers.startingPromptKey = ""
      $0.draft.answers.startingPromptOutput = nil
      $0.draft.answers.recommendationJobId = nil
      $0.draft.answers.recommendationStartedAt = nil
    }
  }

  func editPrompt(_ value: String) {
    guard !closed, snapshot.canEdit else { return }
    var trimmed = ""
    for character in value {
      if trimmed.utf16.count + String(character).utf16.count > 1000 { break }
      trimmed.append(character)
    }
    update {
      $0.draft.answers.startingPromptDraft = trimmed
      $0.draft.answers.startingPromptKey = "native-edited"
      $0.draft.answers.startingPromptOutput = nil
    }
  }

  func acceptRecommendation(_ recommendation: OnboardingRecommendation?) {
    guard !closed, snapshot.task == nil, draft.answers.startingPromptKey != "native-edited",
      let recommendation, recommendation.jobId == draft.answers.recommendationJobId,
      let value = recommendation.recommendation
    else { return }
    update {
      $0.draft.answers.startingPromptDraft = value.prompt
      $0.draft.answers.startingPromptKey = recommendation.jobId
    }
  }

  func next(skip: Bool = false) async {
    guard !snapshot.didFinish, !snapshot.hasDraftConflict, skip || canContinue else { return }
    guard !skip || snapshot.task == nil else { return }
    await perform {
      if self.step == .ready {
        try await self.finish(usePrompt: !skip)
        return
      }
      let current = self.step
      if current == .sources, !skip, self.draft.answers.recommendationJobId == nil {
        await self.startRecommendation()
      }
      var next = self.draft
      next.step = current == .industry ? .sources : .ready
      if next.step == .ready, next.answers.startingPromptKey.isEmpty {
        next.answers.startingPromptDraft = OnboardingSuggestedTask.prompt(
          for: next.answers.industry)
      }
      let revision = try await self.saveDraft(next)
      try self.checkCurrent()
      next.revision = revision
      self.update { $0.draft = next }
    }
  }

  func back() async {
    guard snapshot.canEdit, snapshot.stepIndex > 0 else { return }
    await perform {
      var previous = self.draft
      previous.step = Snapshot.steps[self.snapshot.stepIndex - 1].draftStep
      let revision = try await self.saveDraft(previous)
      try self.checkCurrent()
      previous.revision = revision
      self.update { $0.draft = previous }
    }
  }

  private func startRecommendation() async {
    guard let industry = draft.answers.industry else { return }
    do {
      let id = try await resources.service.startRecommendation(industry: industry, locale: locale)
      try checkCurrent()
      update { $0.draft.answers.recommendationJobId = id }
    } catch is CancellationError {} catch {
      // Personalization is optional; the role's editable starter task remains available.
      if !closed { didFail(error) }
    }
  }

  func report(_ error: Error) { didFail(error) }

  func retry(_ resource: OnboardingResources.Resource) {
    guard !closed else { return }
    do { try resources.retry(resource) } catch {
      update { $0.error = ChatRequestFailure.message(for: error) }
    }
  }

  func retryPreparation() async {
    guard !snapshot.isWorking, !closed else { return }
    retry(.draft)
    update {
      $0.isPrepared = false
      $0.hasDraftConflict = false
    }
    await prepare()
  }

  func refreshReady() async {
    guard !closed else { return }
    do {
      try resources.retry(.recommendation)
      let value = try await resources.store.get(resources.recommendation).value
      try checkCurrent()
      acceptRecommendation(value)
      if draft.answers.startingPromptDraft.isEmpty, draft.answers.startingPromptKey.isEmpty {
        update {
          $0.draft.answers.startingPromptDraft = OnboardingSuggestedTask.prompt(
            for: $0.draft.answers.industry)
        }
      }
    } catch is CancellationError {} catch {
      if !closed { didFail(error) }
    }
  }

  private func finish(usePrompt: Bool) async throws {
    let before = try await resources.service.status()
    try checkCurrent()
    if !before.needsOnboarding { update { $0.completionConfirmed = true } }
    var saved = draft
    if before.needsOnboarding, snapshot.task == nil {
      saved.revision = try await saveDraft(saved)
      try checkCurrent()
      update { $0.draft = saved }
    }
    if usePrompt {
      if snapshot.task == nil {
        update { $0.task = FirstTask(prompt: saved.answers.startingPromptDraft) }
      }
      guard let task = snapshot.task else { return }
      if !task.created {
        _ = try await commands.createThread(clientThreadID: task.threadID)
        try checkCurrent()
        update { $0.task?.created = true }
      }
      if !task.sent {
        _ = try await commands.send(
          threadID: task.threadID, text: task.prompt,
          clientEventID: task.eventID, chatThreadSortEventID: task.sortID)
        try checkCurrent()
        update { $0.task?.sent = true }
      }
    }
    if !snapshot.completionConfirmed {
      let after = try await resources.service.complete(
        industry: draft.answers.industry, timezone: TimeZone.current.identifier)
      try checkCurrent()
      guard !after.needsOnboarding else { throw APIClientError.invalidResponse }
      update { $0.completionConfirmed = true }
    }
    try await didComplete(snapshot.task?.threadID)
    try checkCurrent()
    update { $0.didFinish = true }
    try resources.retry(.status)
  }

  private func saveDraft(_ draft: OnboardingDraft) async throws -> String {
    do { return try await resources.service.save(draft) } catch {
      if case APIClientError.http(409, _, _, _) = error {
        update { $0.hasDraftConflict = true }
      }
      throw error
    }
  }

  private func checkCurrent() throws {
    try Task.checkCancellation()
    if closed { throw CancellationError() }
  }

  private func perform(_ action: @escaping @MainActor () async throws -> Void) async {
    guard !closed, operation == nil, !Task.isCancelled else { return }
    update {
      $0.error = nil
      $0.hasDraftConflict = false
      $0.isWorking = true
    }
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        update { $0.isWorking = false }
        operation = nil
      }
      do {
        try await action()
        try checkCurrent()
      } catch is CancellationError {} catch {
        if !closed {
          update {
            $0.error = ChatRequestFailure.message(for: error)
          }
          didFail(error)
        }
      }
    }
    operation = task
    await task.value
  }

  func close() {
    closed = true
    operation?.cancel()
    recommendationTask?.cancel()
    endPresentation()
    resources.close()
    connectors.close()
    commands.closeFileCache()
  }

  isolated deinit {
    operation?.cancel()
    recommendationTask?.cancel()
  }
}
