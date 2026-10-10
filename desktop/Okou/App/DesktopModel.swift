import AppKit
import ClerkKit
import Combine
import IOKit.pwr_mgt
import OkouCore

struct DesktopConfiguration: Decodable {
  let platformUrl: URL
  let clerkPublishableKey: String
  let product: String
  var apiURL: URL { ServiceOrigin.api(for: platformUrl) }
  static func load() throws -> DesktopConfiguration {
    guard let url = Bundle.main.url(forResource: "desktop-runtime-config", withExtension: "json")
    else {
      throw DesktopFailure(
        "invalid_configuration", "The packaged Desktop runtime configuration is missing")
    }
    let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    guard value.product == "okou", value.clerkPublishableKey.hasPrefix("pk_"),
      value.platformUrl.scheme == "https" || value.platformUrl.host == "localhost"
    else {
      throw DesktopFailure("invalid_configuration", "Invalid Desktop runtime configuration")
    }
    return value
  }
}

@MainActor
final class DesktopModel: ObservableObject {
  @Published var compatibility: DesktopCompatibility
  @Published var upgradePhase: DesktopUpgradePhase = .checking
  @Published var compatibilityChecking = false
  var requestRequiredUpdate: (() -> Void)?
  private var compatibilityTask: Task<Void, Never>?
  private var drainTask: Task<Void, Never>?
  private var compatibilityRevision = 0
  @Published var preparing = true
  @Published var signedIn = false
  @Published var email = ""
  @Published var organizationID: String?
  @Published var organization: String?
  @Published var organizations: [(id: String, name: String)] = []
  @Published var showWorkspaces = false
  @Published var permissions: JSONValue = .object([
    "accessibility": .bool(false), "screenRecording": .bool(false),
  ])
  @Published var runtime = RuntimeState()
  @Published var error: String?
  @Published var busy = false
  @Published var developerToolsAvailable = false
  @Published var developerToolsEnabled = false
  @Published var keepAwake = false
  @Published var showDiagnostics = false
  @Published var browserPermissions: [String: JSONValue] = [:]
  let configuration: DesktopConfiguration
  let preferences: Preferences
  let executor: CommandExecutor
  let api: APIClient
  let version: String
  let deviceName = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
  private var host: HostRuntime!
  private var identity: String?
  private var verifiedUserId: String?
  private var verifiedOrganizationId: String?
  private var verifiedSessionId: String?
  private var identityRefreshTask: Task<Void, Never>?
  private var identityGeneration = 0
  private var authTask: Task<Void, Never>?
  private var refreshTask: Task<Void, Never>?
  private var awakeAssertion: IOPMAssertionID = 0
  var didChange: (() -> Void)?
  var permissionsReady: Bool {
    permissions["accessibility"].bool == true && permissions["screenRecording"].bool == true
  }
  var ready: Bool { signedIn && organization != nil && permissionsReady && !compatibility.required }
  var online: Bool { ["online", "connecting", "recovering", "stopping"].contains(runtime.status) }
  var statusLabel: String {
    [
      "offline": "Offline", "online": "Online", "connecting": "Starting...",
      "recovering": "Recovering", "stopping": "Stopping...", "disabled": "Disabled",
      "error": "Error",
    ][runtime.status] ?? runtime.status
  }

