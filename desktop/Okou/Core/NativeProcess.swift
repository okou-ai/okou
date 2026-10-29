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
  public enum Purpose: String, Sendable {
    case computerUse = "computer_use"
    case browserAutomationProbe = "browser_automation_probe"
  }

  private struct PendingRequest {
    let continuation: CheckedContinuation<JSONValue, Error>
    var diagnostics: NativeHelperRequestDiagnostics
  }

  private let logger = Logger(subsystem: "ai.okou.desktop", category: "computer-use-helper")
  private let executable: URL
  private let environment: [String: String]
  private let purpose: Purpose
  private let now: @Sendable () -> ContinuousClock.Instant
  private let awakeNow: @Sendable () -> SuspendingClock.Instant
  private var lifetime: NativeHelperLifetime?
  private var input: FileHandle?
  private var output: FileHandle?
  private var errors: FileHandle?
  private var standardError = NativeHelperStandardError()
  private var outputReader: NativeHelperOutputReader
  private var outputProcessedAt: ContinuousClock.Instant?
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
  private var pending: [Int: PendingRequest] = [:]
  private var generation = 0
  private var outputClosed = false
  private var termination: NativeHelperTermination?

  public init(
    executable: URL, environment: [String: String] = [:], purpose: Purpose = .computerUse,
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
    awakeNow: @escaping @Sendable () -> SuspendingClock.Instant = { .now }
  ) {
    self.executable = executable
    self.environment = environment
    self.purpose = purpose
    self.now = now
    self.awakeNow = awakeNow
    outputReader = NativeHelperOutputReader(now: now)
  }
  private func start() throws {
    if lifetime?.isRunning == true { return }
    if let lifetime {
      stop(
        error: DesktopFailure("accessibility_unavailable", "Native helper exited"),
        failure: .unexpectedExit, termination: lifetime.termination)
    }
    generation += 1
    let current = generation
    let child = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    let standardError = NativeHelperStandardError()
    let reader = NativeHelperOutputReader(now: now)
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
    child.terminationHandler = { child in
      let termination = NativeHelperTermination(child)
      Task { await self.exited(generation: current, termination: termination) }
    }
    do {
      // Killing a timed-out helper must turn a blocked write into EPIPE, not kill Desktop.
      guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      try child.run()
    } catch {
      reportFailure(.launch)
      throw error
    }
    lifetime = NativeHelperLifetime(process: child, now: now)
    input = stdin.fileHandleForWriting
    output = stdout.fileHandleForReading
    errors = stderr.fileHandleForReading
    self.standardError = standardError
    outputReader = reader
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
        let diagnostics = NativeHelperRequestDiagnostics(
          values, timeout: timeout, started: now(), awakeStarted: awakeNow())
        pending[id] = PendingRequest(
          continuation: continuation, diagnostics: diagnostics)
        let current = generation
        guard
          lifetime?.watch(
            id, until: diagnostics.deadline,
            onExpiration: {
              Task { await self.expire(id, generation: current) }
            }) == true
        else {
          stop(error: Self.timeoutFailure)
          return
        }
        // Dispatch uses an awake clock. Keep ContinuousClock's timer for system sleep/wake.
        let deadline = diagnostics.deadline
        timeouts[id] = Task {
          do { try await Task.sleep(until: deadline) } catch { return }
          self.expire(id, generation: current)
        }
        do { try input?.write(contentsOf: data) } catch {
          stop(
            error: DesktopFailure("accessibility_unavailable", "Native helper write failed"),
            failure: .write)
          return
        }
        pending[id]?.diagnostics.writtenAt = now()
      }
    } onCancel: {
      Task { await self.cancel(id) }
    }
  }
  private func receive(_ data: Data, sequence: Int, generation current: Int) {
    guard current == generation else { return }
    if lifetime?.expired == true {
      stop(error: Self.timeoutFailure)
      return
    }
    // Tasks created by readability callbacks can reach the actor out of read order.
    queuedReads[sequence] = data
    queuedReadBytes += data.count
    if queuedReadBytes + buffer.count > 32 * 1024 * 1024 {
      stop(
        error: DesktopFailure("result_too_large", "Native helper exceeded the response limit"),
        failure: .responseLimit, responseBytes: queuedReadBytes + buffer.count)
      return
    }
    while let next = queuedReads.removeValue(forKey: nextReadSequence) {
      let readSequence = nextReadSequence
      nextReadSequence += 1
      queuedReadBytes -= next.count
      consume(next, sequence: readSequence, generation: current)
      guard current == generation else { return }
    }
  }
  private func consume(_ data: Data, sequence: Int, generation current: Int) {
    if data.isEmpty {
      outputClosed = true
      if let termination { exited(generation: current, termination: termination) }
      return
    }
    outputProcessedAt = now()
    readFragments.append(
      NativeHelperReadFragment(
        sequence: sequence, streamOffset: receivedBytes, byteCount: data.count))
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
      // A ready response must not bypass the deadline when the client resumes late.
      if lifetime?.complete(responseId) != nil {
        stop(error: Self.timeoutFailure)
        return
      }
      if response["status"].string == "failed",
        response["error"]["code"].string == "target_app_unresponsive"
      {
        // The helper's watchdog cannot cancel an in-flight native operation.
        // Reap it before exposing failure or admitting another command.
        stop(
          error: DesktopFailure(
            "target_app_unresponsive",
            "Native command became unresponsive. An action may have been delivered; do not replay automatically."
          ))
        return
      }
      readFragments.removeAll { $0.endOffset <= responseStart }
      timeouts.removeValue(forKey: responseId)?.cancel()
      pending.removeValue(forKey: responseId)?.continuation.resume(returning: response)
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
        response: response, reason: failure, generation: generation,
        pendingIDs: pending.keys.sorted(),
        responseStart: responseStart, reads: readFragments, omittedThrough: omittedReadsThrough,
        decoderError: decoderError, decodeDurationMs: decodeDurationMs)
    }
    stop(
      error: DesktopFailure(
        "accessibility_unavailable",
        "\(message) Reconnect Computer Use; do not replay the failed action automatically."),
      failure: failure, responseBytes: response.count, attachments: attachments)
  }
  private static var timeoutFailure: DesktopFailure {
    DesktopFailure(
      "command_timeout",
      "Native command deadline expired. An action may have been delivered; do not replay automatically."
    )
  }
  private func expire(_ id: Int, generation current: Int) {
    guard current == generation, lifetime?.expire(id, detectedBy: .timer) != nil else { return }
    stop(error: Self.timeoutFailure)
  }
  private func cancel(_ id: Int) { if pending[id] != nil { stop(error: CancellationError()) } }
  private func exited(generation current: Int, termination: NativeHelperTermination) {
    guard current == generation else { return }
    self.termination = termination
    // A process can exit before its final stdout callbacks reach the actor.
    guard outputClosed else { return }
    stop(
      error: DesktopFailure("accessibility_unavailable", "Native helper exited"),
      failure: .unexpectedExit, termination: termination)
  }
  private func reportFailure(
    _ reason: NativeHelperFailure, responseBytes: Int? = nil,
    termination: NativeHelperTermination? = nil, request: NativeHelperRequestDiagnostics? = nil,
    attachments: NativeHelperDiagnostics? = nil, timeout: NativeHelperTimeoutDiagnostics? = nil
  ) {
    DesktopTelemetry.captureHelperFailure(
      reason, purpose: purpose, generation: generation,
      pendingRequests: pending.count, stderrBytes: standardError.count,
      responseBytes: responseBytes, termination: termination, request: request,
      attachments: attachments, timeout: timeout)
  }
  public func stop() { stop(error: CancellationError()) }
  private func stop(
    error: Error, failure: NativeHelperFailure? = nil, responseBytes: Int? = nil,
    termination: NativeHelperTermination? = nil, attachments: NativeHelperDiagnostics? = nil
  ) {
    // Retirement serializes with the watchdog, so a racing exit/write cannot hide its timeout.
    let expiration = lifetime?.retire()
    var error = error
    if let expiration, let request = pending[expiration.requestID] {
      error = Self.timeoutFailure
      reportFailure(
        .timeout, request: request.diagnostics,
        timeout: NativeHelperTimeoutDiagnostics(
          trigger: expiration.trigger, output: outputReader.snapshot, processedBytes: receivedBytes,
          processedAt: outputProcessedAt, observedAt: now(), awakeObservedAt: awakeNow(),
          detectedAt: expiration.detectedAt, retiredAt: expiration.retiredAt))
    } else if let failure {
      reportFailure(
        failure, responseBytes: responseBytes, termination: termination, attachments: attachments)
    }
    generation += 1
    output?.readabilityHandler = nil
    errors?.readabilityHandler = nil
    try? input?.close()
    lifetime = nil
    input = nil
    output = nil
    errors = nil
    standardError = NativeHelperStandardError()
    outputReader = NativeHelperOutputReader(now: now)
    outputProcessedAt = nil
    buffer.removeAll()
    queuedReads.removeAll()
    queuedReadBytes = 0
    nextReadSequence = 1
    readFragments.removeAll()
    receivedBytes = 0
    responseStart = 0
    omittedReadsThrough = 0
    outputClosed = false
    self.termination = nil
    for timeout in timeouts.values { timeout.cancel() }
    timeouts.removeAll()
    let requests = pending
    pending.removeAll()
    for request in requests.values { request.continuation.resume(throwing: error) }
  }
}
