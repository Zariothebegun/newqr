"""Readable 4-bit symbol + 2-bit colour tile codec."""

from __future__ import annotations

from typing import Sequence

COLORS = (
    (255, 255, 255),
    (255, 72, 72),
    (72, 255, 112),
    (72, 144, 255),
)
PATTERNS = tuple(range(16))
REFERENCE_VALUES = (0, 21, 42, 63)


def draw_tile(draw, x: int, y: int, value: int, tile_size: int = 8) -> None:
    pattern = value >> 2
    colour = COLORS[value & 3]
    scale = tile_size // 8
    draw.rectangle([x, y, x + 2 * scale - 1, y + tile_size - 1], fill=colour)
    for quadrant in range(4):
        if (pattern >> quadrant) & 1:
            left = x + (2 + (quadrant % 2) * 3) * scale
            top = y + (quadrant > 1) * 4 * scale
            draw.rectangle([left, top, left + 3 * scale - 1, top + 4 * scale - 1], fill=(255, 255, 255))


def _luminance(rgb: Sequence[float]) -> float:
    return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114


def extract(samples: dict) -> dict:
    brightness = [_luminance(sample) for sample in samples["pattern"]]
    low, high = min(brightness), max(brightness)
    threshold = low + (high - low) * 0.48
    pattern = 15 if high - low < 1 and high > 128 else 0
    if high - low >= 1:
        pattern = sum((1 << index) for index, value in enumerate(brightness) if value > threshold)
    return {"pattern": pattern, "pattern_distance": 0, "colour": samples["colour"], "contrast": high - low}


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


def decode_samples(samples: dict, calibrator: ColourCalibrator | None = None) -> dict:
    calibrator = calibrator or ColourCalibrator()
    shape = extract(samples)
    colour, distance = calibrator.classify(shape["colour"])
    return {"value": (shape["pattern"] << 2) | colour, "pattern_distance": 0, "colour_distance": distance, "contrast": shape["contrast"], "valid": shape["contrast"] >= 18 or shape["pattern"] in (0, 15), "colour": shape["colour"]}
