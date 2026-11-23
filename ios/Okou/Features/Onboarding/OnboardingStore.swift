import ChatData
import Foundation
import Observation

/// The member's editable draft and confirmed transitions survive child navigation.
@MainActor @Observable
final class OnboardingStore {
  let resources: OnboardingResources
  let connectors: ComposerConnectorStore
  let subscriptions: PersonalSubscriptionStore
  private(set) var draft = OnboardingDraft()
  private(set) var isPrepared = false
  private(set) var isWorking = false
  private(set) var hasDraftConflict = false
  private(set) var error: String?
  private(set) var skillSession: OnboardingSkillSession?
  private(set) var importedSkills: [OnboardingImportedSkill] = []
  private(set) var completedPrompt: String?
  private let didComplete: @MainActor (String?) async throws -> Void
  private let didFail: @MainActor (Error) -> Void
  private var operation: Task<Void, Never>?
  private var closed = false
  private var completionConfirmed = false

  init(
    client: APIClient, webURL: URL, locale: String = "en-US",
    didFail: @escaping @MainActor (Error) -> Void,
    didComplete: @escaping @MainActor (String?) async throws -> Void
  ) {
    let production = webURL.host == "app.okou.ai"
    resources = OnboardingResources(
      client: client,
      catalogURL: URL(
        string: production
          ? "https://data.okou.ai/mcp" : "https://okou-data-router-staging.vm0.workers.dev/mcp")!,
      locale: locale, didFail: didFail)
    connectors = ComposerConnectorStore(
      service: ChatComposerAccess(client: client),
      authorizationService: ChatConnectorService(client: client), webURL: webURL, didFail: didFail)
    subscriptions = PersonalSubscriptionStore(client: client, didFail: didFail)
    self.didFail = didFail
    self.didComplete = didComplete
  }

  var step: OnboardingStep { draft.step ?? .industry }
  var steps: [OnboardingStep] {
    OnboardingStep.allCases.filter { $0 != .skills || draft.answers.provider != nil }
  }
  var stepIndex: Int { steps.firstIndex(of: step) ?? 0 }
  var canContinue: Bool {
    switch step {
    case .industry: draft.answers.industry != nil
    case .skills: !importedSkills.isEmpty
    case .ready:
      !draft.answers.startingPromptDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    default: true
    }
  }

  func prepare() async {
    await perform {
      if !self.isPrepared {
        self.draft =
          try await self.resources.store.get(self.resources.draft).value ?? OnboardingDraft()
        try self.checkCurrent()
        if self.step == .skills && self.draft.answers.provider == nil {
          self.draft.step = .experience
        }
        try self.resources.showRecommendation(self.draft.answers.recommendationJobId)
        self.isPrepared = true
      }
    }
  }

  func selectIndustry(_ industry: String) {
    guard !isWorking, draft.answers.industry != industry else { return }
    draft.answers.industry = industry
    draft.answers.startingPromptDraft = ""
    draft.answers.startingPromptKey = ""
    draft.answers.startingPromptOutput = nil
    draft.answers.recommendationJobId = nil
    draft.answers.recommendationStartedAt = nil
  }

  func selectExperience(_ experienced: Bool, provider: String? = nil) {
    guard !isWorking else { return }
    if draft.answers.provider != provider {
      skillSession = nil
      importedSkills = []
    }
    draft.answers.experienced = experienced
    draft.answers.provider = provider
  }

  func editPrompt(_ value: String) {
    guard !isWorking else { return }
    var trimmed = ""
    for character in value {
      if trimmed.utf16.count + String(character).utf16.count > 1000 { break }
      trimmed.append(character)
    }
    draft.answers.startingPromptDraft = trimmed
    draft.answers.startingPromptKey = "native-edited"
    draft.answers.startingPromptOutput = nil
  }

  func selectOutputFormat(_ format: String) {
    guard !isWorking else { return }
    var prompt = draft.answers.startingPromptDraft
    if let output = draft.answers.startingPromptOutput,
      let range = Range(
        NSRange(location: output.start, length: output.end - output.start), in: prompt)
    {
      prompt.removeSubrange(range)
    }
    let suffixes = [
      "image": "\n\nCreate the result as an image.",
      "presentation": "\n\nCreate the result as a presentation.",
      "website": "\n\nCreate the result as a website.",
      "report": "\n\nCreate the result as a report.",
      "research": "\n\nInclude detailed research with sources.",
      "people": "\n\nFind relevant people and summarize their backgrounds."
    ]
    let suffix = suffixes[format] ?? ""
    guard prompt.utf16.count + suffix.utf16.count <= 1000 else {
      error = String(localized: "Shorten your task before choosing an output format.")
      return
    }
    let start = prompt.utf16.count
    prompt += suffix
    draft.answers.startingPromptDraft = prompt
    draft.answers.startingPromptKey = "native-edited"
    draft.answers.startingPromptOutput =
      suffix.isEmpty
      ? nil
      : OnboardingDraft.Output(
        format: format, start: start, end: prompt.utf16.count)
  }

  func acceptRecommendation(_ recommendation: OnboardingRecommendation?) {
    guard draft.answers.startingPromptDraft.isEmpty,
      let value = recommendation?.recommendation
    else { return }
    draft.answers.startingPromptDraft = value.prompt
    draft.answers.startingPromptKey = recommendation?.jobId ?? ""
  }

