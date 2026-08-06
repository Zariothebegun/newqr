"""Render and sample the 800x600 VEF-3 colour-block frames."""

from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np
from PIL import Image, ImageDraw

from .color_codec import ColorCodec
from .protocol import (
    BLOCK_SIZE,
    CALIBRATION_GRID,
    DATA_POSITIONS,
    DATA_VALUES,
    FRAME_COLS,
    FRAME_HEIGHT,
    FRAME_ROWS,
    FRAME_WIDTH,
    FOUNTAIN_BLOCK_SIZE,
    GRID_OFFSET_X,
    GRID_OFFSET_Y,
    HEADER_BYTES,
    METADATA_ROWS,
    METADATA_VALUES,
    REFERENCE_CELLS,
    REFERENCE_VALUES,
    bytes_to_values,
    pack_header,
    unpack_header,
    values_to_bytes,
)

CORNER_COLORS = {
    "TL": (0, 255, 0),
    "TR": (255, 0, 0),
    "BL": (0, 0, 255),
    "BR": (255, 255, 0),
}


class FrameEncoder:
    """Encode a Fountain packet into a complete 800x600 frame."""

    def __init__(self, block_size_pixels: int = BLOCK_SIZE):
        # The wire format is fixed at 8 pixels per block. Keep the argument for
        # CLI compatibility, but never let a setting silently change the wire.
        self.block_size = BLOCK_SIZE
        self.frame_width = FRAME_WIDTH
        self.frame_height = FRAME_HEIGHT

    def _draw_color_block(self, draw: ImageDraw.ImageDraw, col: int, row: int, color: Tuple[int, int, int]) -> None:
        x = GRID_OFFSET_X + col * BLOCK_SIZE
        y = GRID_OFFSET_Y + row * BLOCK_SIZE
        draw.rectangle([x, y, x + BLOCK_SIZE - 1, y + BLOCK_SIZE - 1], fill=color)

    def _draw_corner_markers(self, draw: ImageDraw.ImageDraw) -> None:
        size = 48
        thickness = 8
        left = 24
        right = FRAME_WIDTH - 24
        top = 36
        bottom = FRAME_HEIGHT - 36

        def l_marker(x: int, y: int, rightward: bool, downward: bool, colour: Tuple[int, int, int]) -> None:
            horizontal_x = x if rightward else x - size
            horizontal_y = y if downward else y - thickness
            vertical_x = x if rightward else x - thickness
            vertical_y = y if downward else y - size
            draw.rectangle([horizontal_x, horizontal_y, horizontal_x + size - 1, horizontal_y + thickness - 1], fill=colour)
            draw.rectangle([vertical_x, vertical_y, vertical_x + thickness - 1, vertical_y + size - 1], fill=colour)

        l_marker(left, top, True, True, CORNER_COLORS["TL"])
        l_marker(right, top, False, True, CORNER_COLORS["TR"])
        l_marker(left, bottom, True, False, CORNER_COLORS["BL"])
        l_marker(right, bottom, False, False, CORNER_COLORS["BR"])

    def _base(self) -> tuple[Image.Image, ImageDraw.ImageDraw]:
        image = Image.new("RGB", (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0))
        draw = ImageDraw.Draw(image)
        self._draw_corner_markers(draw)
        return image, draw

    def render_calibration_frame(self) -> Image.Image:
        image, draw = self._base()
        start_col, start_row = CALIBRATION_GRID
        for value in range(64):
            self._draw_color_block(
                draw,
                start_col + value % 8,
                start_row + value // 8,
                ColorCodec.value_to_rgb(value),
            )
        metadata = bytes_to_values(pack_header(calibration=True), METADATA_VALUES)
        for index, value in enumerate(metadata):
            self._draw_color_block(draw, index % FRAME_COLS, METADATA_ROWS[index // FRAME_COLS], ColorCodec.value_to_rgb(value))
        return image

    def render_data_frame(self, packet: dict, frame_index: int = 0) -> Image.Image:
        image, draw = self._base()
        data = bytes(packet.get("data", b""))[:FOUNTAIN_BLOCK_SIZE]
        indices = packet.get("indices", packet.get("block_indices", []))
        sequence = packet.get("seq", packet.get("packet_index", packet.get("id", frame_index)))
        session_id = packet.get("session_id", packet.get("file_id", 0))
        k = packet.get("k", packet.get("total_packets", packet.get("num_blocks", 1)))
        block_len = packet.get("block_len", len(data) or FOUNTAIN_BLOCK_SIZE)
        total_len = packet.get("total_len", packet.get("original_size", len(data)))
        file_crc32 = packet.get("file_crc32", 0)
        filename = packet.get("filename", "")

        values = bytes_to_values(data, DATA_VALUES)
        for value, (col, row) in zip(values, DATA_POSITIONS):
            self._draw_color_block(draw, col, row, ColorCodec.value_to_rgb(value))

        if sequence % 30 == 0:
            for cell, value in zip(REFERENCE_CELLS, REFERENCE_VALUES):
                self._draw_color_block(draw, cell % FRAME_COLS, cell // FRAME_COLS, ColorCodec.value_to_rgb(value))

        header = pack_header(
            session_id=session_id,
            seq=sequence,
            k=k,
            block_len=block_len,
            total_len=total_len,
            file_crc32=file_crc32,
            indices=indices,
            filename=filename,
        )
        metadata = bytes_to_values(header, METADATA_VALUES)
        for index, value in enumerate(metadata):
            self._draw_color_block(draw, index % FRAME_COLS, METADATA_ROWS[index // FRAME_COLS], ColorCodec.value_to_rgb(value))
        return image


class FrameDecoder:
    """Decode a clean PIL frame using the same 6-bit colour mapping."""

    def __init__(self) -> None:
        self.calibrated = False
        self.channel_centres = [[0, 85, 170, 255] for _ in range(3)]

    def _sample_block(self, image: Image.Image, col: int, row: int, block_size: int = BLOCK_SIZE) -> Tuple[int, int, int]:
        x = GRID_OFFSET_X + col * BLOCK_SIZE + BLOCK_SIZE // 2
        y = GRID_OFFSET_Y + row * BLOCK_SIZE + BLOCK_SIZE // 2
        pixels = []
        for dy in (-2, 0, 2):
            for dx in (-2, 0, 2):
                pixels.append(image.getpixel((x + dx, y + dy))[:3])
        return tuple(sum(pixel[channel] for pixel in pixels) // len(pixels) for channel in range(3))

    def calibrate(self, calibration_img: Image.Image, block_size: int = BLOCK_SIZE) -> None:
        samples = [[[] for _ in range(4)] for _ in range(3)]
        start_col, start_row = CALIBRATION_GRID
        for value in range(64):
            measured = self._sample_block(calibration_img, start_col + value % 8, start_row + value // 8)
            expected = ColorCodec.value_to_rgb(value)
            for channel in range(3):
                level = expected[channel] // 85
                samples[channel][level].append(measured[channel])
        for channel in range(3):
            for level in range(4):
                if samples[channel][level]:
                    self.channel_centres[channel][level] = sum(samples[channel][level]) / len(samples[channel][level])
        self.calibrated = True

    def _decode_color(self, rgb: Tuple[int, int, int]) -> int:
        levels = []
        for channel, value in enumerate(rgb):
            levels.append(min(range(4), key=lambda level: abs(value - self.channel_centres[channel][level])))
        return levels[0] * 16 + levels[1] * 4 + levels[2]

    def decode_frame(self, image: Image.Image, block_size: int = BLOCK_SIZE) -> Optional[dict]:
        values = [self._decode_color(self._sample_block(image, col, row)) for col, row in DATA_POSITIONS]
        metadata_values = []
        for row in METADATA_ROWS:
            for col in range(FRAME_COLS):
                metadata_values.append(self._decode_color(self._sample_block(image, col, row)))
        header = unpack_header(values_to_bytes(metadata_values, HEADER_BYTES))
        if not header or header.get("type") != "data":
            return None
        data = values_to_bytes(values, header["block_len"])
        return {**header, "data": data, "metadata_values": metadata_values}
