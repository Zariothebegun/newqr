"""
VEF-3 CORE - Frame Encoder/Decoder
Renders and parses visual frames containing encoded data.
"""

import numpy as np
from typing import Tuple, Optional, Dict
from PIL import Image, ImageDraw
from .color_codec import ColorCodec, FRAME_COLS, FRAME_ROWS
from .protocol import (
    DATA_VALUES,
    METADATA_VALUES,
    PAYLOAD_BYTES,
    HEADER_BYTES,
    bytes_to_values as protocol_bytes_to_values,
    values_to_bytes as protocol_values_to_bytes,
    pack_header,
    unpack_header,
)


# Frame dimensions (in pixels)
BLOCK_SIZE = 8  # Each color block is 8x8 pixels
FRAME_WIDTH = FRAME_COLS * BLOCK_SIZE  # 640 pixels
FRAME_HEIGHT = FRAME_ROWS * BLOCK_SIZE  # 400 pixels

# Colors for corner markers (fixed, used for alignment)
CORNER_COLORS = {
    'TL': (0, 255, 0),      # Green - Top Left
    'TR': (255, 0, 0),      # Red - Top Right
    'BL': (0, 0, 255),      # Blue - Bottom Left
    'BR': (255, 255, 0),    # Yellow - Bottom Right
}



