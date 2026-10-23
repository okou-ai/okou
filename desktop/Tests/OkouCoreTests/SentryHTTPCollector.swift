import Foundation
import OkouCore
import Sentry
import XCTest

@MainActor
final class SentryHTTPCollector {
  private let directory: URL
  private let process: Process

  init() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = [
      "-u", "-c",
      #"""
      import gzip, http.server, json, pathlib, sys
      root = pathlib.Path(sys.argv[1])
      class Collector(http.server.BaseHTTPRequestHandler):
          def do_POST(self):
              body = self.rfile.read(int(self.headers['Content-Length']))
              if self.headers.get('Content-Encoding') == 'gzip':
                  body = gzip.decompress(body)
              header, _, remaining = body.partition(b'\n')
              envelope = json.loads(header)
              while remaining:
                  line, _, remaining = remaining.partition(b'\n')
                  item = json.loads(line)
                  length = item['length']
                  payload, remaining = remaining[:length], remaining[length:].lstrip(b'\n')
                  if item['type'] == 'event':
                      event = json.loads(payload)
                      target = root / (event['event_id'] + '.json')
                      temporary = target.with_suffix('.tmp')
                      temporary.write_bytes(payload)
                      temporary.replace(target)
                  elif item['type'] == 'attachment':
                      directory = root / envelope['event_id']
                      directory.mkdir(exist_ok=True)
                      target = directory / pathlib.Path(item['filename']).name
                      target.write_bytes(payload)
              self.send_response(200)
              self.send_header('Content-Type', 'application/json')
              self.send_header('Content-Length', '2')
              self.end_headers()
              self.wfile.write(b'{}')
          def log_message(self, *args):
              pass
      server = http.server.HTTPServer(('127.0.0.1', 0), Collector)
      print(server.server_port, flush=True)
      server.serve_forever()
      """#,
      directory.path,
    ]
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    do {
      try process.run()
      let data = output.fileHandleForReading.availableData
      let port = try XCTUnwrap(
        String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines))
      _ = try XCTUnwrap(Int(port), "Sentry collector must announce its listening port")
      DesktopTelemetry.start(
        dsn: "http://public@127.0.0.1:\(port)/42", version: "0.54.1",
        environment: "integration-test", cacheDirectory: directory.appendingPathComponent("cache"))
    } catch {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  func events() throws -> [JSONValue] {
    SentrySDK.flush(timeout: 5)
    return try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil
    )
    .filter { $0.pathExtension == "json" }
    .map { try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: $0)) }
  }

  func expectation(eventCount: Int) -> XCTestExpectation {
    let directory = directory
    return XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in
        let files = try? FileManager.default.contentsOfDirectory(
          at: directory, includingPropertiesForKeys: nil)
        return files?.filter { $0.pathExtension == "json" }.count == eventCount
      }, object: nil)
  }

  func attachments(for event: JSONValue) throws -> [String: Data] {
    SentrySDK.flush(timeout: 5)
    let id = try XCTUnwrap(event["event_id"].string)
    let location = directory.appendingPathComponent(id)
    guard FileManager.default.fileExists(atPath: location.path) else { return [:] }
    let files = try FileManager.default.contentsOfDirectory(
      at: location, includingPropertiesForKeys: nil)
    return try Dictionary(
      uniqueKeysWithValues: files.map { ($0.lastPathComponent, try Data(contentsOf: $0)) })
  }

  func close() throws {
    DesktopTelemetry.close()
    if process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
    try FileManager.default.removeItem(at: directory)
  }
}