  func next(skip: Bool = false) async {
    guard skip || canContinue else { return }
    await perform {
      let current = self.step
      let index = self.stepIndex
      if current == .ready {
        try await self.finish(usePrompt: !skip)
        return
      }
      if current == .sources, self.draft.answers.recommendationJobId == nil {
        await self.startRecommendation()
      }
      if current == .experience, skip { self.draft.answers.provider = nil }
      let steps = self.steps
      guard index + 1 < steps.count else { return }
      var nextDraft = self.draft
      nextDraft.step = steps[index + 1]
      // Stay on this step, with the user's input intact, if a durable save fails.
      nextDraft.revision = try await self.resources.service.save(nextDraft)
      try self.checkCurrent()
      self.draft = nextDraft
    }
  }

  func back() async {
    guard stepIndex > 0 else { return }
    await perform {
      var previous = self.draft
      previous.step = self.steps[self.stepIndex - 1]
      previous.revision = try await self.resources.service.save(previous)
      try self.checkCurrent()
      self.draft = previous
    }
  }

  private func startRecommendation() async {
    guard let industry = draft.answers.industry else { return }
    do {
      let id = try await resources.service.startRecommendation(industry: industry, locale: "en-US")
      try checkCurrent()
      draft.answers.recommendationJobId = id
      try resources.showRecommendation(id)
    } catch is CancellationError {} catch {
      // A recommendation is optional; the member can always write their own first task.
      if !closed { didFail(error) }
    }
  }

  func retry(_ resource: OnboardingResources.Resource) {
    do { try resources.retry(resource) } catch {
      self.error = ChatRequestFailure.message(for: error)
    }
  }

  func retryPreparation() async {
    retry(.draft)
    isPrepared = false
    hasDraftConflict = false
    await prepare()
  }

  func refreshReady() async {
    await perform {
      try self.resources.retry(.recommendation)
      let value = try await self.resources.store.get(self.resources.recommendation).value
      try self.checkCurrent()
      self.acceptRecommendation(value)
    }
  }

  func setTool(_ id: String, enabled: Bool) async {
    await perform {
      try await self.resources.service.setTool(id, enabled: enabled)
      try self.checkCurrent()
      try self.resources.retry(.preferences)
      _ = try await self.resources.store.get(self.resources.preferences).value
    }
  }

  func prepareSkills() async {
    guard let provider = draft.answers.provider else { return }
    await perform {
      if self.skillSession.map({ $0.expiresAt <= .now }) ?? true {
        let session = try await self.resources.service.createSkillSession(provider: provider)
        try self.checkCurrent()
        self.skillSession = session
      }
      guard let session = self.skillSession else { return }
      let skills = try await self.resources.service.importedSkills(sessionID: session.sessionId)
      try self.checkCurrent()
      self.importedSkills = skills
    }
  }

  var skillPrompt: String? {
    guard let session = skillSession, session.expiresAt > .now else { return nil }
    let directory = draft.answers.provider == "codex" ? "~/.codex/skills" : "~/.claude/skills"
    return """
      Import my local skills from \(directory) into my private Okou workflows. Read each SKILL.md, preserve its instructions, and POST one JSON object per skill to \(session.uploadUrl.absoluteString) with Authorization: Bearer \(session.token) and Content-Type: application/json. The object has name, description, instruction (the full SKILL.md), and optional files [{path, content}] containing UTF-8 supplementary files only. Do not upload credentials, environment files, caches, symlinks, or binary files. Import at most 50 skills; each instruction is at most 256 KiB, each of at most 50 files is at most 64 KiB, and total supplementary content is at most 1 MiB per skill. Report each created or skipped skill. This import credential expires at \(session.expiresAt.formatted(.iso8601)); do not print it or save it in a workflow.
      """
  }

  private func finish(usePrompt: Bool) async throws {
    if !completionConfirmed {
      // Read before every completion attempt: an uncertain response must not replay setup blindly.
      let before = try await resources.service.status()
      try checkCurrent()
      if before.needsOnboarding {
        draft.revision = try await resources.service.save(draft)
        let after = try await resources.service.complete(
          industry: draft.answers.industry, timezone: TimeZone.current.identifier)
        try checkCurrent()
        guard !after.needsOnboarding else { throw APIClientError.invalidResponse }
      }
      completionConfirmed = true
    }
    let prompt = usePrompt ? draft.answers.startingPromptDraft : nil
    try await didComplete(prompt)
    try checkCurrent()
    completedPrompt = prompt
    try resources.retry(.status)
  }

  private func checkCurrent() throws {
    try Task.checkCancellation()
    if closed { throw CancellationError() }
  }

  private func perform(_ action: @escaping @MainActor () async throws -> Void) async {
    guard !closed, operation == nil, !Task.isCancelled else { return }
    error = nil
    hasDraftConflict = false
    isWorking = true
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isWorking = false
        operation = nil
      }
      do {
        try await action()
        try checkCurrent()
      } catch is CancellationError {} catch {
        if !closed {
          self.error = ChatRequestFailure.message(for: error)
          if case APIClientError.http(409, _, _, _) = error { hasDraftConflict = true }
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
    resources.close()
    connectors.close()
    subscriptions.close()
    skillSession = nil
  }

  isolated deinit { operation?.cancel() }
}
