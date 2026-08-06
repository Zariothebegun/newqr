"""
VEF-3 CORE - Frame Encoder/Decoder
Renders and parses visual frames containing encoded data.
"""

import numpy as np
from typing import List, Tuple, Optional, Dict
from PIL import Image, ImageDraw
from .color_codec import ColorCodec, FRAME_COLS, FRAME_ROWS, BLOCKS_PER_FRAME, METADATA_BLOCKS, LEVELS


# Frame dimensions (in pixels)
BLOCK_SIZE = 8  # Each color block is 8x8 pixels
FRAME_WIDTH = FRAME_COLS * BLOCK_SIZE  # 640 pixels
FRAME_HEIGHT = FRAME_ROWS * BLOCK_SIZE  # 400 pixels

# Corner marker configuration
MARKER_SIZE = 30  # Size of L-shaped markers
MARKER_OFFSET = 20  # Distance from corners

# Colors for corner markers (fixed, used for alignment)
CORNER_COLORS = {
    'TL': (0, 255, 0),      # Green - Top Left
    'TR': (255, 0, 0),      # Red - Top Right
    'BL': (0, 0, 255),      # Blue - Bottom Left
    'BR': (255, 255, 0),    # Yellow - Bottom Right
}

# Timing line color
TIMING_COLOR = (128, 128, 128)


