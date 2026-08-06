"""
VEF-3 CORE - Color Codec
Converts bytes to RGB colors and vice versa using 4 levels per channel (6 bits per block)
"""

# Color levels: 0, 85, 170, 255
LEVELS = [0, 85, 170, 255]

# Number of blocks in frame: 80 cols × 50 rows = 4000 blocks
FRAME_COLS = 80
FRAME_ROWS = 50
BLOCKS_PER_FRAME = FRAME_COLS * FRAME_ROWS

# Data blocks per frame (excluding metadata)
METADATA_BLOCKS = 40
DATA_BLOCKS_PER_FRAME = BLOCKS_PER_FRAME - METADATA_BLOCKS

# Bits per block
BITS_PER_BLOCK = 6  # log2(64) = 6


class ColorCodec:
    """
    Codec that converts bytes to RGB colors and vice versa.
    Uses 4 levels per RGB channel (0, 85, 170, 255) = 64 colors = 6 bits per block.

    Packing scheme:
    - 1 byte (8 bits) -> 2 values (12 bits available)
    - 2 bytes (16 bits) -> 3 values (18 bits available)
    - 3 bytes (24 bits) -> 4 values (24 bits exact)
    - 4 bytes (32 bits) -> 6 values (36 bits available, 4 wasted)
    """

    @staticmethod
    def value_to_rgb(value: int) -> tuple:
        """Convert a 6-bit value (0-63) to RGB color."""
        if not 0 <= value <= 63:
            raise ValueError(f"Value must be 0-63, got {value}")

        r_level = value // 16
        remainder = value % 16
        g_level = remainder // 4
        b_level = remainder % 4

        return (LEVELS[r_level], LEVELS[g_level], LEVELS[b_level])

    @staticmethod
    def rgb_to_value(r: int, g: int, b: int) -> int:
        """Convert RGB color to 6-bit value."""
        r_level = ColorCodec._channel_to_level(r)
        g_level = ColorCodec._channel_to_level(g)
        b_level = ColorCodec._channel_to_level(b)

        return (r_level * 16) + (g_level * 4) + b_level

    @staticmethod
    def _channel_to_level(channel: int) -> int:
        """Convert a channel value (0-255) to a level (0-3)."""
        if channel <= 42:
            return 0
        elif channel <= 127:
            return 1
        elif channel <= 212:
            return 2
        else:
            return 3

    @staticmethod
    def _pack_chunk(data: bytes) -> list:
        """Pack 1-4 bytes into 6-bit values. Returns packed values."""
        if len(data) == 0:
            return []

        byte_count = len(data)
        values = []

        if byte_count == 1:
            # 8 bits -> need 2 values (12 bits available)
            values = [(data[0] >> 2) & 0x3F, data[0] & 0x3F]
        elif byte_count == 2:
            # 16 bits -> need 3 values (18 bits available)
            word = (data[0] << 8) | data[1]
            values = [(word >> 10) & 0x3F, (word >> 4) & 0x3F, word & 0x3F]
        elif byte_count == 3:
            # 24 bits -> need 4 values (24 bits exact)
            word = (data[0] << 16) | (data[1] << 8) | data[2]
            values = [(word >> 18) & 0x3F, (word >> 12) & 0x3F, (word >> 6) & 0x3F, word & 0x3F]
        else:  # byte_count == 4
            # 32 bits -> need 6 values (36 bits available, 4 wasted)
            word = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
            values = [(word >> 26) & 0x3F, (word >> 20) & 0x3F, (word >> 14) & 0x3F,
                      (word >> 8) & 0x3F, (word >> 2) & 0x3F, word & 0x03]

        return values

    @staticmethod
    def _unpack_chunk(values: list, offset: int, byte_count: int) -> tuple:
        """Unpack a chunk. Returns (bytes_data, new_offset)."""
        if offset >= len(values) or byte_count == 0:
            return b'\x00' * byte_count, offset

        result = bytearray()

        if byte_count == 1:
            if offset + 1 >= len(values):
                return b'\x00', offset + 2
            word = ((values[offset] << 2) | (values[offset + 1] & 0x03)) & 0xFF
            result.append(word)
            offset += 2
        elif byte_count == 2:
            if offset + 2 >= len(values):
                return b'\x00\x00', offset + 3
            word = (values[offset] << 10) | (values[offset + 1] << 4) | values[offset + 2]
            result.append((word >> 8) & 0xFF)
            result.append(word & 0xFF)
            offset += 3
        elif byte_count == 3:
            if offset + 3 >= len(values):
                return b'\x00\x00\x00', offset + 4
            word = (values[offset] << 18) | (values[offset + 1] << 12) | (values[offset + 2] << 6) | values[offset + 3]
            result.append((word >> 16) & 0xFF)
            result.append((word >> 8) & 0xFF)
            result.append(word & 0xFF)
            offset += 4
        else:  # byte_count == 4
            if offset + 5 >= len(values):
                return b'\x00\x00\x00\x00', offset + 6
            word = (values[offset] << 26) | (values[offset + 1] << 20) | (values[offset + 2] << 14) | \
                   (values[offset + 3] << 8) | (values[offset + 4] << 2) | values[offset + 5]
            result.append((word >> 24) & 0xFF)
            result.append((word >> 16) & 0xFF)
            result.append((word >> 8) & 0xFF)
            result.append(word & 0xFF)
            offset += 6

        return bytes(result), offset

    @staticmethod
    def bytes_to_values(data: bytes) -> list:
        """
        Convert bytes to a list of 6-bit values.
        Format: [byte_count, ...packed_bytes...] for each chunk of up to 4 bytes
        """
        if len(data) == 0:
            return []

        values = []

        # Process in chunks of up to 4 bytes
        for i in range(0, len(data), 4):
            chunk = data[i:i+4]
            chunk_values = ColorCodec._pack_chunk(chunk)
            # Add byte count as first value
            values.append(len(chunk))
            values.extend(chunk_values)

        return values

    @staticmethod
    def values_to_bytes(values: list) -> bytes:
        """
        Convert a list of 6-bit values back to bytes.
        """
        if not values:
            return b''

        result = bytearray()
        offset = 0

        while offset < len(values):
            byte_count = values[offset]
            offset += 1

            chunk_data, offset = ColorCodec._unpack_chunk(values, offset, byte_count)
            result.extend(chunk_data)

        return bytes(result)

    @staticmethod
    def generate_calibration_colors() -> list:
        """Generate all 64 possible colors for calibration frame."""
        colors = []
        for r in range(4):
            for g in range(4):
                for b in range(4):
                    colors.append((LEVELS[r], LEVELS[g], LEVELS[b]))
        return colors

    @staticmethod
    def test_codec():
        """Test the color codec."""
        print("Testing ColorCodec...")

        # Test round-trip for all 64 values
        for val in range(64):
            rgb = ColorCodec.value_to_rgb(val)
            decoded = ColorCodec.rgb_to_value(*rgb)
            assert decoded == val, f"Failed for value {val}: got {decoded}"

        print("✓ All 64 values round-trip correctly")

        # Test byte encoding/decoding with various sizes
        test_cases = [
            b"Hello",
            b"Hello, World!",
            b"Test data for VEF-3 color codec.",
            b"A" * 100,
            bytes(range(256)),
            b"x",
            b"xy",
            b"xyz",
            b"xyzw",
        ]

        for i, test_data in enumerate(test_cases):
            values = ColorCodec.bytes_to_values(test_data)
            decoded_data = ColorCodec.values_to_bytes(values)

            assert decoded_data == test_data, f"Test case {i+1} failed:\n  Input:  {test_data}\n  Output: {decoded_data}\n  Values: {values}"
            print(f"✓ Test case {i+1}: {len(test_data)} bytes -> {len(values)} values")

        # Test empty input
        empty = ColorCodec.bytes_to_values(b'')
        assert empty == [], "Empty bytes should give empty list"
        empty_decoded = ColorCodec.values_to_bytes([])
        assert empty_decoded == b'', "Empty values should give empty bytes"
        print("✓ Empty input handled correctly")

        # Test that values are in valid range
        for _ in range(5):
            test_data = b"x" * 1000
            values = ColorCodec.bytes_to_values(test_data)
            for v in values:
                assert 0 <= v <= 63, f"Invalid value: {v}"
        print("✓ All values in valid range (0-63)")

        print("\nAll ColorCodec tests passed!")


if __name__ == "__main__":
    ColorCodec.test_codec()
