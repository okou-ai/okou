import Foundation
import Testing

@testable import ComputerUseHelperCore

struct HelperResponseTests {
    @Test(arguments: [Double.infinity, -Double.infinity, Double.nan])
    func returnsCorrelatedFailureForInvalidNativeResultsAndEncodesNextResponse(_ value: Double) throws {
        let invalidResponse: [String: Any] = [
            "id": 1,
            "status": "succeeded",
            "result": [
                "elements": [[
                    "id": "w0.e0",
                    "bounds": ["x": value, "y": 20, "width": 100, "height": 50],
                ]],
            ],
        ]
        let nextResponse: [String: Any] = [
            "id": 2,
            "status": "succeeded",
            "result": ["accessibility": true, "screenRecording": false],
        ]

        var stream = Data()
        for response in [invalidResponse, nextResponse] {
            stream.append(try helperResponseData(response, onEncodingFailure: { _ in }))
        }
        let lines = stream.split(separator: 10)
        try #require(lines.count == 2)
        #expect(stream.last == 10)

        let failed = try #require(
            JSONSerialization.jsonObject(with: Data(lines[0])) as? [String: Any]
        )
        #expect(failed["id"] as? Int == 1)
        #expect(failed["status"] as? String == "failed")
        let error = try #require(failed["error"] as? [String: Any])
        #expect(error["code"] as? String == "accessibility_unavailable")
        #expect((error["message"] as? String)?.contains("do not replay automatically") == true)

        let succeeded = try #require(
            JSONSerialization.jsonObject(with: Data(lines[1])) as? [String: Any]
        )
        #expect(succeeded["id"] as? Int == 2)
        #expect(succeeded["status"] as? String == "succeeded")
        let result = try #require(succeeded["result"] as? [String: Any])
        #expect(result["accessibility"] as? Bool == true)
        #expect(result["screenRecording"] as? Bool == false)
    }

    @Test
    func preservesStringRequestIDAndValidResult() throws {
        let data = try helperResponseData(
            ["id": "snapshot", "status": "succeeded", "result": ["text": "First\nSecond"]],
            onEncodingFailure: { _ in }
        )
        let response = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(response["id"] as? String == "snapshot")
        #expect(response["status"] as? String == "succeeded")
        let result = try #require(response["result"] as? [String: Any])
        #expect(result["text"] as? String == "First\nSecond")
        #expect(data.split(separator: 10).count == 1)
    }
}
