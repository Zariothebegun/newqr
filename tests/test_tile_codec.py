import unittest

from core.tile_codec import COLORS, PATTERNS, ColourCalibrator, decode_samples


class TileCodecTests(unittest.TestCase):
    @staticmethod
    def samples_for(value):
        pattern = PATTERNS[(value >> 2) & 15]
        colour = COLORS[value & 3]
        return [
            colour if (pattern >> cell) & 1 else (0, 0, 0)
            for cell in range(16)
        ]

    def test_codebook_has_six_bits_and_distance(self):
        self.assertEqual(len(PATTERNS), 16)
        distances = [
            (PATTERNS[left] ^ PATTERNS[right]).bit_count()
            for left in range(len(PATTERNS))
            for right in range(left)
        ]
        self.assertGreaterEqual(min(distances), 6)

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
