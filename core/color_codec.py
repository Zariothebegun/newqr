"""Six-bit RGB colour codec used by every 800x600 frame."""

LEVELS = [0, 85, 170, 255]
FRAME_COLS = 80
FRAME_ROWS = 50
BLOCKS_PER_FRAME = FRAME_COLS * FRAME_ROWS
METADATA_BLOCKS = FRAME_COLS * 2
DATA_BLOCKS_PER_FRAME = (FRAME_COLS * (FRAME_ROWS - 2)) - 4
BYTES_PER_FRAME = DATA_BLOCKS_PER_FRAME // 2
BITS_PER_BLOCK = 6


class ColorCodec:
    """Map 0..63 values to four-level RGB colours and back.

    The tile layer uses all six bits. Byte streams are packed across successive
    values, so four colour bits from a tile are never wasted.
    """

    @staticmethod
    def value_to_rgb(value: int) -> tuple[int, int, int]:
        if not 0 <= value <= 63:
            raise ValueError(f"Value must be 0-63, got {value}")
        return LEVELS[value // 16], LEVELS[(value // 4) % 4], LEVELS[value % 4]

    @staticmethod
    def rgb_to_value(r: int, g: int, b: int) -> int:
        return (
            ColorCodec._channel_to_level(r) * 16
            + ColorCodec._channel_to_level(g) * 4
            + ColorCodec._channel_to_level(b)
        )

    @staticmethod
    def _channel_to_level(channel: int) -> int:
        if channel <= 42:
            return 0
        if channel <= 127:
            return 1
        if channel <= 212:
            return 2
        return 3

    @staticmethod
    def bytes_to_values(data: bytes) -> list[int]:
        values: list[int] = []
        buffer = 0
        bits = 0
        for byte in data:
            buffer = (buffer << 8) | byte
            bits += 8
            while bits >= BITS_PER_BLOCK:
                bits -= BITS_PER_BLOCK
                values.append((buffer >> bits) & 0x3F)
        if bits:
            values.append((buffer << (BITS_PER_BLOCK - bits)) & 0x3F)
        return values

    @staticmethod
    def values_to_bytes(values: list[int]) -> bytes:
        result = bytearray()
        buffer = 0
        bits = 0
        for value in values:
            buffer = (buffer << BITS_PER_BLOCK) | (value & 0x3F)
            bits += BITS_PER_BLOCK
            while bits >= 8:
                bits -= 8
                result.append((buffer >> bits) & 0xFF)
        return bytes(result)

    @staticmethod
    def _pack_chunk(data: bytes) -> list[int]:
        return ColorCodec.bytes_to_values(data)

    @staticmethod
    def _unpack_chunk(values: list[int], offset: int, byte_count: int) -> tuple[bytes, int]:
        end = offset + byte_count * 2
        return ColorCodec.values_to_bytes(values[offset:end]), end

    @staticmethod
    def generate_calibration_colors() -> list[tuple[int, int, int]]:
        return [(LEVELS[r], LEVELS[g], LEVELS[b]) for r in range(4) for g in range(4) for b in range(4)]

    @staticmethod
    def test_codec() -> None:
        print("Testing ColorCodec...")
        for value in range(64):
            assert ColorCodec.rgb_to_value(*ColorCodec.value_to_rgb(value)) == value
        for data in [b"Hello", b"Hello, World!", b"A" * 100, bytes(range(256)), b"x", b"xyzw", b""]:
            assert ColorCodec.values_to_bytes(ColorCodec.bytes_to_values(data)) == data
        print("All ColorCodec tests passed!")


if __name__ == "__main__":
    ColorCodec.test_codec()
