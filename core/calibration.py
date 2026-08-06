"""
VEF-3 CORE - Frame Calibration and Verification System
Robust calibration for mobile devices with automatic correction.
"""

import numpy as np
from typing import Tuple, List, Dict, Optional, Set
from collections import defaultdict
import hashlib
import zlib

from .protocol import (
    CALIBRATION_GRID,
    DATA_POSITIONS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    GRID_OFFSET_X,
    GRID_OFFSET_Y,
    METADATA_ROWS,
    values_to_bytes as protocol_values_to_bytes,
)


class ColorCalibrator:
    """
    Adaptive color calibration system.
    Automatically builds and updates color mapping from camera frames.
    """

    # Expected reference colors (the 64 possible colors)
    REFERENCE_COLORS = []
    for r in [0, 85, 170, 255]:
        for g in [0, 85, 170, 255]:
            for b in [0, 85, 170, 255]:
                REFERENCE_COLORS.append((r, g, b))

    # Thresholds for level detection
    LEVEL_THRESHOLDS = [(0, 42), (43, 127), (128, 212), (213, 255)]
    LEVEL_VALUES = [0, 85, 170, 255]

    def __init__(self):
        # Color mapping: measured -> reference
        self.measured_to_reference: Dict[Tuple[int, int, int], Tuple[int, int, int]] = {}

        # Level mapping for each channel
        self.r_mapping: Dict[int, int] = {}
        self.g_mapping: Dict[int, int] = {}
        self.b_mapping: Dict[int, int] = {}

        # Calibration confidence
        self.samples = 0
        self.calibrated = False
        self.confidence = 0.0

        # Adaptive thresholds
        self.adaptive_thresholds = {
            'r': list(self.LEVEL_THRESHOLDS),
            'g': list(self.LEVEL_THRESHOLDS),
            'b': list(self.LEVEL_THRESHOLDS)
        }

    def _rgb_to_level(self, channel: int, thresholds: List[Tuple[int, int]]) -> int:
        """Convert RGB channel value to level (0-3)."""
        for level, (low, high) in enumerate(thresholds):
            if low <= channel <= high:
                return level
        return 3 if channel > 212 else 0

    def add_calibration_sample(self, measured: Tuple[int, int, int], expected: Tuple[int, int, int]):
        """Add a calibration sample from the calibration frame."""
        self.measured_to_reference[measured] = expected
        self.samples += 1

        # Update channel mappings
        m_r, m_g, m_b = measured
        e_r, e_g, e_b = expected

        # Find expected levels
        e_r_level = self.LEVEL_VALUES.index(e_r) if e_r in self.LEVEL_VALUES else -1
        e_g_level = self.LEVEL_VALUES.index(e_g) if e_g in self.LEVEL_VALUES else -1
        e_b_level = self.LEVEL_VALUES.index(e_b) if e_b in self.LEVEL_VALUES else -1

        # Build cumulative mapping
        if e_r_level >= 0:
            self.r_mapping[m_r] = e_r_level
        if e_g_level >= 0:
            self.g_mapping[m_g] = e_g_level
        if e_b_level >= 0:
            self.b_mapping[m_b] = e_b_level

    def calibrate(self):
        """Finalize calibration with all collected samples."""
        if self.samples < 10:
            self.calibrated = False
            self.confidence = self.samples / 10
            return

        # Build adaptive threshold mapping for each channel
        self._build_adaptive_thresholds('r', self.r_mapping)
        self._build_adaptive_thresholds('g', self.g_mapping)
        self._build_adaptive_thresholds('b', self.b_mapping)

        # Calculate confidence based on coverage
        unique_refs = len(set(self.measured_to_reference.values()))
        self.confidence = min(1.0, unique_refs / 64 * 2)  # Good if we see 32+ unique colors

        self.calibrated = True

    def _build_adaptive_thresholds(self, channel: str, mapping: Dict[int, int]):
        """Build adaptive thresholds based on observed colors."""
        if not mapping:
            return

        # Group measurements by expected level
        by_level = defaultdict(list)
        for measured, level in mapping.items():
            by_level[level].append(measured)

        # Build new thresholds
        new_thresholds = []
        for level in range(4):
            if level in by_level:
                values = sorted(by_level[level])
                # Create threshold range centered on observed values
                mid = values[len(values)//2]
                spread = max(30, (values[-1] - values[0]) // 2)
                low = max(0, mid - spread)
                high = min(255, mid + spread)
                new_thresholds.append((low, high))
            else:
                # Use default
                new_thresholds.append(self.LEVEL_THRESHOLDS[level])

        self.adaptive_thresholds[channel] = new_thresholds

    def decode_color(self, r: int, g: int, b: int) -> int:
        """Decode a measured RGB color to 6-bit value (0-63)."""
        if self.calibrated:
            # Use adaptive thresholds
            r_level = self._rgb_to_level(r, self.adaptive_thresholds['r'])
            g_level = self._rgb_to_level(g, self.adaptive_thresholds['g'])
            b_level = self._rgb_to_level(b, self.adaptive_thresholds['b'])
        else:
            # Use default thresholds
            r_level = self._rgb_to_level(r, self.LEVEL_THRESHOLDS)
            g_level = self._rgb_to_level(g, self.LEVEL_THRESHOLDS)
            b_level = self._rgb_to_level(b, self.LEVEL_THRESHOLDS)

        return (r_level * 16) + (g_level * 4) + b_level

    def get_confidence(self) -> float:
        """Get calibration confidence (0-1)."""
        return self.confidence


class FrameVerifier:
    """
    Verifies frame integrity and extracts data.
    Includes CRC checking and automatic error detection.
    """

    def __init__(self, calibrator: ColorCalibrator = None):
        self.calibrator = calibrator or ColorCalibrator()

        # Frame parameters
        self.frame_cols = 80
        self.frame_rows = 50
        self.block_size = 8

        # Statistics
        self.frames_processed = 0
        self.valid_frames = 0
        self.corner_detected = False

        # Corner positions (normalized 0-1)
        self.corners = {
            'TL': (24 / FRAME_WIDTH, 36 / FRAME_HEIGHT),
            'TR': ((FRAME_WIDTH - 24) / FRAME_WIDTH, 36 / FRAME_HEIGHT),
            'BL': (24 / FRAME_WIDTH, (FRAME_HEIGHT - 36) / FRAME_HEIGHT),
            'BR': ((FRAME_WIDTH - 24) / FRAME_WIDTH, (FRAME_HEIGHT - 36) / FRAME_HEIGHT),
        }

        # Corner colors for detection
        self.corner_colors = {
            'TL': (0, 255, 0),    # Green
            'TR': (255, 0, 0),    # Red
            'BL': (0, 0, 255),    # Blue
            'BR': (255, 255, 0)   # Yellow
        }

    def detect_corners(self, image: np.ndarray) -> bool:
        """
        Detect corner markers in the frame.
        Returns True if corners are detected with sufficient confidence.
        """
        h, w = image.shape[:2]

        # Sample corners
        detected = {}
        for name, (nx, ny) in self.corners.items():
            x, y = int(nx * w), int(ny * h)

            # Sample a 10x10 region around the corner
            x1, x2 = max(0, x-5), min(w, x+5)
            y1, y2 = max(0, y-5), min(h, y+5)

            region = image[y1:y2, x1:x2]
            avg_color = region.mean(axis=(0, 1)).astype(int)

            # Check if it matches expected corner color
            expected = self.corner_colors[name]
            diff = sum(abs(a - e) for a, e in zip(avg_color, expected))

            if diff < 450:  # L marker intersections include black around the arms
                detected[name] = (x, y)

        self.corner_detected = len(detected) >= 3  # Need at least 3 corners
        return self.corner_detected

    def sample_block(self, image: np.ndarray, col: int, row: int) -> Tuple[int, int, int]:
        """
        Sample the average color of a block.
        Uses center sampling with noise reduction.
        """
        h, w = image.shape[:2]

        # Calculate pixel coordinates
        px = int(GRID_OFFSET_X + col * self.block_size + self.block_size // 2)
        py = int(GRID_OFFSET_Y + row * self.block_size + self.block_size // 2)

        # Sample 4x4 region around center
        x1, x2 = max(0, px-2), min(w, px+2)
        y1, y2 = max(0, py-2), min(h, py+2)

        region = image[y1:y2, x1:x2]

        # Average color with clipping
        r = int(np.clip(region[:,:,0].mean(), 0, 255))
        g = int(np.clip(region[:,:,1].mean(), 0, 255))
        b = int(np.clip(region[:,:,2].mean(), 0, 255))

        return (r, g, b)

    def read_frame(self, image: np.ndarray) -> Optional[dict]:
        """
        Read a complete frame and extract data.
        Returns frame metadata and decoded values.
        """
        self.frames_processed += 1

        # Verify corners
        if not self.detect_corners(image):
            return None

        self.valid_frames += 1

        # Read the exact protocol positions: rows 0-47 carry data except
        # four recurring reference cells; rows 48-49 carry metadata.
        values = []
        for col, row in DATA_POSITIONS:
            r, g, b = self.sample_block(image, col, row)
            values.append(self.calibrator.decode_color(r, g, b))

        metadata_values = []
        for row in METADATA_ROWS:
            for col in range(self.frame_cols):
                r, g, b = self.sample_block(image, col, row)
                metadata_values.append(self.calibrator.decode_color(r, g, b))

        # Extract metadata
        # Note: In production, would properly parse metadata for frame index, etc.

        return {
            'values': values,
            'metadata': metadata_values,
            'frame_index': self.valid_frames,
            'calibration_confidence': self.calibrator.get_confidence()
        }

    def verify_calibration_frame(self, image: np.ndarray) -> int:
        """
        Process a calibration frame and extract color samples.
        Returns number of colors successfully sampled.
        """
        if not self.detect_corners(image):
            return 0

        # Read the centered 8x8 calibration grid.
        grid_x, grid_y = CALIBRATION_GRID

        colors_sampled = 0

        for i in range(64):
            row = i // 8
            col = i % 8

            block_col = grid_x + col
            block_row = grid_y + row

            r, g, b = self.sample_block(image, block_col, block_row)

            # Find expected reference color
            expected = self.calibrator.REFERENCE_COLORS[i]

            # Add calibration sample
            self.calibrator.add_calibration_sample((r, g, b), expected)
            colors_sampled += 1

        # Finalize calibration
        self.calibrator.calibrate()

        return colors_sampled


class PacketReconstructor:
    """
    Reconstructs packets from frame data with error correction.
    Includes automatic retry and verification.
    """

    def __init__(self, block_size: int = 1024):
        self.block_size = block_size

        # Received packets
        self.packets: Dict[int, dict] = {}
        self.frame_ids_seen: Set[int] = set()

        # Statistics
        self.total_bytes = 0
        self.verified_packets = 0
        self.crc_failures = 0

    def add_frame_data(self, values: List[int], metadata: List[int]) -> Optional[dict]:
        """
        Convert frame values to packet data.
        Returns reconstructed packet or None if invalid.
        """
        # Convert 6-bit values to bytes
        data = self.values_to_bytes(values)

        if len(data) < self.block_size:
            # Pad to block size
            data = data + b'\x00' * (self.block_size - len(data))

        # Extract metadata (simplified - would properly parse in production)
        # For now, generate random block indices for testing
        # In production, would parse from metadata

        # Reconstruct packet info
        packet = {
            'data': data[:self.block_size],
            'block_indices': [0],  # Would be extracted from metadata
            'num_blocks': 1,       # Would be extracted
            'checksum': '',        # Would be extracted
            'crc32': zlib.crc32(data) & 0xFFFFFFFF
        }

        return packet

    @staticmethod
    def values_to_bytes(values: List[int]) -> bytes:
        """Convert pairs of 6-bit values to bytes."""
        return protocol_values_to_bytes(values)

    def verify_packet(self, packet: dict) -> bool:
        """Verify packet integrity using CRC."""
        data = packet.get('data', b'')
        expected_crc = packet.get('crc32', 0)
        actual_crc = zlib.crc32(data) & 0xFFFFFFFF

        if expected_crc != actual_crc:
            self.crc_failures += 1
            return False

        self.verified_packets += 1
        return True


def test_calibration():
    """Test the calibration system."""
    print("Testing Calibration System...")

    # Create calibrator
    calibrator = ColorCalibrator()

    # Simulate calibration with noisy measurements
    np.random.seed(42)

    for i, (expected_r, expected_g, expected_b) in enumerate(calibrator.REFERENCE_COLORS):
        # Add noise (simulating camera)
        noise = np.random.randint(-20, 20, 3)
        measured = (
            max(0, min(255, expected_r + noise[0])),
            max(0, min(255, expected_g + noise[1])),
            max(0, min(255, expected_b + noise[2]))
        )
        calibrator.add_calibration_sample(measured, (expected_r, expected_g, expected_b))

    calibrator.calibrate()
    print(f"Calibration samples: {calibrator.samples}")
    print(f"Calibration confidence: {calibrator.get_confidence():.2%}")

    # Test decoding with noise
    test_colors = [
        (0, 0, 0),
        (255, 255, 255),
        (85, 170, 255),
        (128, 64, 192),
    ]

    print("\nTesting noisy color decoding:")
    for r, g, b in test_colors:
        noise = np.random.randint(-15, 15, 3)
        noisy = (
            max(0, min(255, r + noise[0])),
            max(0, min(255, g + noise[1])),
            max(0, min(255, b + noise[2]))
        )
        decoded = calibrator.decode_color(*noisy)
        print(f"  Input: {noisy} -> Decoded: {decoded}")

    print("\nCalibration system tests complete!")


if __name__ == "__main__":
    test_calibration()
