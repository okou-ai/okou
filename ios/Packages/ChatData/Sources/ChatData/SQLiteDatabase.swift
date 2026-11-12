import Foundation
import SQLite3

struct SQLiteError: Error {
  let code: Int32
  let message: String

  var isCorrupt: Bool {
    let primaryCode = code & 0xff
    return primaryCode == SQLITE_CORRUPT || primaryCode == SQLITE_NOTADB
  }
}

final class SQLiteDatabase {
  private let handle: OpaquePointer

  init(url: URL) throws {
    var opened: OpaquePointer?
    let result = sqlite3_open_v2(
      url.path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
    guard result == SQLITE_OK, let opened else {
      let message =
        opened.map { String(cString: sqlite3_errmsg($0)) } ?? "Unable to open SQLite database"
      if let opened { sqlite3_close(opened) }
      throw SQLiteError(code: result, message: message)
    }
    handle = opened
    sqlite3_busy_timeout(handle, 5_000)
  }

  deinit { sqlite3_close(handle) }

  func transaction<Result>(_ body: () throws -> Result) throws -> Result {
    try execute("BEGIN IMMEDIATE")
    do {
      let result = try body()
      try execute("COMMIT")
      return result
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  func execute(_ sql: String) throws {
    let result = sqlite3_exec(handle, sql, nil, nil, nil)
    guard result == SQLITE_OK else { throw failure(code: result) }
  }

  func prepare(_ sql: String) throws -> SQLiteStatement {
    var statement: OpaquePointer?
    let result = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
    guard result == SQLITE_OK, let statement else { throw failure(code: result) }
    return SQLiteStatement(database: self, handle: statement)
  }

  func failure(code: Int32? = nil) -> SQLiteError {
    SQLiteError(
      code: code ?? sqlite3_extended_errcode(handle),
      message: String(cString: sqlite3_errmsg(handle)))
  }
}

final class SQLiteStatement {
  private let database: SQLiteDatabase
  private let handle: OpaquePointer

  init(database: SQLiteDatabase, handle: OpaquePointer) {
    self.database = database
    self.handle = handle
  }

  deinit { sqlite3_finalize(handle) }

  func bind(_ value: String?, at index: Int32) throws {
    guard let value else {
      try bindNull(at: index)
      return
    }
    let result = value.withCString { pointer in
      sqlite3_bind_text(handle, index, pointer, -1, sqliteTransient)
    }
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func bind(_ value: Int, at index: Int32) throws {
    let result = sqlite3_bind_int64(handle, index, Int64(value))
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func bind(_ value: Data, at index: Int32) throws {
    let result: Int32
    if value.isEmpty {
      result = sqlite3_bind_zeroblob(handle, index, 0)
    } else {
      result = value.withUnsafeBytes { bytes in
        sqlite3_bind_blob(
          handle, index, bytes.baseAddress, Int32(bytes.count), sqliteTransient)
      }
    }
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  private func bindNull(at index: Int32) throws {
    let result = sqlite3_bind_null(handle, index)
    guard result == SQLITE_OK else { throw database.failure(code: result) }
  }

  func step() throws -> Bool {
    let result = sqlite3_step(handle)
    switch result {
    case SQLITE_ROW: return true
    case SQLITE_DONE: return false
    default: throw database.failure(code: result)
    }
  }

  func run() throws {
    guard try !step() else {
      throw SQLiteError(code: SQLITE_CORRUPT, message: "Invalid SQLite column or result")
    }
  }

  func integer(at index: Int32) throws -> Int {
    guard sqlite3_column_type(handle, index) == SQLITE_INTEGER,
      let value = Int(exactly: sqlite3_column_int64(handle, index))
    else { throw SQLiteError(code: SQLITE_CORRUPT, message: "Invalid SQLite column or result") }
    return value
  }

  func optionalInteger(at index: Int32) throws -> Int? {
    sqlite3_column_type(handle, index) == SQLITE_NULL ? nil : try integer(at: index)
  }

  func optionalText(at index: Int32) -> String? {
    guard let pointer = sqlite3_column_text(handle, index) else { return nil }
    return String(cString: pointer)
  }

  func blob(at index: Int32) throws -> Data {
    guard sqlite3_column_type(handle, index) == SQLITE_BLOB else {
      throw SQLiteError(code: SQLITE_CORRUPT, message: "Invalid SQLite column or result")
    }
    let length = Int(sqlite3_column_bytes(handle, index))
    if length == 0 { return Data() }
    guard let bytes = sqlite3_column_blob(handle, index) else {
      throw SQLiteError(code: SQLITE_CORRUPT, message: "Invalid SQLite column or result")
    }
    return Data(bytes: bytes, count: length)
  }

}

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
