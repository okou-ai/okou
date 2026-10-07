import AppKit
import Foundation

// Squirrel.Mac executes this exact resource path in the replacement app on
// macOS 11+, with: ShipIt ___launch___ <installed-app-path>. Keep this bridge
// in every native ZIP that legacy Electron clients can download directly.
guard CommandLine.arguments.count == 3, CommandLine.arguments[1] == "___launch___" else { exit(64) }
let url = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
guard let bundle = Bundle(url: url), bundle.bundleIdentifier == "ai.okou.desktop" else { exit(65) }
let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
var finished = false
var succeeded = false
NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
  succeeded = error == nil
  finished = true
}
let deadline = Date().addingTimeInterval(30)
while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
exit(succeeded ? 0 : 1)
