import Foundation
import OSLog

private final class NativeHelperStandardError: @unchecked Sendable {
  private let lock = NSLock()
  private var byteCount = 0

  func record(_ count: Int) {
    lock.withLock { byteCount = min(65_536, byteCount + count) }
  }

  var summary: String {
    lock.withLock {
      byteCount == 65_536 ? "stderrBytes>=65536" : "stderrBytes=\(byteCount)"
    }
  }

  var count: Int { lock.withLock { byteCount } }
}

public actor NativeProcess {
  private let logger = Logger(subsystem: "ai.okou.desktop", category: "computer-use-helper")
  private let executable: URL
  private let environment: [String: String]
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var errors: FileHandle?
  private var standardError = NativeHelperStandardError()
  private var timeouts: [Int: Task<Void, Never>] = [:]
  private var buffer = Data()
  private var nextReadSequence = 1
  private var queuedReads: [Int: Data] = [:]
  private var queuedReadBytes = 0
  private var readFragments: [NativeHelperReadFragment] = []
  private var receivedBytes = 0
  private var responseStart = 0
  private var omittedReadsThrough = 0
  private var diagnosticWindowStart = ContinuousClock.now
  private var diagnosticsInWindow = 0
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
    let standardError = NativeHelperStandardError()
    let reader = NativeHelperOutputReader()
    child.executableURL = executable
    child.arguments = ["serve"]
    child.environment = ProcessInfo.processInfo.environment.merging(environment) { _, value in value
    }
    child.standardInput = stdin
    child.standardOutput = stdout
    child.standardError = stderr
    stdout.fileHandleForReading.readabilityHandler = { handle in
      let read = reader.read(handle)
      if read.data.isEmpty { handle.readabilityHandler = nil }
      Task { await self.receive(read.data, sequence: read.sequence, generation: current) }
    }
    stderr.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      standardError.record(data.count)
      if data.isEmpty { handle.readabilityHandler = nil }
    }
    child.terminationHandler = { _ in Task { await self.exited(generation: current) } }
    do { try child.run() } catch {
      reportFailure(.launch)
      throw error
    }
    process = child
    input = stdin.fileHandleForWriting
    output = stdout.fileHandleForReading
    errors = stderr.fileHandleForReading
    self.standardError = standardError
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
          reportFailure(.write)
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
  private func receive(_ data: Data, sequence: Int, generation current: Int) {
    guard current == generation else { return }
    // Tasks created by readability callbacks can reach the actor out of read order.
    queuedReads[sequence] = data
    queuedReadBytes += data.count
    if queuedReadBytes + buffer.count > 32 * 1024 * 1024 {
      reportFailure(.responseLimit, responseBytes: queuedReadBytes + buffer.count)
      stop(error: DesktopFailure("result_too_large", "Native helper exceeded the response limit"))
      return
    }
    while let next = queuedReads.removeValue(forKey: nextReadSequence) {
      let readSequence = nextReadSequence
      nextReadSequence += 1
      queuedReadBytes -= next.count
      consume(next, sequence: readSequence)
      guard current == generation else { return }
    }
  }
  private func consume(_ data: Data, sequence: Int) {
    if data.isEmpty {
      output?.readabilityHandler = nil
      return
    }
    readFragments.append(
      NativeHelperReadFragment(sequence: sequence, streamOffset: receivedBytes, byteCount: data.count))
    receivedBytes += data.count
    if readFragments.count > NativeHelperDiagnostics.maximumReadFragments {
      omittedReadsThrough = readFragments.removeFirst().endOffset
    }
    var start = data.startIndex
    while let newline = data[start...].firstIndex(of: 10) {
      buffer.append(data[start..<newline])
      let line = buffer
      buffer = Data()
      start = data.index(after: newline)
      let frameStart = responseStart
      responseStart += line.count + 1
      let response: JSONValue
      let decodeStarted = ContinuousClock.now
      do { response = try JSONDecoder().decode(JSONValue.self, from: line) } catch {
        protocolFailure(
          .invalidJSON, reason: "invalid JSON", response: line, responseStart: frameStart,
          decoderError: error, decodeDurationMs: decodeStarted.duration(to: .now).seconds * 1000)
        return
      }
      guard let number = response["id"].number, let responseId = Int(exactly: number) else {
        protocolFailure(
          .missingRequestID, reason: "missing or invalid request ID", response: line,
          responseStart: frameStart, decoderError: nil,
          decodeDurationMs: decodeStarted.duration(to: .now).seconds * 1000)
        return
      }
      readFragments.removeAll { $0.endOffset <= responseStart }
      timeouts.removeValue(forKey: responseId)?.cancel()
      pending.removeValue(forKey: responseId)?.resume(returning: response)
    }
    buffer.append(data[start...])
  }
  private func protocolFailure(
    _ failure: NativeHelperFailure, reason: String, response: Data, responseStart: Int,
    decoderError: Error?, decodeDurationMs: Double
  ) {
    // Raw app data belongs only in the bounded, event-local Sentry attachments.
    let diagnostics = "responseBytes=\(response.count), \(standardError.summary)"
    let message = "Native helper protocol failure: \(reason) (\(diagnostics))."
    logger.error("\(message, privacy: .public)")
    if diagnosticWindowStart.duration(to: .now) >= .seconds(3600) {
      diagnosticWindowStart = .now
      diagnosticsInWindow = 0
    }
    var attachments: NativeHelperDiagnostics?
    if diagnosticsInWindow < 3 {
      diagnosticsInWindow += 1
      attachments = NativeHelperDiagnostics(
        response: response, reason: failure, generation: generation, pendingIDs: pending.keys.sorted(),
        responseStart: responseStart, reads: readFragments, omittedThrough: omittedReadsThrough,
        decoderError: decoderError, decodeDurationMs: decodeDurationMs)
    }
    reportFailure(failure, responseBytes: response.count, attachments: attachments)
    stop(
      error: DesktopFailure(
        "accessibility_unavailable",
        "\(message) Reconnect Computer Use; do not replay the failed action automatically."))
  }
  private func expire(_ id: Int) {
    guard pending[id] != nil else { return }
    reportFailure(.timeout)
    stop(
      error: DesktopFailure(
        "command_timeout",
        "Native command deadline expired. An action may have been delivered; do not replay automatically."
      ))
  }
  private func cancel(_ id: Int) { if pending[id] != nil { stop(error: CancellationError()) } }
  private func exited(generation current: Int) {
    guard current == generation else { return }
    reportFailure(.unexpectedExit, exitStatus: process?.terminationStatus)
    stop(error: DesktopFailure("accessibility_unavailable", "Native helper exited"))
  }
  private func reportFailure(
    _ reason: NativeHelperFailure, responseBytes: Int? = nil, exitStatus: Int32? = nil,
    attachments: NativeHelperDiagnostics? = nil
  ) {
    DesktopTelemetry.captureHelperFailure(
      reason, pendingRequests: pending.count, stderrBytes: standardError.count,
      responseBytes: responseBytes, exitStatus: exitStatus, attachments: attachments)
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
    standardError = NativeHelperStandardError()
    buffer.removeAll()
    queuedReads.removeAll()
    queuedReadBytes = 0
    nextReadSequence = 1
    readFragments.removeAll()
    receivedBytes = 0
    responseStart = 0
    omittedReadsThrough = 0
    for timeout in timeouts.values { timeout.cancel() }
    timeouts.removeAll()
    let requests = pending
    pending.removeAll()
    for request in requests.values { request.resume(throwing: error) }
  }
}
