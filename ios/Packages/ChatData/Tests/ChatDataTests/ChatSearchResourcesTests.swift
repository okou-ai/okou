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
    let workflowWithoutDisplayName = ChatSearchWorkflow(id: "mine", agentId: "agent", name: "mine")
    XCTAssertEqual(workflowWithoutDisplayName.title, "mine")
  }
}
