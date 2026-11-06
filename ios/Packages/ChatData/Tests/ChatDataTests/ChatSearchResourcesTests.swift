import Foundation
import XCTest

@testable import ChatData

final class ChatSearchResourcesTests: XCTestCase {
  func testWorkflowMatchesItsTitleNameOrDescription() {
    let workflow = ChatSearchWorkflow(
      id: "workflow", agentId: "agent", name: "brand-design", displayName: "Brand Design",
      description: "Make Okou posters")
    XCTAssertTrue(workflow.matches(""))
    XCTAssertTrue(workflow.matches("brand"))
    XCTAssertTrue(workflow.matches("poster"))
    XCTAssertFalse(workflow.matches("calendar"))
    XCTAssertEqual(workflow.title, "Brand Design")
  }

  func testBuiltInWorkflowsAreRecognisedSoSearchCanLeaveThemOut() throws {
    let json = """
      [
        {"id": "1", "agentId": "a", "name": "built-in", "displayName": null, "description": null,
         "official": {"definitionName": "built-in", "installationState": "installed",
                      "definitionLifecycle": "active", "readOnly": true}},
        {"id": "2", "agentId": "a", "name": "mine", "displayName": null, "description": null,
         "official": null}
      ]
      """
    let workflows = try JSONDecoder().decode([ChatSearchWorkflow].self, from: Data(json.utf8))
    XCTAssertNotNil(workflows[0].official)
    XCTAssertNil(workflows[1].official)
    XCTAssertEqual(workflows[1].title, "mine")
  }

  func testArtifactDecodesItsPublicAlias() throws {
    let json = """
      {"id": "x", "kind": "hosted-site", "title": "okou-404-options", "thumbnail": null,
       "sourceUrl": "https://dpl-1.sites.vm0.io",
       "aliasUrl": "https://okou-404-options.sites.vm0.io",
       "createdAt": "2026-11-06T00:00:00Z", "updatedAt": "2026-11-06T00:00:00Z"}
      """
    let artifact = try JSONDecoder().decode(ChatSearchArtifact.self, from: Data(json.utf8))
    XCTAssertEqual(artifact.aliasUrl, "https://okou-404-options.sites.vm0.io")
    XCTAssertEqual(artifact.kind, "hosted-site")
  }
}
