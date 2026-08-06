"""Shared optical-transfer wire format.

The image is 800x600 pixels.  Its centered 80x50 grid contains exactly 4,000
8x8 colour blocks.  Two metadata rows (160 colour values) carry a self-
describing header; the remaining 3,836 values carry one Fountain packet.
Each tile carries six bits: four bits from a robust 4x4 symbol and two bits
from a calibrated colour. The symbol and palette are shared with the browser
implementation in ``decoder/static/tile-codec.js``.
"""

from __future__ import annotations

import zlib
from typing import Any, Iterable


FRAME_WIDTH = 800
FRAME_HEIGHT = 600
FRAME_COLS = 80
FRAME_ROWS = 50
BLOCK_SIZE = 8
GRID_OFFSET_X = (FRAME_WIDTH - FRAME_COLS * BLOCK_SIZE) // 2
GRID_OFFSET_Y = (FRAME_HEIGHT - FRAME_ROWS * BLOCK_SIZE) // 2

# Rows 48 and 49 form the metadata strip. The first four data cells are
# reserved for the four grey-scale reference colours on recalibration frames.
METADATA_ROWS = (48, 49)
METADATA_VALUES = FRAME_COLS * len(METADATA_ROWS)
REFERENCE_CELLS = (0, 1, FRAME_COLS, FRAME_COLS + 1)
REFERENCE_VALUES = (0, 21, 42, 63)  # black, dark grey, mid grey, white
DATA_POSITIONS = tuple(
    (col, row)
    for row in range(METADATA_ROWS[0])
    for col in range(FRAME_COLS)
    if row * FRAME_COLS + col not in REFERENCE_CELLS
)
DATA_VALUES = len(DATA_POSITIONS)
BITS_PER_VALUE = 6
PAYLOAD_BYTES = DATA_VALUES * BITS_PER_VALUE // 8

# Use the available frame payload as the Fountain block. This is what makes
# the colour layer materially denser than a small QR payload; a conservative
# receiver can still advertise a lower block size later.
FOUNTAIN_BLOCK_SIZE = PAYLOAD_BYTES
MAX_INDICES = 5
HEADER_BYTES = METADATA_VALUES // 2
MAX_FILE_SIZE = 64 * 1024 * 1024
MAX_SOURCE_BLOCKS = (1 << 16)  # indices are uint16; k is uint32

MAGIC_DATA = b"V4D"
MAGIC_CALIBRATION = b"V4C"
PROTOCOL_VERSION = 1

# Marker geometry is outside the colour grid, so markers never overwrite data.
MARKER_SIZE = 48
MARKER_THICKNESS = 8
MARKER_ANCHORS = {
    "TL": (24, 36),
    "TR": (FRAME_WIDTH - 24, 36),
    "BL": (24, FRAME_HEIGHT - 36),
    "BR": (FRAME_WIDTH - 24, FRAME_HEIGHT - 36),
}
CALIBRATION_GRID = (36, 21)
CALIBRATION_GRID_SIZE = 8


def bytes_to_values(data: bytes, value_count: int | None = None) -> list[int]:
    """Pack a byte stream densely into six-bit tile values."""

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
        values.extend([0] * max(0, value_count - len(values)))
        return values[:value_count]
    return values


def values_to_bytes(values: Iterable[int], byte_count: int | None = None) -> bytes:
    """Unpack dense six-bit tile values back into bytes."""

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
    return bytes(result[:byte_count] if byte_count is not None else result)


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def _write_uint16(buffer: bytearray, offset: int, value: int) -> None:
    buffer[offset : offset + 2] = int(value).to_bytes(2, "big")


def _write_uint32(buffer: bytearray, offset: int, value: int) -> None:
    buffer[offset : offset + 4] = int(value).to_bytes(4, "big")


def _read_uint16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "big")


def _read_uint32(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 4], "big")


def pack_header(
    *,
    session_id: int = 0,
    seq: int = 0,
    k: int = 0,
    block_len: int = FOUNTAIN_BLOCK_SIZE,
    total_len: int = 0,
    file_crc32: int = 0,
    indices: Iterable[int] = (),
    filename: str = "",
    calibration: bool = False,
    # Backwards-compatible aliases for callers from the first prototype.
    file_id: int | None = None,
    packet_index: int | None = None,
    total_packets: int | None = None,
    original_size: int | None = None,
    payload_length: int | None = None,
) -> bytes:
    """Pack the 80-byte metadata header encoded in the bottom two rows."""

    if file_id is not None:
        session_id = file_id
    if packet_index is not None:
        seq = packet_index
    if total_packets is not None:
        k = total_packets
    if original_size is not None:
        total_len = original_size
    if payload_length is not None:
        block_len = payload_length

    if calibration:
        return MAGIC_CALIBRATION + bytes(HEADER_BYTES - len(MAGIC_CALIBRATION))

    chosen = list(dict.fromkeys(int(index) for index in indices))
    if len(chosen) > MAX_INDICES:
        raise ValueError(f"a frame may carry at most {MAX_INDICES} source indices")
    if not 0 <= session_id <= 0xFFFFFFFF:
        raise ValueError("session_id must fit uint32")
    if not 0 <= seq <= 0xFFFFFFFF:
        raise ValueError("seq must fit uint32")
    if not 0 <= k <= 0xFFFFFFFF:
        raise ValueError("k must fit uint32")
    if not 0 <= block_len <= 0xFFFF:
        raise ValueError("block_len must fit uint16")
    if not 0 <= total_len <= 0xFFFFFFFF:
        raise ValueError("total_len must fit uint32")
    if any(not 0 <= index <= 0xFFFF for index in chosen):
        raise ValueError("source indices must fit uint16")

    header = bytearray(HEADER_BYTES)
    header[0:3] = MAGIC_DATA
    header[3] = PROTOCOL_VERSION
    _write_uint32(header, 4, session_id)
    _write_uint32(header, 8, seq)
    _write_uint32(header, 12, k)
    _write_uint16(header, 16, block_len)
    _write_uint32(header, 18, total_len)
    _write_uint32(header, 22, file_crc32)
    header[26] = len(chosen)
    header[27] = 0
    for offset, index in enumerate(chosen):
        _write_uint16(header, 28 + offset * 2, index)

    name = filename.encode("utf-8", errors="replace")[:30]
    header[38] = len(name)
    header[39 : 39 + len(name)] = name
    return bytes(header)


def unpack_header(data: bytes) -> dict[str, Any] | None:
    """Return metadata from a data/calibration header, or ``None``."""

    if len(data) < HEADER_BYTES:
        return None
    if data[:3] == MAGIC_CALIBRATION:
        return {"type": "calibration", "version": data[3]}
    if data[:3] != MAGIC_DATA or data[3] != PROTOCOL_VERSION:
        return None

    degree = data[26]
    if degree > MAX_INDICES:
        return None
    name_len = min(data[38], 30)
    indices = [_read_uint16(data, 28 + offset * 2) for offset in range(degree)]
    return {
        "type": "data",
        "version": data[3],
        "session_id": _read_uint32(data, 4),
        "seq": _read_uint32(data, 8),
        "k": _read_uint32(data, 12),
        "block_len": _read_uint16(data, 16),
        "total_len": _read_uint32(data, 18),
        "file_crc32": _read_uint32(data, 22),
        "degree": degree,
        "indices": indices,
        "filename": data[39 : 39 + name_len].decode("utf-8", errors="replace") or "received_file",
    }
