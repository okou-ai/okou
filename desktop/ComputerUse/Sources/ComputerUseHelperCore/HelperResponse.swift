import Foundation

public enum HelperResponseEncodingError: Error {
    case invalidJSONObject
}

/// Keep invalid native results inside the request's failure boundary, not the process boundary.
public func helperResponseData(
    _ response: [String: Any],
    onEncodingFailure: (Error) -> Void
) throws -> Data {
    var object = response
    if !JSONSerialization.isValidJSONObject(object) {
        onEncodingFailure(HelperResponseEncodingError.invalidJSONObject)
        object = [
            "status": "failed",
            "error": [
                "code": "accessibility_unavailable",
                "message": "Native helper returned invalid response data. An action may have been delivered; do not replay automatically.",
            ],
        ]
        object["id"] = response["id"]
        // Parsed request IDs are JSON values. Validate the failure response too before
        // entering Foundation's Objective-C writer, whose exceptions bypass Swift catch.
        guard JSONSerialization.isValidJSONObject(object) else {
            throw HelperResponseEncodingError.invalidJSONObject
        }
    }
    var data = try JSONSerialization.data(withJSONObject: object, options: [])
    data.append(10)
    return data
}
