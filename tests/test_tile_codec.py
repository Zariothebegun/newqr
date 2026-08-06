import unittest

from core.tile_codec import COLORS, PATTERNS, ColourCalibrator, decode_samples


class TileCodecTests(unittest.TestCase):
    @staticmethod
    def samples_for(value):
        pattern = PATTERNS[(value >> 2) & 15]
        colour = COLORS[value & 3]
        return {
            "colour": colour,
            "pattern": [
                (255, 255, 255) if (pattern >> quadrant) & 1 else (0, 0, 0)
                for quadrant in range(4)
            ],
        }

    def test_codebook_has_sixteen_readable_symbols(self):
        self.assertEqual(PATTERNS, tuple(range(16)))

    def test_all_values_round_trip(self):
        calibrator = ColourCalibrator()
        for value in range(64):
            extracted = decode_samples(self.samples_for(value), calibrator)
            calibrator.add(extracted["colour"], value & 3)
        calibrator.finish()
        for value in range(64):
            decoded = decode_samples(self.samples_for(value), calibrator)
            self.assertEqual(decoded["value"], value)
            self.assertTrue(decoded["valid"])


if __name__ == "__main__":
    unittest.main()
