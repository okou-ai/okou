import AuthenticationServices
import ClerkKit
import Foundation
import Observation

@MainActor
@Observable
final class NativeAuthFlow {
  /// One way in for everyone: `.options` holds the providers and the email field, and the same
  /// Continue logs an existing account in or creates a new one, as Clerk's own screen does.
  enum Step { case options, code, password, profile, additionalVerification }

  let clerk: Clerk
  private(set) var step: Step = .options
  var email = ""
  var code = ""
  var password = ""
  var firstName = ""
  var lastName = ""
  var username = ""
  var legalAccepted = false
  private(set) var requiredFields: [SignUp.Field] = []
  private(set) var error: String?
  private(set) var isWorking = false
  private(set) var resendAvailableAt = Date.distantPast
  private var signIn: SignIn?
  private var signUp: SignUp?
  private var operation: Task<Void, Never>?
  private var generation = 0
  private let completed: @MainActor () async -> Void

  init(clerk: Clerk, completed: @escaping @MainActor () async -> Void) {
    self.clerk = clerk
    self.completed = completed
  }

  var providers: [OAuthProvider] {
    let configured =
      clerk.environment?.userSettings.social.values.filter {
        $0.enabled && $0.authenticatable && !$0.notSelectable
      }.map { OAuthProvider(strategy: $0.strategy) } ?? []
    // Apple first: App Review asks that Sign in with Apple be no less prominent than the rest.
    let preferred: [OAuthProvider] = [.apple, .google, .microsoft, .slack]
    return configured.sorted {
      (preferred.firstIndex(of: $0) ?? preferred.count, $0.name)
        < (preferred.firstIndex(of: $1) ?? preferred.count, $1.name)
    }
  }

  var canSubmitEmail: Bool {
    let value = email.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.contains("@") && value.split(separator: "@").count == 2 && !value.contains(" ")
  }

  /// Back to the first screen; the email stays in its field to correct.
  func back() {
    guard !isWorking else { return }
    reset(to: .options)
  }

  func cancel() {
    generation += 1
    operation?.cancel()
    operation = nil
    password = ""
    code = ""
    isWorking = false
  }

  private func reset(to step: Step) {
    cancel()
    signIn = nil
    signUp = nil
    error = nil
    legalAccepted = false
    self.step = step
  }

  /// Clerk's answers for an email with no account yet, which Continue turns into a sign-up.
  private static let newAccountCodes: Set<String> = [
    "form_identifier_not_found", "invitation_account_not_exists",
  ]

  /// The SDK owns transport, verification, and sessions; this owner only composes the native steps.
  @discardableResult
  func startEmail() -> Task<Void, Never>? {
    guard canSubmitEmail else { return nil }
    email = email.trimmingCharacters(in: .whitespacesAndNewlines)
    return run {
      let attempt: SignIn
      do {
        attempt = try await self.clerk.auth.signIn(self.email)
      } catch let error as ClerkAPIError where Self.newAccountCodes.contains(error.code) {
        // No account for this email yet: the same Continue creates one.
        let created = try await self.clerk.auth.signUp(emailAddress: self.email)
        try self.requireCurrentOperation()
        try await self.continueSignUp(created)
        return
      }
      try self.requireCurrentOperation()
      self.signIn = attempt
      if attempt.status == .complete {
        try await self.finish(sessionID: attempt.createdSessionId)
      } else if attempt.supportedFirstFactors?.contains(where: { $0.strategy == .emailCode })
        == true
      {
        self.signIn = try await attempt.sendEmailCode()
        try self.requireCurrentOperation()
        self.showCode()
      } else if attempt.supportedFirstFactors?.contains(where: { $0.strategy == .password })
        == true
      {
        self.step = .password
      } else {
        self.step = .additionalVerification
      }
    }
  }

  @discardableResult
  func verify() -> Task<Void, Never>? {
    guard !code.isEmpty else { return nil }
    return run {
      if let signUp = self.signUp {
        let result = try await signUp.verifyEmailCode(self.code)
        try self.requireCurrentOperation()
        self.signUp = result
        try await self.continueSignUp(result)
      } else if let signIn = self.signIn {
        let result = try await signIn.verifyCode(self.code)
        try self.requireCurrentOperation()
        self.signIn = result
        if result.status == .complete {
          try await self.finish(sessionID: result.createdSessionId)
        } else {
          self.step = .additionalVerification
        }
      }
    }
  }

