import Darwin
import Foundation
import ShellProcess

/// Computer-local PTYs. Runs are callers of this owner, never session owners.
public actor ShellSessions {
  public static let capabilities = [
    ComputerUseCommandClaim.Command.Kind.shellCmd.rawValue,
    ComputerUseCommandClaim.Command.Kind.shellList.rawValue,
    ComputerUseCommandClaim.Command.Kind.shellStatus.rawValue,
    ComputerUseCommandClaim.Command.Kind.shellClose.rawValue,
  ]
  private final class Session {
    let id = UUID().uuidString.lowercased()
    let pid: pid_t
    let terminal: Int32
    let metadata: Int32
    let directory: URL
    let initialCwd: String
    var cwd: String
    var phase = "starting"
    var commandState = "unknown"
    var exitCode: Int?
    var shellExitCode: Int?
    var shellExitSignal: Int?
    var closeReason: String?
    var output = Data()
    var endCursor = 0
    var events = Data()
    var activity: ContinuousClock.Instant
    var lastOutput: ContinuousClock.Instant
    var finished: ContinuousClock.Instant?
    var observing = false
    var reaped = false
    var terminalOpen = true
    var metadataOpen = true
    var terminalEndedAt: ContinuousClock.Instant?
    var sources: [Int32: DispatchSourceRead] = [:]
    init(
      pid: pid_t, terminal: Int32, metadata: Int32, directory: URL, cwd: String,
      now: ContinuousClock.Instant
    ) {
      self.pid = pid
      self.terminal = terminal
      self.metadata = metadata
      self.directory = directory
      initialCwd = cwd
      self.cwd = cwd
      activity = now
      lastOutput = now
    }
    var live: Bool { closeReason == nil }
    deinit {
      if live {
        okou_shell_stop(pid, terminalOpen ? terminal : -1, reaped ? 1 : 0)
        for source in sources.values { source.cancel() }
        try? FileManager.default.removeItem(at: directory)
      }
    }
  }
  private var sessions: [String: Session] = [:]
  private var enabled = false
  private var permissionId: String?
  private var configurationRevision = -1
  private var reaper: Task<Void, Never>?
  private let idleTimeout: Duration
  private let now: @Sendable () -> ContinuousClock.Instant
  private let home: URL
  private let maximumOutput = 1024 * 1024
  private let maximumRead = 32 * 1024

  public init(
    home: URL = FileManager.default.homeDirectoryForCurrentUser,
    idleTimeout: Duration = .seconds(900),
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }
  ) {
    self.home = home
    self.idleTimeout = idleTimeout
    self.now = now
  }

  /// A fresh permission identity prevents pre-disable queued input from reviving.
  public func configure(permissionId: String?, revision: Int, reason: String = "permission_retired")
  {
    guard revision > configurationRevision else { return }
    configurationRevision = revision
    guard self.permissionId != permissionId else { return }
    closeAll(reason: reason)
    // Closed output belongs to the retired authority too. Keep no buffers or
    // tombstones that a replacement account/workspace could address by ID.
    sessions.removeAll()
    reaper?.cancel()
    reaper = nil
    self.permissionId = permissionId
    enabled = permissionId != nil
  }
  public func stop(reason: String = "host_stopped") { closeAll(reason: reason) }
  public func count() -> Int { sessions.values.filter(\.live).count }

  public func execute(
    kind: ComputerUseCommandClaim.Command.Kind, payload: ComputerUseCommandClaim.Command.Payload,
    budget: TimeInterval
  ) async -> JSONValue {
    do {
      guard enabled, let permissionId, payload.shellPermissionId == permissionId else {
        throw DesktopFailure(
          "permission_denied", "Shell Access is disabled or its permission changed")
      }
      reap()
      switch kind {
      case .shellList:
        return try success(
          .init(sessions: sessions.values.filter(\.live).sorted { $0.id < $1.id }.map(info)))
      case .shellStatus:
        return try success(.init(session: info(try selected(payload))))
      case .shellClose:
        if payload.all == true {
          closeAll(reason: "closed")
          return try success(.init(closed: true))
        }
        let session = try selected(payload)
        close(session, reason: "closed")
        return try success(.init(session: info(session)))
      case .shellCmd:
        return try await interact(payload, budget: budget)
      default: throw DesktopFailure("unsupported_command", "Unsupported Shell operation")
      }
    } catch let error as DesktopFailure { return error.response } catch is CancellationError {
      return DesktopFailure(
        "command_timeout", "Observation cancelled; input may have been delivered. Do not replay it."
      ).response
    } catch {
      return DesktopFailure("shell_unavailable", error.localizedDescription).response
    }
  }

  private func selected(_ payload: ComputerUseCommandClaim.Command.Payload) throws -> Session {
    guard let id = payload.sessionId, let session = sessions[id] else {
      throw DesktopFailure(
        "shell_unavailable", "Session unavailable; use shell list to inspect this computer")
    }
    return session
  }
  private func interact(_ payload: ComputerUseCommandClaim.Command.Payload, budget: TimeInterval)
    async throws -> JSONValue
  {
    let started = now()
    let command = payload.command
    let input = payload.input
    let key = payload.key
    guard [command, input, key].compactMap({ $0 }).count <= 1 else {
      throw DesktopFailure("invalid_arguments", "Command, input and key are mutually exclusive")
    }
    let live = sessions.values.filter(\.live)
    let session: Session
    if payload.sessionId != nil {
      guard payload.newSession != true, payload.cwd == nil else {
        throw DesktopFailure("invalid_arguments", "Use cwd only when creating a session")
      }
      session = try selected(payload)
    } else if payload.newSession == true || live.isEmpty {
      guard command != nil else {
        throw DesktopFailure("invalid_arguments", "Creating a session requires a command")
      }
      session = try create(cwd: payload.cwd)
    } else {
      guard live.count == 1, let existing = live.first else {
        throw DesktopFailure(
          "invalid_arguments", "Multiple sessions; select an exact ID with --session")
      }
      guard payload.cwd == nil else {
        throw DesktopFailure(
          "invalid_arguments", "Use --new with --cwd, or cd in the existing session")
      }
      session = existing
    }
    guard session.live else {
      return try reply(session, cursor: payload.cursor ?? 0, reason: "session_closed")
    }
    guard !session.observing else {
      throw DesktopFailure(
        "shell_busy",
        "Another interaction is observing this session; retry observation after it returns")
    }
    if command != nil && session.phase != "ready" && session.phase != "starting" {
      throw DesktopFailure(
        "shell_busy", "A command is active; send --input/--key or observe without a new command")
    }
    session.observing = true
    session.activity = now()
    defer {
      session.observing = false
      session.activity = now()
    }
    let wait = min(
      30, max(0, payload.waitMs.map { Double($0) / 1000 } ?? 10), max(0, budget - 0.25))
    let deadline = started.advanced(by: .seconds(wait))
    while session.live && session.phase == "starting" && now() < deadline {
      try await Task.sleep(for: .milliseconds(10))
      drain(session)
    }
    guard session.live, session.phase != "starting" else {
      if session.live { close(session, reason: "shell_initialization_failed") }
      throw DesktopFailure(
        "shell_unavailable",
        "Shell initialization failed; command input was not delivered. Check your zsh startup configuration."
      )
    }
    let cursor =
      payload.cursor
      ?? (command != nil || input != nil || key != nil ? session.endCursor : 0)
    guard cursor >= 0, cursor <= session.endCursor else {
      throw DesktopFailure("invalid_arguments", "Invalid output cursor; no input was delivered")
    }
    if let command {
      guard session.phase == "ready" else {
        throw DesktopFailure(
          "shell_busy", "A command is active; send --input/--key or observe without a new command")
      }
      // Source a private file so large commands and literal newlines do not
      // encounter the terminal's canonical input line limit.
      let file = session.directory.appendingPathComponent("command-\(UUID().uuidString).zsh")
      try command.write(to: file, atomically: true, encoding: .utf8)
      session.phase = "running"
      session.commandState = "running"
      session.exitCode = nil
      session.finished = nil
      try await send(Data("builtin source '\(file.path)'\n".utf8), to: session, deadline: deadline)
    } else if let input {
      prepareInput(session)
      try await send(Data(input.utf8), to: session, deadline: deadline)
    } else if let key {
      let keys: [String: UInt8] = [
        "Ctrl+C": 3, "Ctrl+D": 4, "Ctrl+Z": 26, "Enter": 13, "Escape": 27, "Tab": 9,
      ]
      guard let byte = keys[key] else {
        throw DesktopFailure("invalid_arguments", "Unsupported terminal key")
      }
      prepareInput(session)
      try await send(Data([byte]), to: session, deadline: deadline)
    }
    while session.live && now() < deadline {
      try Task.checkCancellation()
      drain(session)
      let instant = now()
      if let finished = session.finished, finished.duration(to: instant) >= .milliseconds(50) {
        return try reply(session, cursor: cursor, reason: "command_completed")
      }
      if session.endCursor > cursor, session.commandState != "completed",
        session.lastOutput.duration(to: instant) >= .milliseconds(300)
      {
        return try reply(session, cursor: cursor, reason: "output_idle")
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    drain(session)
    return try reply(
      session, cursor: cursor, reason: session.live ? "wait_elapsed" : "session_closed")
  }

  private func prepareInput(_ session: Session) {
    // An old precmd event cannot complete newly submitted input. Keep partial
    // shell lines separate from a new command until a fresh hook confirms ready.
    session.finished = nil
    if session.phase == "ready" {
      session.phase = "input"
      session.commandState = "unknown"
      session.exitCode = nil
    }
  }

  private func create(cwd: String?) throws -> Session {
    guard sessions.values.filter(\.live).count < 8 else {
      throw DesktopFailure("shell_unavailable", "Session limit reached; close an unused session")
    }
    if let cwd, !cwd.hasPrefix("/") {
      throw DesktopFailure("invalid_arguments", "Initial working directory must be absolute")
    }
    let working = cwd.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? home
    var isDirectory: ObjCBool = false
    guard working.path.hasPrefix("/"),
      FileManager.default.fileExists(atPath: working.path, isDirectory: &isDirectory),
      isDirectory.boolValue
    else {
      throw DesktopFailure(
        "invalid_arguments", "Initial working directory must be an existing absolute Mac directory")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "okou-shell-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    do {
      // Load the user's interactive configuration, then install explicit metadata
      // hooks on a separate FD. Terminal output never grants permission.
      let rc = #"""
        zmodload zsh/system || return 1
        sysopen -w -o cloexec -u _okou_shell_events /dev/fd/3 || return 1
        exec 3>&-
        if [[ -r "$OKOU_SHELL_HOME/.zshrc" ]]; then
          ZDOTDIR="$OKOU_SHELL_HOME" source "$OKOU_SHELL_HOME/.zshrc"
        fi
        # This headless PTY receives complete command files, not a visual editor.
        # Keep wrapper paths out of terminal output and the user's shell history.
        unset HISTFILE ZDOTDIR OKOU_SHELL_HOME
        unsetopt ZLE
        /bin/stty -echo
        zmodload zsh/parameter
        function _okou_shell_ready() {
          local code=$?
          local phase=ready
          if (( code > 128 )) && [[ "${(j: :)jobstates}" == *suspended* ]]; then
            phase=ready_unknown
          fi
          builtin printf '%s\0%s\0%s\0' "$phase" "$code" "$PWD" >&$_okou_shell_events
        }
        function _okou_shell_start() {
          builtin printf '%s\0%s\0%s\0' start 0 "$PWD" >&$_okou_shell_events
        }
        precmd_functions=(_okou_shell_ready ${precmd_functions:#_okou_shell_ready})
        preexec_functions=(_okou_shell_start ${preexec_functions:#_okou_shell_start})
        PROMPT='%# '
        RPROMPT=''
        """#
      try rc.write(
        to: directory.appendingPathComponent(".zshrc"), atomically: true, encoding: .utf8)
      let environment = [
        "HOME=\(home.path)", "OKOU_SHELL_HOME=\(home.path)", "ZDOTDIR=\(directory.path)",
        "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "TERM=xterm-256color", "LANG=en_US.UTF-8", "SHELL=/bin/zsh",
        "USER=\(NSUserName())", "LOGNAME=\(NSUserName())",
      ]
      let allocated = environment.map { strdup($0) }
      defer { for pointer in allocated { free(pointer) } }
      var pointers = allocated + [nil]
      var terminal: Int32 = -1
      var metadata: Int32 = -1
      let pid = working.path.withCString { cwd in
        pointers.withUnsafeMutableBufferPointer {
          okou_shell_spawn(cwd, $0.baseAddress, &terminal, &metadata)
        }
      }
      guard pid > 0 else { throw DesktopFailure("shell_unavailable", "Unable to create a PTY") }
      let session = Session(
        pid: pid, terminal: terminal, metadata: metadata, directory: directory, cwd: working.path,
        now: now())
      sessions[session.id] = session
      for fd in [terminal, metadata] {
        let source = DispatchSource.makeReadSource(
          fileDescriptor: fd, queue: .global(qos: .utility))
        let id = session.id
        source.setEventHandler { [weak self] in Task { [weak self] in await self?.received(id) } }
        source.setCancelHandler { Darwin.close(fd) }
        session.sources[fd] = source
        source.resume()
      }
      if reaper == nil {
        reaper = Task { [weak self] in
          while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            if let self { await self.reap() } else { return }
          }
        }
      }
      return session
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  private func send(_ data: Data, to session: Session, deadline: ContinuousClock.Instant)
    async throws
  {
    var offset = 0
    while offset < data.count {
      try Task.checkCancellation()
      guard session.live, enabled else {
        throw DesktopFailure(
          "permission_denied", "Session authority retired; input may have been delivered")
      }
      guard session.terminalOpen else {
        throw DesktopFailure(
          "shell_unavailable", "PTY closed; input may have been delivered. Do not replay it.")
      }
      let count = data.withUnsafeBytes { bytes in
        Darwin.write(session.terminal, bytes.baseAddress!.advanced(by: offset), data.count - offset)
      }
      if count > 0 {
        offset += count
        continue
      }
      if count < 0 && errno != EAGAIN && errno != EINTR {
        throw DesktopFailure(
          "shell_unavailable", "PTY write failed; input may have been delivered. Do not replay it.")
      }
      guard now() < deadline else {
        throw DesktopFailure(
          "command_timeout", "Input delivery timed out; do not replay partial input")
      }
      try await Task.sleep(for: .milliseconds(5))
    }
  }
  private func received(_ id: String) {
    guard let session = sessions[id], session.live else { return }
    drain(session)
  }
  private func read(_ fd: Int32) -> (data: Data, ended: Bool) {
    var result = Data()
    var bytes = [UInt8](repeating: 0, count: 8192)
    // Bound one drain to keep command, stop, and permission callbacks responsive.
    for _ in 0..<32 {
      let count = Darwin.read(fd, &bytes, bytes.count)
      if count == 0 { return (result, true) }
      if count < 0 {
        if errno == EINTR { continue }
        return (result, errno != EAGAIN)
      }
      result.append(contentsOf: bytes.prefix(count))
    }
    return (result, false)
  }
  private func drain(_ session: Session) {
    guard session.live else { return }
    let output = session.terminalOpen ? read(session.terminal) : (data: Data(), ended: false)
    if !output.data.isEmpty {
      session.output.append(output.data)
      session.endCursor += output.data.count
      session.lastOutput = now()
      if session.output.count > maximumOutput {
        session.output = Data(session.output.suffix(maximumOutput))
      }
    }
    if output.ended {
      session.terminalOpen = false
      session.terminalEndedAt = now()
      session.sources.removeValue(forKey: session.terminal)?.cancel()
    }
    if session.metadataOpen {
      let metadata = read(session.metadata)
      session.events.append(metadata.data)
      if metadata.ended {
        session.metadataOpen = false
        session.sources.removeValue(forKey: session.metadata)?.cancel()
      }
    }
    while let first = session.events.firstIndex(of: 0),
      let second = session.events[(first + 1)...].firstIndex(of: 0),
      let third = session.events[(second + 1)...].firstIndex(of: 0)
    {
      let phase = String(decoding: session.events[..<first], as: UTF8.self)
      let code = String(decoding: session.events[(first + 1)..<second], as: UTF8.self)
      let cwd = String(decoding: session.events[(second + 1)..<third], as: UTF8.self)
      session.events = Data(session.events.dropFirst(third + 1))
      if ["ready", "ready_unknown"].contains(phase), let exit = Int(code), cwd.hasPrefix("/") {
        let wasStarting = session.phase == "starting"
        session.phase = "ready"
        session.cwd = cwd
        if !wasStarting {
          session.commandState = phase == "ready" ? "completed" : "unknown"
          session.exitCode = phase == "ready" ? exit : nil
          session.finished = phase == "ready" ? now() : nil
        }
        // Command files are private to one serialized foreground command.
        if let files = try? FileManager.default.contentsOfDirectory(
          at: session.directory, includingPropertiesForKeys: nil)
        {
          for file in files where file.lastPathComponent.hasPrefix("command-") {
            try? FileManager.default.removeItem(at: file)
          }
        }
      } else if phase == "start" {
        session.phase = "running"
        session.commandState = "running"
        session.exitCode = nil
        session.finished = nil
      } else {
        session.commandState = "unknown"
      }
    }
    if session.events.count > 64 * 1024 {
      close(session, reason: "invalid_shell_metadata")
      return
    }
    if !session.metadataOpen {
      if session.phase == "starting" {
        close(session, reason: "shell_initialization_failed")
        return
      }
      // exec may replace zsh with an interactive program. Keep the PTY usable,
      // but never treat missing shell integration as command completion.
      session.phase = "unavailable"
      session.commandState = "unknown"
      session.exitCode = nil
      session.finished = nil
    }
    var code: Int32 = 0
    var signal: Int32 = 0
    let exited = okou_shell_exit(session.pid, &code, &signal)
    if exited != 0 {
      session.reaped = true
      session.shellExitSignal = signal == 0 ? nil : Int(signal)
      session.shellExitCode = exited < 0 || code < 0 ? nil : Int(code)
      close(session, reason: "shell_exited")
    } else if let ended = session.terminalEndedAt, ended.duration(to: now()) >= .milliseconds(100) {
      close(session, reason: "terminal_closed")
    }
  }
  private func reap() {
    let instant = now()
    for session in sessions.values where session.live {
      drain(session)
      if !session.observing, session.activity.duration(to: instant) >= idleTimeout {
        close(session, reason: "idle_timeout")
      }
    }
    let retained = Set(
      sessions.values.filter { !$0.live }
        .sorted { $0.activity > $1.activity }.prefix(16).map(\.id))
    sessions = sessions.filter { id, session in
      session.live
        || (retained.contains(id)
          && session.activity.duration(to: instant) < idleTimeout + .seconds(300))
    }
    if sessions.isEmpty {
      reaper?.cancel()
      reaper = nil
    }
  }
  private func closeAll(reason: String) {
    for session in sessions.values where session.live { close(session, reason: reason) }
  }
  private func close(_ session: Session, reason: String) {
    guard session.live else { return }
    session.closeReason = reason
    session.phase = "closed"
    if session.commandState == "running" { session.commandState = "unknown" }
    okou_shell_stop(
      session.pid, session.terminalOpen ? session.terminal : -1, session.reaped ? 1 : 0)
    session.reaped = true
    for source in session.sources.values { source.cancel() }
    session.sources.removeAll()
    try? FileManager.default.removeItem(at: session.directory)
  }
  private func info(_ session: Session) -> ComputerUseShellResult.Session {
    .init(
      id: session.id, state: .init(rawValue: session.live ? "open" : "closed"),
      initialCwd: session.initialCwd, cwd: session.cwd,
      commandState: .init(rawValue: session.commandState), exitCode: session.exitCode,
      shellExitCode: session.shellExitCode, shellExitSignal: session.shellExitSignal,
      closeReason: session.closeReason, oldestCursor: session.endCursor - session.output.count,
      endCursor: session.endCursor,
      idleRemainingSeconds: session.live
        ? max(0, (idleTimeout - session.activity.duration(to: now())).seconds) : 0,
      cols: 120, rows: 40)
  }
  private func reply(_ session: Session, cursor requested: Int?, reason: String) throws -> JSONValue
  {
    let oldest = session.endCursor - session.output.count
    guard let cursor = requested, cursor >= 0,
      cursor <= session.endCursor
    else {
      return DesktopFailure("invalid_arguments", "Invalid output cursor").response
    }
    let start = max(oldest, cursor)
    let end = min(session.endCursor, start + maximumRead)
    let bytes = session.output.subdata(in: (start - oldest)..<(end - oldest))
    return try success(
      .init(
        session: info(session), outputBase64: bytes.base64EncodedString(), nextCursor: end,
        lostBytes: max(0, oldest - cursor), moreAvailable: end < session.endCursor,
        reason: .init(rawValue: end < session.endCursor ? "output_limit" : reason)))
  }

  private func success(_ result: ComputerUseShellResult) throws -> JSONValue {
    .object(["status": .string("succeeded"), "result": try JSONValue(encoding: result)])
  }
}
