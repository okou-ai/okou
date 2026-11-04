import Foundation
import XCTest

/// Real HTTP headers followed by an incomplete body, then a healthy retry.
final class HeartbeatFaultServer {
  let baseURL: URL
  private let process: Process

  init() throws {
    let process = Process()
    self.process = process
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = [
      "-u", "-c",
      #"""
      import http.server, json, socket, struct
      class Handler(http.server.BaseHTTPRequestHandler):
          beats = 0
          def do_POST(self):
              self.rfile.read(int(self.headers.get('Content-Length', '0')))
              host = '00000000-0000-0000-0000-000000000001'
              if self.path.endswith('/register'):
                  body = {'hostId': host, 'connectionGeneration': 1,
                          'commandNotifications': {'channelName': 'test', 'eventName': 'commandsChanged'}}
              elif self.path.endswith('/heartbeat'):
                  Handler.beats += 1
                  if Handler.beats == 1:
                      self.send_response(200)
                      self.send_header('Content-Type', 'application/json')
                      self.send_header('Content-Length', '1000')
                      self.send_header('CF-Ray', 'partial-response-ray')
                      self.send_header('Set-Cookie', 'private-response-cookie')
                      self.end_headers()
                      self.wfile.write(b'{"private-response-body":')
                      self.wfile.flush()
                      self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))
                      self.close_connection = True
                      self.connection.close()
                      return
                  body = {'ok': True, 'hostId': host, 'hasPendingCommands': False}
              else:
                  body = {'ok': True}
              payload = json.dumps(body).encode()
              self.send_response(200)
              self.send_header('Content-Type', 'application/json')
              self.send_header('Content-Length', str(len(payload)))
              self.end_headers()
              self.wfile.write(payload)
          def log_message(self, *args): pass
      server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
      print(server.server_port, flush=True)
      server.serve_forever()
      """#,
    ]
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    do {
      try process.run()
      let port = try XCTUnwrap(
        String(data: output.fileHandleForReading.availableData, encoding: .utf8)?
          .trimmingCharacters(in: .whitespacesAndNewlines))
      baseURL = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)"))
    } catch {
      if process.isRunning {
        process.terminate()
        process.waitUntilExit()
      }
      throw error
    }
  }

  func close() {
    if process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
  }
}