  init(configuration: DesktopConfiguration, profileDirectory: URL? = nil) throws {
    self.configuration = configuration
    guard let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String,
      let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString")
        as? String,
      !appName.isEmpty, !version.isEmpty
    else { throw DesktopFailure("invalid_configuration", "Desktop bundle metadata is missing") }
    self.version = version
    let directory =
      profileDirectory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(appName)
    preferences = try Preferences(directory: directory)
    compatibility = DesktopCompatibility(
      version: version,
      minimumSupportedVersion: preferences.string("desktopMinimumSupportedVersion"),
      rejected: preferences.bool("desktopUpdateRequired")
        && preferences.string("desktopRejectedVersion") == version)
    keepAwake = preferences.bool("keepAwakeEnabled")
    let telemetry = [
      "OKOU_DESKTOP_SENTRY_DSN": Bundle.main.object(forInfoDictionaryKey: "OkouSentryDSN")
        as? String ?? "",
      "OKOU_DESKTOP_SENTRY_RELEASE": "okou-desktop@\(version)",
    ]
    executor = CommandExecutor(
      helper: NativeProcess(
        executable: Bundle.main.bundleURL.appendingPathComponent(
          "Contents/MacOS/computer-use-helper"), environment: telemetry))
    api = APIClient(baseURL: configuration.apiURL, version: version)
    let installationId = try preferences.installationId
    host = HostRuntime(
      api: api, executor: executor, installationId: installationId, hostName: deviceName,
      version: version,
      notifications: AblyCommandNotifications(),
      tokenProvider: { [weak self] forceRefresh in
        guard let self else { throw CancellationError() }
        return try await self.sessionToken(forceRefresh: forceRefresh)
      },
      onChange: { [weak self] state in
        guard let self else { return }
        let newlyRejected = state.updateRequired && !self.runtime.updateRequired
        self.runtime = state
        if newlyRejected {
          self.compatibilityRevision += 1
          self.compatibility.reject(minimum: state.minimumSupportedVersion)
          self.persistCompatibility()
          self.beginRequiredUpgrade()
        }
        self.didChange?()
      })
  }
  static var authKeychainService: String { "\(Bundle.main.bundleIdentifier!).native-auth" }
  static func configureAuthentication(_ configuration: DesktopConfiguration) {
    // Start a new login after Electron migration. Native releases reuse this
    // namespace; changing it every launch would discard their own sessions.
    Clerk.configure(
      publishableKey: configuration.clerkPublishableKey,
      options: .init(keychainConfig: .init(service: authKeychainService)))
  }
  func start() {
    applyKeepAwake()
    authTask = Task {
      let alreadyRequired = compatibility.required
      await checkCompatibility()
      if alreadyRequired && compatibility.required { beginRequiredUpgrade() }
      Self.configureAuthentication(configuration)
      do {
        try await refreshIdentity()
        try await refreshPermissions()
      } catch { self.error = error.localizedDescription }
      preparing = false
      didChange?()
      if ready { Task { await startHostIfSupported() } }
      refreshTask = Task {
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .seconds(5))
            if !runtime.busy && !busy { try await refreshPermissions() }
          } catch is CancellationError { return } catch { self.error = error.localizedDescription }
        }
      }
      identityRefreshTask = Task {
        while !Task.isCancelled {
          do {
            try await Task.sleep(for: .seconds(15))
            try await refreshIdentity()
          } catch is CancellationError { if Task.isCancelled { return } } catch {
            self.error = error.localizedDescription
          }
        }
      }
    }
  }
  func checkCompatibility() async {
    if let task = compatibilityTask {
      await task.value
      return
    }
    let task = Task { @MainActor in
      compatibilityChecking = true
      defer { compatibilityChecking = false }
      do {
        let revision = compatibilityRevision
        let response = try await api.request("api/desktop/compatibility", timeout: 10)
        try Task.checkCancellation()
        guard compatibilityRevision == revision else { return }
        let wasRequired = compatibility.required
        try compatibility.apply(response)
        persistCompatibility()
        if compatibility.required && !wasRequired { beginRequiredUpgrade() }
      } catch is CancellationError { return } catch {
        // A failed check must never unlock a previously rejected installation.
        if compatibility.required { upgradePhase = .failed(error.localizedDescription) }
      }
      didChange?()
    }
    compatibilityTask = task
    await task.value
    compatibilityTask = nil
  }
  private func persistCompatibility() {
    do {
      try preferences.set([
        "desktopMinimumSupportedVersion": compatibility.minimumSupportedVersion.map(
          JSONValue.string) ?? .null,
        "desktopUpdateRequired": .bool(compatibility.rejected),
        "desktopRejectedVersion": compatibility.rejected ? .string(version) : .null,
      ])
    } catch { self.error = error.localizedDescription }
  }
  private func beginRequiredUpgrade() {
    guard compatibility.required else { return }
    if drainTask == nil { drainTask = Task { await host.stop() } }
    upgradePhase = .checking
    showWorkspaces = false
    requestRequiredUpdate?()
    didChange?()
  }
  private func startHostIfSupported() async {
    await checkCompatibility()
    guard ready else { return }
    await drainTask?.value
    drainTask = nil
    await host.start()
  }
  func retryRequiredUpgrade() {
    Task {
      await checkCompatibility()
      if compatibility.required { beginRequiredUpgrade() }
    }
  }
  func drainForUpgrade() async {
    upgradePhase = .draining
    await drainTask?.value
    await host.stop()
  }
  func stopForUpdate() async { await host.stop() }
  func downloadLatest() {
    NSWorkspace.shared.open(
      configuration.apiURL.appendingPathComponent(
        "api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg"))
  }
  private func sessionToken(forceRefresh: Bool) async throws -> String {
    let expected = identityGeneration
    guard let verifiedUserId, let verifiedOrganizationId, let verifiedSessionId,
      signedIn, organization != nil,
      Clerk.shared.user?.id == verifiedUserId,
      Clerk.shared.session?.id == verifiedSessionId,
      Clerk.shared.session?.lastActiveOrganizationId == verifiedOrganizationId
    else {
      throw DesktopFailure("unauthenticated", "Sign in and select a workspace before going online")
    }
    let token = try await Clerk.shared.auth.getToken(.init(skipCache: forceRefresh))
    try checkIdentityGeneration(expected)
    guard Clerk.shared.user?.id == verifiedUserId,
      Clerk.shared.session?.id == verifiedSessionId,
      Clerk.shared.session?.lastActiveOrganizationId == verifiedOrganizationId
    else {
      throw DesktopFailure("unauthenticated", "Desktop account changed. Go offline and reconnect.")
    }
    guard let token else {
      throw DesktopFailure("unauthenticated", "Desktop session is no longer signed in")
    }
    return token
  }
  private func refreshIdentity() async throws {
    let expected = identityGeneration
    _ = try await Clerk.shared.refreshClient()
    try checkIdentityGeneration(expected)
    let bearer = try await Clerk.shared.auth.getToken()
    try checkIdentityGeneration(expected)
    guard let token = bearer else {
      await clearIdentity(expected: expected)
      return
    }
    let me = try await api.request("api/auth/me", token: token)
    try checkIdentityGeneration(expected)
    if me.status == 401 {
      await clearIdentity(expected: expected)
      return
    }
    guard me.status == 200, let userId = me.body["userId"].string else {
      throw DesktopFailure(
        "authentication_unavailable", "Unable to verify Desktop account (HTTP \(me.status))")
    }
    let orgId = me.body["orgId"].string
    let currentIdentity = "\(userId):\(orgId ?? ""): \(me.body["sessionId"].string ?? "")"
    if let identity, identity != currentIdentity { await host.stop() }
    var orgName: String?
    if let orgId {
      let org = try await api.request("api/org", token: token)
      try checkIdentityGeneration(expected)
      if org.status == 401 || org.status == 404 {
        await clearIdentity(expected: expected)
        return
      }
      guard org.status == 200, org.body["id"].string == orgId, let name = org.body["name"].string
      else {
        throw DesktopFailure("authentication_unavailable", "Unable to verify Desktop workspace")
      }
      orgName = name
    }
    try checkIdentityGeneration(expected)
    guard Clerk.shared.user?.id == userId,
      Clerk.shared.session?.id == me.body["sessionId"].string,
      Clerk.shared.session?.lastActiveOrganizationId == orgId
    else { throw CancellationError() }
    identity = currentIdentity
    verifiedUserId = userId
    verifiedOrganizationId = orgId
    verifiedSessionId = me.body["sessionId"].string
    signedIn = true
    email = me.body["email"].string ?? "Signed in"
    organizationID = orgId
    organization = orgName
    let switches = try await api.request("api/feature-switches", token: token)
    try checkIdentityGeneration(expected)
    if switches.status == 200 {
      developerToolsAvailable =
        switches.body["effectiveSwitches"]["_debug"].bool == true
    } else {
      developerToolsAvailable = false
    }
    if !developerToolsAvailable { developerToolsEnabled = false }
    didChange?()
  }
  private func checkIdentityGeneration(_ expected: Int) throws {
    try Task.checkCancellation()
    guard expected == identityGeneration else { throw CancellationError() }
  }
  private func clearIdentity(expected: Int? = nil) async {
    if let expected, expected != identityGeneration { return }
    if signedIn || online { await host.stop() }
    if let expected, expected != identityGeneration { return }
    identity = nil
    verifiedUserId = nil
    verifiedOrganizationId = nil
    verifiedSessionId = nil
    signedIn = false
    organizationID = nil
    organization = nil
    email = ""
    developerToolsAvailable = false
    developerToolsEnabled = false
    didChange?()
  }
  func signIn() {
    perform {
      self.identityGeneration += 1
      _ = try await Clerk.shared.auth.startHostedAuth()
      try await self.refreshIdentity()
      if self.organization == nil && self.signedIn { await self.selectWorkspace() }
      if self.ready { Task { await self.startHostIfSupported() } }
    }
  }
  func signOut() {
    perform {
      self.identityGeneration += 1
      await self.host.stop()
      var remoteError: Error?
      do { try await Clerk.shared.auth.signOut() } catch { remoteError = error }
      try await Clerk.clearAllKeychainItemsAndWait()
      await self.clearIdentity()
      if let remoteError { throw remoteError }
    }
  }
  func switchWorkspace() {
    perform {
      self.identityGeneration += 1
      await self.host.stop()
      await self.selectWorkspace()
    }
  }
  private func selectWorkspace() async {
    organizations = (Clerk.shared.user?.organizationMemberships ?? []).map {
      ($0.organization.id, $0.organization.name)
    }
    showWorkspaces = true
  }
  func chooseWorkspace(_ id: String) {
    perform {
      self.identityGeneration += 1
      guard let session = Clerk.shared.session?.id else {
        throw DesktopFailure("unauthenticated", "Sign in before selecting a workspace")
      }
      try await Clerk.shared.auth.setActive(sessionId: session, organizationId: id)
      try await self.refreshIdentity()
      self.showWorkspaces = false
      if self.ready { Task { await self.startHostIfSupported() } }
    }
  }
  func goOnline() {
    perform {
      guard self.ready else {
        throw DesktopFailure(
          "permission_denied", "Complete account and permissions setup before going online")
      }
      await self.host.stop()
      Task { await self.startHostIfSupported() }
    }
  }
  func goOffline() { perform { await self.host.stop() } }
  func refreshPermissions() async throws {
    guard !runtime.busy else { return }
    var value = try await executor.permissions()
    // macOS cannot inspect browser Automation without probing it. Retain the
    // latest explicit probe for the same UI and heartbeat permission state.
    value["automation"] = .object(browserPermissions)
    permissions = value
    await host.updatePermissions(value)
    didChange?()
    if online && !permissionsReady { await host.stop() }
  }
  func requestPermission(screenRecording: Bool) {
    perform {
      self.permissions = try await self.executor.requestPermission(screenRecording: screenRecording)
      try await self.refreshPermissions()
      if self.ready && !self.online { Task { await self.startHostIfSupported() } }
    }
  }
  func probeBrowser(_ target: String) {
    perform {
      let helper = NativeProcess(
        executable: Bundle.main.bundleURL.appendingPathComponent(
          "Contents/MacOS/computer-use-helper"))
      defer { Task { await helper.stop() } }
      let response = try await helper.request(
        .object(["kind": .string("permissions.probe_automation"), "target": .string(target)]))
      guard response["status"].string == "succeeded" else {
        throw DesktopFailure(
          "automation_unavailable",
          response["error"]["message"].string ?? "Browser Automation check failed")
      }
      var permission = response["result"]
      permission["updatedAt"] = .string(ISO8601DateFormatter().string(from: Date()))
      self.browserPermissions[target] = permission
      try await self.refreshPermissions()
    }
  }
  func openPermissionSettings(_ pane: String) {
    if let url = URL(
      string: "x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)")
    {
      NSWorkspace.shared.open(url)
    }
  }
  func setKeepAwake(_ enabled: Bool) {
    do {
      try preferences.set("keepAwakeEnabled", .bool(enabled))
      keepAwake = enabled
      applyKeepAwake()
      didChange?()
    } catch { self.error = error.localizedDescription }
  }
  private func applyKeepAwake() {
    if awakeAssertion != 0 {
      IOPMAssertionRelease(awakeAssertion)
      awakeAssertion = 0
    }
    if keepAwake {
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn), "Okou Computer Use" as CFString, &awakeAssertion)
      if result != kIOReturnSuccess { error = "Unable to keep this Mac awake" }
    }
  }
  func shutdown() async {
    identityGeneration += 1
    compatibilityTask?.cancel()
    authTask?.cancel()
    identityRefreshTask?.cancel()
    refreshTask?.cancel()
    await host.stop()
    if awakeAssertion != 0 {
      IOPMAssertionRelease(awakeAssertion)
      awakeAssertion = 0
    }
  }
  private func perform(_ work: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true
    error = nil
    didChange?()
    Task {
      defer {
        busy = false
        didChange?()
      }
      do { try await work() } catch { self.error = error.localizedDescription }
    }
  }
}
