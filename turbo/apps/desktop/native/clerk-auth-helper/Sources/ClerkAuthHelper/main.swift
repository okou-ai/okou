import AppKit
import ClerkKit
import Foundation

private struct Request: Decodable, Sendable {
    let id: Int
    let command: String
    let organizationId: String?
}

private func reply(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value),
          let newline = "\n".data(using: .utf8) else { return }
    FileHandle.standardOutput.write(data + newline)
}

@MainActor
private func handle(_ request: Request) async {
    let id = request.id
    let command = request.command
    do {
        let clerk = Clerk.shared
        let result: [String: Any]
        switch command {
        case "token":
            // The server's current client state takes precedence over cached identity.
            _ = try await clerk.refreshClient()
            result = ["token": try await clerk.auth.getToken() as Any? ?? NSNull()]
        case "signIn":
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 360, height: 120),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Okou Sign In"
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            defer { window.close() }
            _ = try await clerk.auth.startHostedAuth()
            result = ["token": try await clerk.auth.getToken() as Any? ?? NSNull()]
        case "organizations":
            _ = try await clerk.refreshClient()
            result = ["organizations": (clerk.user?.organizationMemberships ?? []).map { membership in
                ["id": membership.organization.id, "name": membership.organization.name]
            }]
        case "setOrganization":
            guard let sessionId = clerk.session?.id,
                  let organizationId = request.organizationId,
                  !organizationId.isEmpty else {
                throw NSError(domain: "ClerkAuthHelper", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "No active session or organization"])
            }
            try await clerk.auth.setActive(sessionId: sessionId, organizationId: organizationId)
            result = ["token": try await clerk.auth.getToken() as Any? ?? NSNull()]
        case "signOut":
            // Local credentials must disappear even if Clerk cannot be reached.
            do { try await clerk.auth.signOut() } catch {}
            try await Clerk.clearAllKeychainItemsAndWait()
            result = [:]
        default:
            throw NSError(domain: "ClerkAuthHelper", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Unsupported command"])
        }
        reply(["id": id, "result": result])
    } catch {
        reply(["id": id, "error": error.localizedDescription])
    }
}

guard let publishableKey = ProcessInfo.processInfo.environment["OKOU_DESKTOP_CLERK_PUBLISHABLE_KEY"],
      !publishableKey.isEmpty,
      let bundleId = Bundle.main.bundleIdentifier,
      !bundleId.isEmpty else {
    fputs("Clerk auth helper requires a publishable key and an app bundle identity\n", stderr)
    exit(1)
}

_ = signal(SIGPIPE, SIG_IGN)
NSApplication.shared.setActivationPolicy(.accessory)
Clerk.configure(
    publishableKey: publishableKey,
    options: .init(keychainConfig: .init(service: bundleId))
)

DispatchQueue.global(qos: .userInitiated).async {
    var requests: [Task<Void, Never>] = []
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let request = try? JSONDecoder().decode(Request.self, from: data) else {
            continue
        }
        requests.append(Task { @MainActor in await handle(request) })
    }
    Task { @MainActor in
        for request in requests { await request.value }
        NSApplication.shared.terminate(nil)
    }
}
NSApplication.shared.run()