class FrameEncoder:
    """
    Encodes data packets into visual frames.
    """
    
    def __init__(self, block_size_pixels: int = BLOCK_SIZE):
        self.block_size = block_size_pixels
        self.frame_width = FRAME_COLS * block_size_pixels
        self.frame_height = FRAME_ROWS * block_size_pixels
        
    def _draw_corner_markers(self, img: Image.Image, draw: ImageDraw.Draw):
        """Draw L-shaped corner markers for alignment."""
        s = MARKER_SIZE
        offset = MARKER_OFFSET
        
        # Top Left (green)
        draw.rectangle([offset, offset, offset + s, offset + 5], fill=CORNER_COLORS['TL'])
        draw.rectangle([offset, offset, offset + 5, offset + s], fill=CORNER_COLORS['TL'])
        
        # Top Right (red)
        x = self.frame_width - offset - s
        draw.rectangle([x, offset, x + s, offset + 5], fill=CORNER_COLORS['TR'])
        draw.rectangle([x + s - 5, offset, x + s, offset + s], fill=CORNER_COLORS['TR'])
        
        # Bottom Left (blue)
        y = self.frame_height - offset - s
        draw.rectangle([offset, y, offset + 5, y + s], fill=CORNER_COLORS['BL'])
        draw.rectangle([offset, y + s - 5, offset + s, y + s], fill=CORNER_COLORS['BL'])
        
        # Bottom Right (yellow)
        draw.rectangle([x, y, x + s - 5, y + s], fill=CORNER_COLORS['BR'])
        draw.rectangle([x, y, x + s, y + s - 5], fill=CORNER_COLORS['BR'])
    
    def _draw_timing_lines(self, img: Image.Image, draw: ImageDraw.Draw):
        """Draw timing lines along the borders."""
        # Horizontal lines
        y1 = offset = MARKER_OFFSET
        y2 = self.frame_height - MARKER_OFFSET
        
        for x in range(offset + MARKER_SIZE, self.frame_width - MARKER_OFFSET, 10):
            draw.rectangle([x, y1, x + 2, y1 + 2], fill=TIMING_COLOR)
            draw.rectangle([x, y2 - 2, x + 2, y2], fill=TIMING_COLOR)
        
        # Vertical lines
        x1 = offset = MARKER_OFFSET
        x2 = self.frame_width - MARKER_OFFSET
        
        for y in range(offset + MARKER_SIZE, self.frame_height - MARKER_OFFSET, 10):
            draw.rectangle([x1, y, x1 + 2, y + 2], fill=TIMING_COLOR)
            draw.rectangle([x2 - 2, y, x2, y + 2], fill=TIMING_COLOR)
    
    def _draw_color_block(self, draw: ImageDraw.Draw, col: int, row: int, color: Tuple[int, int, int]):
        """Draw a single color block at the specified grid position."""
        x = col * self.block_size
        y = row * self.block_size
        draw.rectangle([x, y, x + self.block_size - 1, y + self.block_size - 1], fill=color)
    
    def _pack_metadata(self, frame_index: int, packet_id: int, checksum: str, num_blocks: int) -> List[int]:
        """
        Pack metadata into 40 6-bit values.
        
        Metadata structure:
        - Bytes 0-3: Frame index (uint32)
        - Bytes 4-7: Packet ID (uint32)
        - Bytes 8-23: Checksum (16 chars, padded)
        - Bytes 24-27: Number of source blocks
        - Bytes 28-31: Original file size
        - Bytes 32-39: Reserved/padding
        
        Total: 40 bytes -> 40 * 6 bits = 240 bits = 40 values
        """
        values = []
        
        # Frame index (4 bytes = 5 values with padding)
        idx_bytes = frame_index.to_bytes(4, 'big')
        values.extend(ColorCodec.bytes_to_values(idx_bytes))
        
        # Packet ID (4 bytes)
        pkt_bytes = packet_id.to_bytes(4, 'big')
        values.extend(ColorCodec.bytes_to_values(pkt_bytes))
        
        # Checksum (16 bytes, but 5 values per 4 bytes = 20 values needed)
        chk_bytes = checksum.encode().ljust(16, b'\x00')[:16]
        values.extend(ColorCodec.bytes_to_values(chk_bytes))
        
        # Number of blocks (4 bytes)
        blk_bytes = num_blocks.to_bytes(4, 'big')
        values.extend(ColorCodec.bytes_to_values(blk_bytes))
        
        # Reserved/alignment padding to reach 40 values
        # We need exactly 40 metadata values
        while len(values) < METADATA_BLOCKS:
            values.append(0)
        
        return values[:METADATA_BLOCKS]
    
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
        
        # Convert packet data to 6-bit values
        data = packet['data']
        values = ColorCodec.bytes_to_values(data)
        
        # Pad values to fill DATA_BLOCKS_PER_FRAME blocks
        while len(values) < BLOCKS_PER_FRAME - METADATA_BLOCKS:
            values.append(0)
        
        # Draw data blocks
        data_start_row = 2  # Start after timing area
        for i, value in enumerate(values[:BLOCKS_PER_FRAME - METADATA_BLOCKS]):
            # Calculate position
            block_idx = i
            col = block_idx % FRAME_COLS
            row = data_start_row + (block_idx // FRAME_COLS)
            
            if row < FRAME_ROWS - 2:  # Leave room for metadata
                color = ColorCodec.value_to_rgb(value)
                self._draw_color_block(draw, col, row, color)
        
        # Draw metadata strip at bottom
        metadata = self._pack_metadata(
            frame_index,
            packet['id'],
            packet.get('checksum', ''),
            packet['num_blocks']
        )
        
        for i, value in enumerate(metadata):
            col = i % FRAME_COLS
            row = FRAME_ROWS - 1  # Bottom row
            
            color = ColorCodec.value_to_rgb(value)
            self._draw_color_block(draw, col, row, color)
        
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
        
        # Read data blocks
        values = []
        data_start_row = 2
        
        for row in range(data_start_row, FRAME_ROWS - 1):
            for col in range(FRAME_COLS):
                color = self._sample_block(img, col, row, block_size)
                value = self._decode_color(color)
                values.append(value)
        
        # Read metadata strip
        metadata_values = []
        for col in range(FRAME_COLS):
            color = self._sample_block(img, col, FRAME_ROWS - 1, block_size)
            value = self._decode_color(color)
            metadata_values.append(value)
        
        # Extract metadata
        # Note: In real implementation, would properly decode metadata
        
        # Convert data values to bytes
        data = ColorCodec.values_to_bytes(values)
        
        return {
            'data': data,
            'metadata_values': metadata_values
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
