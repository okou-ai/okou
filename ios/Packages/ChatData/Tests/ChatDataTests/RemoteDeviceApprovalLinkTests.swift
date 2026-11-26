import ChatData
import Foundation
import Testing

@Test func remoteDeviceApprovalBindsItsChatAndPreservesTheEncodedReason() throws {
  let web = try #require(URL(string: "https://app.okou.ai"))
  let thread = "a0000000-0000-4000-8000-000000000001"
  let device = "b0000000-0000-4000-8000-000000000001"
  let actionID = "c0000000-0000-4000-8000-000000000001"
  let url =
    "\(web)/chats/\(thread)?remoteDeviceApproval=\(device)&reason=Check+build+%2B+test+logs&actionId=\(actionID)&callbackPrompt=Continue+checking+logs&threadId=\(thread)"
  let action = try #require(
    ChatRemoteDeviceApprovalAction.parse(url, webURL: web, threadID: thread))
  #expect(action.deviceID.uuidString.lowercased() == device)
  #expect(action.reason == "Check build + test logs")
  #expect(action.callbackPrompt == "Continue checking logs")
  #expect(ChatRemoteDeviceApprovalAction.parse(url, webURL: web, threadID: actionID) == nil)
  let foreign = url.replacingOccurrences(of: "app.okou.ai", with: "example.com")
  #expect(ChatRemoteDeviceApprovalAction.parse(foreign, webURL: web, threadID: thread) == nil)
}
