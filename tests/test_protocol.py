import unittest

from core.protocol import (
    HEADER_BYTES,
    PAYLOAD_BYTES,
    bytes_to_values,
    crc32,
    pack_header,
    unpack_header,
    values_to_bytes,
)


class ProtocolTests(unittest.TestCase):
    def test_payload_round_trip(self):
        data = bytes((index * 37) % 256 for index in range(PAYLOAD_BYTES))
        self.assertEqual(values_to_bytes(bytes_to_values(data), len(data)), data)

    def test_header_round_trip(self):
        header = pack_header(
            file_id=0x12345678,
            packet_index=17,
            total_packets=42,
            original_size=100_000,
            payload_length=1234,
            file_crc32=crc32(b"file"),
            filename="a useful filename.pdf",
        )
        self.assertEqual(len(header), HEADER_BYTES)
        parsed = unpack_header(header)
        self.assertEqual(parsed["file_id"], 0x12345678)
        self.assertEqual(parsed["packet_index"], 17)
        self.assertEqual(parsed["total_packets"], 42)
        self.assertEqual(parsed["filename"], "a useful filename.pdf")

    def test_calibration_header_is_identifiable(self):
        header = pack_header(
            file_id=0,
            packet_index=0,
            total_packets=0,
            original_size=0,
            payload_length=0,
            file_crc32=0,
            calibration=True,
        )
        self.assertEqual(unpack_header(header)["type"], "calibration")


if __name__ == "__main__":
    unittest.main()
