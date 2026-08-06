"""Cimbar-inspired 4-bit symbol + 2-bit colour tile codec."""

from __future__ import annotations

from typing import Iterable, Sequence

from .color_codec import LEVELS

TILE_SIZE = 8
MICRO_SIZE = 2
COLORS = (
    (255, 255, 255),
    (255, 72, 72),
    (72, 255, 112),
    (72, 144, 255),
)
# Same codebook as decoder/static/tile-codec.js. Each 4x4 symbol has eight
# active cells and every pair differs in at least six cells.
PATTERNS = (
    0x00FF, 0x071F, 0x07E3, 0x0B6D,
    0x0BB6, 0x0D7A, 0x0DD5, 0x0EB9,
    0x0ECE, 0x13D9, 0x15AD, 0x1675,
    0x298F, 0x2A57, 0x3137, 0x31EA,
)
REFERENCE_VALUES = (0, 21, 42, 63)


def draw_tile(draw, x: int, y: int, value: int, tile_size: int = TILE_SIZE) -> None:
    pattern = PATTERNS[(value >> 2) & 15]
    rgb = COLORS[value & 3]
    micro = tile_size // 4
    for cell in range(16):
        colour = rgb if (pattern >> cell) & 1 else (0, 0, 0)
        left = x + (cell % 4) * micro
        top = y + (cell // 4) * micro
        draw.rectangle([left, top, left + micro - 1, top + micro - 1], fill=colour)


def _luminance(rgb: Sequence[float]) -> float:
    return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114


def extract(samples: Sequence[Sequence[float]]) -> dict:
    brightness = [_luminance(sample) for sample in samples]
    low, high = min(brightness), max(brightness)
    threshold = low + (high - low) * 0.48
    mask = 0
    active = []
    for cell, value in enumerate(brightness):
        if value > threshold:
            mask |= 1 << cell
            active.append(cell)
    best_pattern = 0
    best_distance = 100
    for index, pattern in enumerate(PATTERNS):
        distance = (mask ^ pattern).bit_count()
        if distance < best_distance:
            best_pattern, best_distance = index, distance
    source = active or list(range(16))
    colour = tuple(sum(samples[cell][channel] for cell in source) / len(source) for channel in range(3))
    return {"pattern": best_pattern, "pattern_distance": best_distance, "colour": colour, "contrast": high - low}


class ColourCalibrator:
    def __init__(self) -> None:
        self.samples = [[] for _ in range(4)]
        self.centres = [list(colour) for colour in COLORS]
        self.ready = False

    def add(self, measured: Sequence[float], colour_index: int) -> None:
        if 0 <= colour_index < 4:
            self.samples[colour_index].append(tuple(measured))

    def finish(self) -> None:
        for index, samples in enumerate(self.samples):
            if samples:
                self.centres[index] = [sum(sample[channel] for sample in samples) / len(samples) for channel in range(3)]
        self.ready = True

    def classify(self, measured: Sequence[float]) -> tuple[int, float]:
        distances = [sum((measured[channel] - centre[channel]) ** 2 for channel in range(3)) ** 0.5 for centre in self.centres]
        best = min(range(4), key=distances.__getitem__)
        return best, distances[best]


def decode_samples(samples: Sequence[Sequence[float]], calibrator: ColourCalibrator | None = None) -> dict:
    calibrator = calibrator or ColourCalibrator()
    shape = extract(samples)
    colour, distance = calibrator.classify(shape["colour"])
    return {
        "value": (shape["pattern"] << 2) | colour,
        "pattern_distance": shape["pattern_distance"],
        "colour_distance": distance,
        "contrast": shape["contrast"],
        "valid": shape["pattern_distance"] <= 4 and shape["contrast"] >= 18,
        "colour": shape["colour"],
    }