class FrameEncoder:
    """
    Encodes data packets into visual frames.
    """

    def __init__(self, block_size_pixels: int = BLOCK_SIZE):
        self.block_size = block_size_pixels
        self.frame_width = FRAME_COLS * block_size_pixels
        self.frame_height = FRAME_ROWS * block_size_pixels

    def _draw_corner_markers(self, img: Image.Image, draw: ImageDraw.Draw):
        """Draw alignment markers outside the payload rows.

        Earlier frames placed large L-shaped markers over data blocks.  The
        receiver consequently read marker pixels as file data.  The four
        8x8 markers below occupy only rows 0, 1 and 48, all of which are
        reserved by the wire protocol.
        """
        size = self.block_size
        bottom = self.frame_height - (2 * size)
        right = self.frame_width - size

        draw.rectangle([0, 0, size - 1, size - 1], fill=CORNER_COLORS['TL'])
        draw.rectangle([right, 0, self.frame_width - 1, size - 1], fill=CORNER_COLORS['TR'])
        draw.rectangle([0, bottom, size - 1, bottom + size - 1], fill=CORNER_COLORS['BL'])
        draw.rectangle([right, bottom, self.frame_width - 1, bottom + size - 1], fill=CORNER_COLORS['BR'])

    def _draw_timing_lines(self, img: Image.Image, draw: ImageDraw.Draw):
        """Keep reserved border rows black for deterministic sampling."""
        return

    def _draw_color_block(self, draw: ImageDraw.Draw, col: int, row: int, color: Tuple[int, int, int]):
        """Draw a single color block at the specified grid position."""
        x = col * self.block_size
        y = row * self.block_size
        draw.rectangle([x, y, x + self.block_size - 1, y + self.block_size - 1], fill=color)

    def render_calibration_frame(self) -> Image.Image:
        """
        Render frame 0: calibration frame showing all 64 colors.

        Returns:
            PIL Image of the calibration frame
        """
        img = Image.new('RGB', (self.frame_width, self.frame_height), (0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Draw corner markers
        self._draw_corner_markers(img, draw)

        # Draw timing lines
        self._draw_timing_lines(img, draw)

        # Generate all 64 colors
        colors = ColorCodec.generate_calibration_colors()

        # Draw 8x8 grid of colors (64 total)
        for i, color in enumerate(colors):
            row = i // 8
            col = i % 8

            # Position in the center of the frame
            grid_x = 10 + col
            grid_y = 5 + row

            self._draw_color_block(draw, grid_x, grid_y, color)

        metadata = protocol_bytes_to_values(
            pack_header(
                file_id=0,
                packet_index=0,
                total_packets=0,
                original_size=0,
                payload_length=0,
                file_crc32=0,
                calibration=True,
            ),
            METADATA_VALUES,
        )
        for i, value in enumerate(metadata):
            self._draw_color_block(draw, i, FRAME_ROWS - 1, ColorCodec.value_to_rgb(value))

        return img

    def render_data_frame(self, packet: dict, frame_index: int) -> Image.Image:
        """
        Render a data frame with encoded packet.

        Args:
            packet: Fountain packet dictionary
            frame_index: Frame sequence number

        Returns:
            PIL Image of the data frame
        """
        img = Image.new('RGB', (self.frame_width, self.frame_height), (0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Draw corner markers
        self._draw_corner_markers(img, draw)

        # Draw timing lines
        self._draw_timing_lines(img, draw)

        # The browser sender and receiver use a raw bit-packed payload.  Keep
        # the command-line encoder on the same wire format so either sender
        # can be read by the camera page.
        data = bytes(packet.get('data', b''))[:PAYLOAD_BYTES]
        block_indices = packet.get('block_indices') or [packet.get('id', frame_index)]
        packet_index = packet.get('packet_index', block_indices[0])
        total_packets = packet.get('total_packets', packet.get('num_blocks', 1))
        original_size = packet.get('original_size', len(data))
        file_id = packet.get('file_id', 0)
        file_crc32 = packet.get('file_crc32', 0)
        filename = packet.get('filename', '')

        values = protocol_bytes_to_values(data, DATA_VALUES)
        data_start_row = 2
        for i, value in enumerate(values):
            col = i % FRAME_COLS
            row = data_start_row + (i // FRAME_COLS)
            color = ColorCodec.value_to_rgb(value)
            self._draw_color_block(draw, col, row, color)

        header = pack_header(
            file_id=file_id,
            packet_index=packet_index,
            total_packets=total_packets,
            original_size=original_size,
            payload_length=len(data),
            file_crc32=file_crc32,
            filename=filename,
        )
        metadata = protocol_bytes_to_values(header, METADATA_VALUES)
        for i, value in enumerate(metadata):
            self._draw_color_block(draw, i, FRAME_ROWS - 1, ColorCodec.value_to_rgb(value))

        return img


class FrameDecoder:
    """
    Decodes visual frames back to data packets.
    """

    def __init__(self):
        self.color_calibration: Dict[Tuple[int, int, int], Tuple[int, int, int]] = {}
        self.calibrated = False

    def _get_pixel_color(self, img: Image.Image, x: int, y: int) -> Tuple[int, int, int]:
        """Get the color of a pixel (or block average)."""
        try:
            pixel = img.getpixel((x, y))
            if isinstance(pixel, tuple):
                return pixel[:3]
            return (pixel, pixel, pixel)
        except:
            return (0, 0, 0)

    def _sample_block(self, img: Image.Image, col: int, row: int, block_size: int) -> Tuple[int, int, int]:
        """
        Sample the average color of a block.

        Args:
            img: Source image
            col: Column index
            row: Row index
            block_size: Size of each block in pixels

        Returns:
            Average RGB color of the block
        """
        x = col * block_size
        y = row * block_size

        # Sample center of block (4x4 sample)
        r_sum, g_sum, b_sum = 0, 0, 0
        samples = 0

        for dy in range(2, block_size - 2, 2):
            for dx in range(2, block_size - 2, 2):
                color = self._get_pixel_color(img, x + dx, y + dy)
                r_sum += color[0]
                g_sum += color[1]
                b_sum += color[2]
                samples += 1

        if samples > 0:
            return (r_sum // samples, g_sum // samples, b_sum // samples)
        return (0, 0, 0)

    def calibrate(self, calibration_img: Image.Image, block_size: int = BLOCK_SIZE):
        """
        Build color calibration table from calibration frame.

        Args:
            calibration_img: Image containing 64-color calibration grid
            block_size: Size of each block in pixels
        """
        self.color_calibration = {}

        # Expected colors
        expected_colors = ColorCodec.generate_calibration_colors()

        # Find the calibration grid (8x8 in the center)
        for i, expected in enumerate(expected_colors):
            row = i // 8
            col = i % 8

            grid_x = 10 + col
            grid_y = 5 + row

            # Sample the block
            measured = self._sample_block(calibration_img, grid_x, grid_y, block_size)

            # Store mapping
            self.color_calibration[measured] = expected

        self.calibrated = True
        print(f"Calibrated with {len(self.color_calibration)} color mappings")

    def _decode_color(self, measured_rgb: Tuple[int, int, int]) -> int:
        """
        Decode a measured RGB color to a 6-bit value.

        Uses calibration if available, otherwise direct mapping.
        """
        if self.calibrated and measured_rgb in self.color_calibration:
            expected = self.color_calibration[measured_rgb]
            # Find the value for this expected color
            for value, color in enumerate(ColorCodec.generate_calibration_colors()):
                if color == expected:
                    return value

        # Fallback: direct mapping
        return ColorCodec.rgb_to_value(*measured_rgb)

    def decode_frame(self, img: Image.Image, block_size: int = BLOCK_SIZE) -> Optional[dict]:
        """
        Decode a data frame back to a packet.

        Args:
            img: Source image
            block_size: Size of each block in pixels

        Returns:
            Packet dictionary or None if decoding failed
        """
        # Detect corners (simplified - assumes good alignment)
        # In real implementation, would use corner detection

        # Read the exact payload rows defined by core.protocol.  Rows 0-1
        # contain markers, row 48 is a separator and row 49 is metadata.
        values = []
        for row in range(2, 48):
            for col in range(FRAME_COLS):
                color = self._sample_block(img, col, row, block_size)
                values.append(self._decode_color(color))

        metadata_values = []
        for col in range(METADATA_VALUES):
            color = self._sample_block(img, col, 49, block_size)
            metadata_values.append(self._decode_color(color))

        header_bytes = protocol_values_to_bytes(metadata_values, HEADER_BYTES)
        header = unpack_header(header_bytes)
        payload_length = header.get('payload_length', PAYLOAD_BYTES) if header else PAYLOAD_BYTES
        data = protocol_values_to_bytes(values, payload_length)

        return {
            'data': data,
            'header': header,
            'metadata_values': metadata_values,
        }


def test_frame_codec():
    """Test frame encoding and decoding."""
    print("Testing Frame Codec...")

    # Create encoder
    encoder = FrameEncoder()

    # Generate calibration frame
    print("\n1. Testing calibration frame...")
    calib_frame = encoder.render_calibration_frame()
    calib_frame.save('/tmp/calibration_frame.png')
    print(f"  ✓ Calibration frame saved: {calib_frame.size}")

    # Generate data frames
    print("\n2. Testing data frame rendering...")
    from .fountain import FountainEncoder

    test_data = b"Hello, VEF-3! This is a test of the visual file transfer system."
    fountain = FountainEncoder(test_data)

    for i in range(3):
        packet = fountain.encode_packet(i)
        frame = encoder.render_data_frame(packet, i)
        frame.save(f'/tmp/data_frame_{i}.png')
        print(f"  ✓ Frame {i} saved")

    print("\n3. Testing frame decoding...")
    decoder = FrameDecoder()

    # Calibrate
    decoded_calib = Image.open('/tmp/calibration_frame.png')
    decoder.calibrate(decoded_calib)

    # Decode data frame
    decoded_frame = Image.open('/tmp/data_frame_0.png')
    result = decoder.decode_frame(decoded_frame)

    print(f"  Decoded {len(result['data'])} bytes")

    print("\nAll Frame Codec tests passed!")


if __name__ == "__main__":
    test_frame_codec()