  func submitPassword() {
    guard let signIn, !password.isEmpty else { return }
    run {
      let result = try await signIn.authenticateWithPassword(self.password)
      try self.requireCurrentOperation()
      self.password = ""
      self.signIn = result
      if result.status == .complete {
        try await self.finish(sessionID: result.createdSessionId)
      } else {
        self.step = .additionalVerification
      }
    }
  }

  var canSubmitProfile: Bool {
    requiredFields.allSatisfy { field in
      switch field {
      case .firstName: !firstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case .lastName: !lastName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case .username: !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case .password: !password.isEmpty
      case .legalAccepted: legalAccepted
      default: false
      }
    }
  }

  @discardableResult
  func submitProfile() -> Task<Void, Never>? {
    guard let signUp, canSubmitProfile else { return nil }
    return run {
      let result = try await signUp.update(
        password: self.requiredFields.contains(.password) ? self.password : nil,
        firstName: self.requiredFields.contains(.firstName) ? self.firstName : nil,
        lastName: self.requiredFields.contains(.lastName) ? self.lastName : nil,
        username: self.requiredFields.contains(.username) ? self.username : nil,
        legalAccepted: self.requiredFields.contains(.legalAccepted) ? self.legalAccepted : nil)
      try self.requireCurrentOperation()
      self.password = ""
      try await self.continueSignUp(result)
    }
  }

  private func continueSignUp(_ attempt: SignUp) async throws {
    try requireCurrentOperation()
    signUp = attempt
    if attempt.status == .complete {
      try await finish(sessionID: attempt.createdSessionId)
    } else if !attempt.missingFields.isEmpty {
      let supported: Set<SignUp.Field> = [
        .firstName, .lastName, .username, .password, .legalAccepted,
      ]
      requiredFields = attempt.missingFields
      step =
        requiredFields.allSatisfy { supported.contains($0) } ? .profile : .additionalVerification
    } else if attempt.unverifiedFields.contains(.emailAddress) {
      signUp = try await attempt.sendEmailCode()
      try requireCurrentOperation()
      showCode()
    } else {
      step = .additionalVerification
    }
  }

  func resend() {
    guard Date.now >= resendAvailableAt else { return }
    run {
      if let signUp = self.signUp {
        self.signUp = try await signUp.sendEmailCode()
      } else if let signIn = self.signIn {
        self.signIn = try await signIn.sendEmailCode()
      }
      try self.requireCurrentOperation()
      self.code = ""
      self.resendAvailableAt = .now.addingTimeInterval(30)
    }
  }

  /// A provider logs an existing account in or creates one (Clerk's transfer flow). Apple uses
  /// the system's own Sign in with Apple sheet rather than a web page.
  func startOAuth(_ provider: OAuthProvider) {
    run {
      let result: TransferFlowResult
      if provider == .apple {
        result = try await self.clerk.auth.signInWithApple()
      } else {
        result = try await self.clerk.auth.signInWithOAuth(provider: provider, transferable: true)
      }
      try self.requireCurrentOperation()
      switch result {
      case .signIn(let attempt):
        if attempt.status == .complete {
          try await self.finish(sessionID: attempt.createdSessionId)
        } else {
          self.step = .additionalVerification
        }
      case .signUp(let attempt):
        try await self.continueSignUp(attempt)
      }
    }
  }

  private func showCode() {
    code = ""
    resendAvailableAt = .now.addingTimeInterval(30)
    step = .code
  }

  private func finish(sessionID: String?) async throws {
    try requireCurrentOperation()
    guard let sessionID else { throw AuthenticationService.AuthenticationError.signedOut }
    if clerk.session?.id != sessionID {
      try await clerk.auth.setActive(sessionId: sessionID)
    }
    try requireCurrentOperation()
    await completed()
  }

  private func requireCurrentOperation() throws {
    try Task.checkCancellation()
  }

  @discardableResult
  private func run(_ action: @escaping @MainActor () async throws -> Void) -> Task<Void, Never>? {
    guard !isWorking else { return nil }
    error = nil
    isWorking = true
    generation += 1
    let generation = generation
    operation = Task {
      defer {
        if generation == self.generation {
          self.isWorking = false
          self.operation = nil
        }
      }
      do { try await action() } catch is CancellationError {} catch let error
        as ASWebAuthenticationSessionError where error.code == .canceledLogin
      {} catch let error as ASAuthorizationError where error.code == .canceled {} catch {
        guard generation == self.generation, !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
    }
    return operation
  }
}
