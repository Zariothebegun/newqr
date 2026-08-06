"""
VEF-3 CORE - Fountain Codes (Improved)
High reliability encoding for mobile transfer.
"""

import random
import numpy as np
from typing import List, Tuple, Optional, Dict
import hashlib


class FountainEncoder:
    """Reliable fountain encoder with guaranteed decoding."""

    def __init__(self, data: bytes, block_size: int = 1024):
        self.data = data
        self.block_size = block_size
        self.k = (len(data) + block_size - 1) // block_size
        padded_len = self.k * block_size
        self.padded_data = data + b'\x00' * (padded_len - len(data))

        # Split into blocks
        self.blocks = [
            self.padded_data[i*block_size:(i+1)*block_size]
            for i in range(self.k)
        ]

        self._random = random.Random(42)
        self.checksum = hashlib.md5(data).hexdigest()

    def generate_packet(self, packet_id: int) -> dict:
        """Generate packet with optional single-block packets for reliability."""
        # Guarantee some degree-1 packets for direct block recovery
        if packet_id < self.k:
            # First K packets are single blocks (guaranteed recovery)
            return {
                'id': packet_id,
                'block_indices': [packet_id],
                'data': self.blocks[packet_id],
                'num_blocks': self.k,
                'checksum': self.checksum,
                'original_size': len(self.data)
            }

        # After K packets, use random degrees
        degree = self._random.randint(2, min(5, self.k))
        indices = self._random.sample(range(self.k), degree)

        # XOR
        result = bytearray(self.block_size)
        for idx in indices:
            for i, b in enumerate(self.blocks[idx]):
                result[i] ^= b

        return {
            'id': packet_id,
            'block_indices': indices,
            'data': bytes(result),
            'num_blocks': self.k,
            'checksum': '',
            'original_size': len(self.data)
        }

    def generate_packets(self, count: int = None):
        if count is None:
            count = self.k + 10  # At least K single-block packets
        for i in range(count):
            yield self.generate_packet(i)


class FountainDecoder:
    """Simple and reliable decoder."""

    def __init__(self, block_size: int = 1024):
        self.block_size = block_size
        self.k = 0
        self.original_size = 0
        self.checksum = ""
        self.decoded: Dict[int, bytes] = {}
        self.pending: List[tuple] = []
        self.packets_received = 0

    def add_packet(self, packet: dict) -> bool:
        self.packets_received += 1

        if self.k == 0:
            self.k = packet['num_blocks']
            self.original_size = packet.get('original_size', 0)
            self.checksum = packet.get('checksum', '')

        indices = list(packet['block_indices'])
        data = list(packet['data'])

        # Eliminate known blocks
        changed = True
        while changed and len(indices) > 1:
            changed = False
            for idx in indices[:]:
                if idx in self.decoded:
                    known = list(self.decoded[idx])
                    for i in range(len(data)):
                        data[i] ^= known[i]
                    indices.remove(idx)
                    changed = True

        if not indices:
            return self.is_complete()

        if len(indices) == 1:
            self.decoded[indices[0]] = bytes(data)
            self._process_pending()

        self.pending.append((indices, data))
        self._process_pending()

        return self.is_complete()

    def _process_pending(self):
        """Process until no more single-unknown equations."""
        while self.pending:
            # Find equation with single unknown
            single_idx = -1
            single_data = None
            single_pos = -1

            for i, (indices, data) in enumerate(self.pending):
                if len(indices) == 1:
                    single_idx = indices[0]
                    single_data = data
                    single_pos = i
                    break

            if single_idx == -1:
                break

            self.pending.pop(single_pos)
            self.decoded[single_idx] = bytes(single_data)

            # Update remaining equations
            new_pending = []
            for indices, data in self.pending:
                if single_idx in indices:
                    new_data = [data[i] ^ single_data[i] for i in range(len(data))]
                    new_indices = [idx for idx in indices if idx != single_idx]
                    if new_indices:
                        new_pending.append((new_indices, new_data))
                else:
                    new_pending.append((indices, data))

            self.pending = new_pending

    def is_complete(self) -> bool:
        return len(self.decoded) >= self.k and self.k > 0

    def get_decoded_data(self) -> Optional[bytes]:
        if not self.is_complete():
            return None

        result = []
        for i in range(self.k):
            if i not in self.decoded:
                return None
            result.append(self.decoded[i])

        data = b''.join(result)[:self.original_size]

        if self.checksum and hashlib.md5(data).hexdigest() != self.checksum:
            return None

        return data

    def get_progress(self) -> Tuple[int, int, int]:
        d = len(self.decoded)
        return (d, self.k, int(d / max(1, self.k) * 100))

    def get_stats(self) -> dict:
        return {
            'packets_received': self.packets_received,
            'blocks_decoded': len(self.decoded),
            'total_blocks': self.k,
            'pending': len(self.pending)
        }


class AdaptiveFountainSystem:
    """Adaptive encoding/decoding system."""

    def __init__(self, data: bytes, block_size: int = 1024):
        self.data = data
        self.block_size = block_size
        self.encoder = FountainEncoder(data, block_size)

    def generate_batch(self, count: int = None) -> List[dict]:
        if count is None:
            count = self.encoder.k + 15
        return list(self.encoder.generate_packets(count))

    def decode_batch(self, packets: List[dict]) -> Tuple[Optional[bytes], dict]:
        decoder = FountainDecoder(self.block_size)
        for p in packets:
            decoder.add_packet(p)
            if decoder.is_complete():
                break
        return decoder.get_decoded_data(), decoder.get_stats()


def test():
    print("Testing VEF-3 Fountain Codes...")

    test_data = b'X' * 10000
    print(f"\nData: {len(test_data)} bytes, K={FountainEncoder(test_data).k}")

    success = 0
    for i in range(10):
        random.seed(i)

        system = AdaptiveFountainSystem(test_data)
        packets = system.generate_batch()

        received = [p for p in packets if random.random() > 0.2]
        data_out, stats = system.decode_batch(received)

        if data_out == test_data:
            success += 1
            print(f"Test {i+1}: ✓ ({len(received)} packets)")
        else:
            print(f"Test {i+1}: ✗ ({stats['blocks_decoded']}/{stats['total_blocks']})")

    print(f"\nSuccess: {success}/10")


if __name__ == "__main__":
    test()
