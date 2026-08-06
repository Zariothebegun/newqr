"""Shared wire format for the browser sender, video encoder and decoder.

A transfer is a sequence of 640x400 frames made from an 80 by 50 grid of
6-bit colour values.  Each data frame contains 3,680 values (rows 2 through
47), which is exactly 2,760 bytes.  The last grid row contains a 60-byte
header encoded as 80 values.

The format is intentionally small and deterministic so that a file selected
in ``/send/`` can be read by ``/`` using only a camera.  No file contents are
uploaded to the server.
"""

from __future__ import annotations

import zlib
from typing import Any


MAGIC_DATA = b"V3D"
MAGIC_CALIBRATION = b"V3C"
PROTOCOL_VERSION = 1

FRAME_COLS = 80
FRAME_ROWS = 50
DATA_START_ROW = 2
DATA_END_ROW = 48  # exclusive; row 48 is a separator
METADATA_ROW = 49
DATA_ROWS = DATA_END_ROW - DATA_START_ROW
DATA_VALUES = FRAME_COLS * DATA_ROWS
METADATA_VALUES = FRAME_COLS
BITS_PER_VALUE = 6
HEADER_BYTES = 60
PAYLOAD_BYTES = DATA_VALUES * BITS_PER_VALUE // 8
MAX_FILE_SIZE = 64 * 1024 * 1024
MAX_PACKETS = (1 << 24) - 1


def bytes_to_values(data: bytes, value_count: int | None = None) -> list[int]:
    """Pack bytes into most-significant-bit-first 6-bit values.

    When ``value_count`` is supplied, the result is padded with zero values or
    truncated to that exact size.  The sender uses this for both payload and
    metadata rows.
    """

    values: list[int] = []
    buffer = 0
    bits = 0

    for byte in data:
        buffer = (buffer << 8) | byte
        bits += 8
        while bits >= BITS_PER_VALUE:
            bits -= BITS_PER_VALUE
            values.append((buffer >> bits) & 0x3F)

    if bits:
        values.append((buffer << (BITS_PER_VALUE - bits)) & 0x3F)

    if value_count is not None:
        if len(values) < value_count:
            values.extend([0] * (value_count - len(values)))
        return values[:value_count]

    return values


def values_to_bytes(values: list[int], byte_count: int | None = None) -> bytes:
    """Unpack 6-bit values produced by :func:`bytes_to_values`."""

    result = bytearray()
    buffer = 0
    bits = 0

    for value in values:
        buffer = (buffer << BITS_PER_VALUE) | (value & 0x3F)
        bits += BITS_PER_VALUE
        while bits >= 8:
            bits -= 8
            result.append((buffer >> bits) & 0xFF)
            if byte_count is not None and len(result) >= byte_count:
                return bytes(result[:byte_count])

    if byte_count is None:
        return bytes(result)
    return bytes(result[:byte_count])


def crc32(data: bytes) -> int:
    """Return an unsigned CRC-32 suitable for the transfer header."""

    return zlib.crc32(data) & 0xFFFFFFFF


def _write_uint24(buffer: bytearray, offset: int, value: int) -> None:
    buffer[offset : offset + 3] = int(value).to_bytes(3, "big")


def _read_uint24(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 3], "big")


def pack_header(
    *,
    file_id: int,
    packet_index: int,
    total_packets: int,
    original_size: int,
    payload_length: int,
    file_crc32: int,
    filename: str = "",
    calibration: bool = False,
) -> bytes:
    """Create the fixed 60-byte data or calibration header.

    The filename is deliberately limited to 36 UTF-8 bytes: it is only a
    convenience for the receiving device and the transfer remains valid when
    it is truncated.
    """

    if calibration:
        return MAGIC_CALIBRATION + bytes(HEADER_BYTES - len(MAGIC_CALIBRATION))

    if not 0 <= file_id <= 0xFFFFFFFF:
        raise ValueError("file_id must fit in uint32")
    if not 0 <= packet_index <= MAX_PACKETS:
        raise ValueError("packet_index must fit in uint24")
    if not 0 <= total_packets <= MAX_PACKETS:
        raise ValueError("total_packets must fit in uint24")
    if not 0 <= original_size <= 0xFFFFFFFF:
        raise ValueError("original_size must fit in uint32")
    if not 0 <= payload_length <= PAYLOAD_BYTES:
        raise ValueError("payload_length exceeds one frame")

    header = bytearray(HEADER_BYTES)
    header[0:3] = MAGIC_DATA
    header[3] = PROTOCOL_VERSION
    header[4:8] = int(file_id).to_bytes(4, "big")
    _write_uint24(header, 8, packet_index)
    _write_uint24(header, 11, total_packets)
    header[14:18] = int(original_size).to_bytes(4, "big")
    header[18:20] = int(payload_length).to_bytes(2, "big")
    header[20:24] = int(file_crc32 & 0xFFFFFFFF).to_bytes(4, "big")

    name = filename.encode("utf-8", errors="replace")[:36]
    header[24 : 24 + len(name)] = name
    return bytes(header)


def unpack_header(data: bytes) -> dict[str, Any] | None:
    """Parse a 60-byte header, returning ``None`` for an invalid frame."""

    if len(data) < HEADER_BYTES:
        return None

    if data[:3] == MAGIC_CALIBRATION:
        return {"type": "calibration", "version": data[3]}

    if data[:3] != MAGIC_DATA or data[3] != PROTOCOL_VERSION:
        return None

    payload_length = int.from_bytes(data[18:20], "big")
    if payload_length > PAYLOAD_BYTES:
        return None

    filename = data[24:60].rstrip(b"\x00").decode("utf-8", errors="replace")
    return {
        "type": "data",
        "version": data[3],
        "file_id": int.from_bytes(data[4:8], "big"),
        "packet_index": _read_uint24(data, 8),
        "total_packets": _read_uint24(data, 11),
        "original_size": int.from_bytes(data[14:18], "big"),
        "payload_length": payload_length,
        "file_crc32": int.from_bytes(data[20:24], "big"),
        "filename": filename or "received_file",
    }
