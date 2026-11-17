import Foundation

extension ChatSync {
  static func decode<Value: Decodable>(
    _ type: Value.Type, from data: Data, using decoder: JSONDecoder = APIClient.decoder()
  ) throws -> Value {
    do { return try decoder.decode(type, from: data) } catch {
      throw APIClientError.incompatibleData
    }
  }

  static func rawArray(_ key: String, in data: Data) throws -> [Data] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let values = object[key] as? [Any]
    else { throw APIClientError.incompatibleData }
    return try values.map { value in
      guard JSONSerialization.isValidJSONObject(value) else {
        throw APIClientError.incompatibleData
      }
      return try JSONSerialization.data(withJSONObject: value)
    }
  }

}
