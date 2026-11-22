"""Read the ext4 superblock fields recorded by the native home fixtures."""

import re

SUPERBLOCK_OFFSET = 1024
SUPERBLOCK_BYTES = 1024
MAGIC_HEX = "53ef"
_MAGIC = bytes.fromhex(MAGIC_HEX)
_SUPERBLOCK_HEX = re.compile(rf"[0-9a-f]{{{2 * SUPERBLOCK_BYTES}}}")


def decode_hex(value, message):
    """Decode one whole superblock in its canonical lowercase hex form."""
    if not isinstance(value, str) or not _SUPERBLOCK_HEX.fullmatch(value):
        raise ValueError(message)
    return bytes.fromhex(value)


def has_magic(block):
    return block[56:58] == _MAGIC


def filesystem_uuid(block):
    return block[104:120].hex()
