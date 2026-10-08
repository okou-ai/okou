import Foundation

public actor NativeProcess {
  private let executable: URL
  private let environment: [String: String]
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var errors: FileHandle?
  private var timeouts: [Int: Task<Void, Never>] = [:]
  private var buffer = Data()
  private var sequence = 0
  private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
  private var generation = 0

  public init(executable: URL, environment: [String: String] = [:]) {
    self.executable = executable
    self.environment = environment
  }
  private func start() throws {
    if process?.isRunning == true { return }
    generation += 1
    let current = generation
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    child.executableURL = executable
    child.arguments = ["serve"]
    child.environment = ProcessInfo.processInfo.environment.merging(environment) { _, value in value
    }
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = stderr
    stdout.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      Task { await self.receive(data, generation: current) }
    }
    stderr.fileHandleForReading.readabilityHandler = { handle in
      if handle.availableData.isEmpty { handle.readabilityHandler = nil }
    }
    child.terminationHandler = { _ in Task { await self.exited(generation: current) } }
    try child.run()
    process = child
    input = stdin.fileHandleForWriting
    output = stdout.fileHandleForReading
    errors = stderr.fileHandleForReading
  }
  public func request(_ values: JSONValue, timeout: TimeInterval = 30) async throws -> JSONValue {
    try Task.checkCancellation()
    try start()
    sequence += 1
    let id = sequence
    var request = values
    request["id"] = .number(Double(id))
    var data = try JSONEncoder().encode(request)
    data.append(10)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[id] = continuation
        do { try input?.write(contentsOf: data) } catch {
          stop(error: DesktopFailure("accessibility_unavailable", "Native helper write failed"))
          return
        }
        timeouts[id] = Task {
          do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
          self.expire(id)
        }
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
  }
  private func receive(_ data: Data, generation current: Int) {
    guard current == generation else { return }
    if data.isEmpty {
      output?.readabilityHandler = nil
      return
    }
    buffer.append(data)
    while let newline = buffer.firstIndex(of: 10) {
      let line = buffer.prefix(upTo: newline)
      buffer.removeSubrange(...newline)
      do {
        let response = try JSONDecoder().decode(JSONValue.self, from: line)
        guard let number = response["id"].number, let responseId = Int(exactly: number) else {
          throw DesktopFailure("accessibility_unavailable", "Native response has no request ID")
        }
        timeouts.removeValue(forKey: responseId)?.cancel()
        pending.removeValue(forKey: responseId)?.resume(returning: response)
      } catch {
        stop(
          error: DesktopFailure("accessibility_unavailable", "Native helper returned invalid JSON"))
      }
    }
    if buffer.count > 32 * 1024 * 1024 {
      stop(error: DesktopFailure("result_too_large", "Native helper exceeded the response limit"))
    }
  }
  private func expire(_ id: Int) {
    guard pending[id] != nil else { return }
    stop(
      error: DesktopFailure(
        "command_timeout",
        "Native command deadline expired. An action may have been delivered; do not replay automatically."
      ))
  }
  private func cancel(_ id: Int) { if pending[id] != nil { stop(error: CancellationError()) } }
  private func exited(generation current: Int) {
    guard current == generation else { return }
    stop(error: DesktopFailure("accessibility_unavailable", "Native helper exited"))
  }
  public func stop() { stop(error: CancellationError()) }
  private func stop(error: Error) {
    generation += 1
    output?.readabilityHandler = nil
    errors?.readabilityHandler = nil
    try? input?.close()
    if let child = process, child.isRunning {
      // Retirement must finish before another helper can dispatch input.
      kill(child.processIdentifier, SIGKILL)
      child.waitUntilExit()
    }
    process = nil
    input = nil
    output = nil
    errors = nil
    buffer.removeAll()
    for timeout in timeouts.values { timeout.cancel() }
    timeouts.removeAll()
    let requests = pending
    pending.removeAll()
    for request in requests.values { request.resume(throwing: error) }
  }
}
