"""Character rules shared by the addon's bounded JSON readers."""

JSON_WHITESPACE = b" \t\r\n"
JSON_STRING_CONTROL_LIMIT = 0x20
JSON_HEX_BYTES = frozenset(b"0123456789abcdefABCDEF")
JSON_SIMPLE_ESCAPES = b'"\\/bfnrt'
JSON_STRING_ESCAPES = JSON_SIMPLE_ESCAPES + b"u"
SURROGATE_MIN = 0xD800
SURROGATE_MAX = 0xDFFF


def is_json_value_start(byte: int) -> bool:
    return byte in b'{["tfn-' or ord("0") <= byte <= ord("9")


def contains_surrogate(value: str) -> bool:
    return any(SURROGATE_MIN <= ord(char) <= SURROGATE_MAX for char in value)
