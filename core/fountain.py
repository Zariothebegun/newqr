"""
VEF-3 CORE - Fountain Codes (Luby Transform Codes)
Used for robust file transfer over unreliable channels.
"""

import random
import numpy as np
from typing import List, Tuple, Optional, Generator
import hashlib


class FountainEncoder:
    """
    Encodes data using Fountain Codes (LT codes).
    
    Fountain codes generate "infinite" encoded packets from K source blocks.
    Any subset of approximately K packets (plus some overhead) can decode all K blocks.
    """
    
    def __init__(self, data: bytes, block_size: int = 1024):
        """
        Initialize the fountain encoder.
        
        Args:
            data: The data to encode
            block_size: Size of each source block in bytes (default 1 KB)
        """
        self.original_data = data
        self.block_size = block_size
        
        # Calculate number of blocks
        self.k = (len(data) + block_size - 1) // block_size
        
        # Pad data to fit exact block count
        self.padded_data = data + b'\x00' * (self.k * block_size - len(data))
        
        # Create source blocks
        self.blocks = [
            self.padded_data[i * block_size:(i + 1) * block_size]
            for i in range(self.k)
        ]
        
        # Random seed for reproducibility
        random.seed(42)
        
        # Statistics
        self.packets_sent = 0
        
    def _xor_blocks(self, blocks: List[bytes]) -> bytes:
        """XOR multiple blocks together."""
        if not blocks:
            return b'\x00' * self.block_size
        
        result = bytearray(blocks[0])
        for block in blocks[1:]:
            for i in range(len(result)):
                result[i] ^= block[i]
        return bytes(result)
    
    def _select_blocks(self, degree: int) -> List[int]:
        """
        Select 'degree' blocks to XOR together using soliton distribution.
        
        Uses robust soliton distribution for good performance.
        """
        # Ensure degree is valid
        degree = min(max(1, degree), self.k)
        
        # Simple degree distribution:
        # - Small chance of degree 1 (reliability for some blocks)
        # - Degree 2-5 for most packets
        # - Degree > 5 for better mixing
        
        if self.k == 1:
            # Only one block, always select it
            return [0]
        
        if random.random() < 0.1:  # 10% chance of degree 1
            degree = 1
        elif random.random() < 0.3:  # 30% chance of degree 2-3
            degree = random.randint(2, min(3, self.k))
        elif random.random() < 0.5:  # 50% chance of degree 3-6
            degree = random.randint(3, min(6, self.k))
        else:  # Rest: degree 4-10
            degree = random.randint(4, min(10, self.k))
        
        # Ensure degree doesn't exceed available blocks
        degree = min(degree, self.k)
        
        # Select unique block indices
        return random.sample(range(self.k), degree)
    
    def encode_packet(self, packet_id: int) -> dict:
        """
        Generate a single encoded packet.
        
        Args:
            packet_id: Unique packet identifier
            
        Returns:
            Dictionary with:
            - 'id': packet identifier
            - 'block_ids': list of source block indices used
            - 'data': XORed block data
            - 'num_blocks': total number of source blocks (K)
            - 'checksum': MD5 of original data
        """
        # Select blocks to XOR
        degree = self._select_blocks(min(10, self.k))
        selected_blocks = [self.blocks[i] for i in degree]
        
        # XOR them together
        encoded_data = self._xor_blocks(selected_blocks)
        
        # Calculate checksum of original data (only for first few packets)
        if packet_id < 10:
            checksum = hashlib.md5(self.original_data).hexdigest()
        else:
            checksum = ""
        
        self.packets_sent += 1
        
        return {
            'id': packet_id,
            'block_ids': degree,
            'data': encoded_data,
            'num_blocks': self.k,
            'checksum': checksum,
            'original_size': len(self.original_data)
        }
    
    def generate_packets(self, max_packets: Optional[int] = None) -> Generator[dict, None, None]:
        """
        Generate encoded packets indefinitely.
        
        Args:
            max_packets: Maximum number of packets to generate (default: 2 * K)
            
        Yields:
            Encoded packets as dictionaries
        """
        if max_packets is None:
            max_packets = int(self.k * 2.1)  # Need about 105% of K for decoding
        
        for i in range(max_packets):
            yield self.encode_packet(i)


class FountainDecoder:
    """
    Decodes data from fountain-encoded packets.
    
    Uses Gaussian elimination over GF(2) to solve the system of equations.
    """
    
    def __init__(self, block_size: int = 1024):
        """
        Initialize the fountain decoder.
        
        Args:
            block_size: Size of each source block in bytes
        """
        self.block_size = block_size
        self.k = 0
        self.original_size = 0
        self.checksum = ""
        
        # Decoded blocks: index -> decoded data
        self.decoded_blocks: dict = {}
        
        # Pending packets: list of (block_ids, encoded_data)
        self.pending_packets: List[Tuple[List[int], bytes]] = []
        
        # Matrix for Gaussian elimination (sparse representation)
        # Each entry: (packet_id, [(block_idx, coefficient), ...], data)
        self.matrix: List[tuple] = []
        
        # Total packets received
        self.packets_received = 0
        
    def add_packet(self, packet: dict) -> bool:
        """
        Add a received packet to the decoder.
        
        Args:
            packet: Dictionary with 'id', 'block_ids', 'data', 'num_blocks', 'checksum'
            
        Returns:
            True if decoding is complete, False otherwise
        """
        self.packets_received += 1
        
        # Store metadata
        if packet['num_blocks'] > 0:
            if self.k == 0:
                self.k = packet['num_blocks']
                self.original_size = packet.get('original_size', 0)
            elif self.k != packet['num_blocks']:
                return False  # Inconsistent packet
        
        if packet.get('checksum'):
            self.checksum = packet['checksum']
        
        # Check if this packet contains a block we already know
        block_ids = packet['block_ids']
        data = bytearray(packet['data'])
        
        # Remove known blocks by XORing them out
        changed = True
        while changed:
            changed = False
            for idx in block_ids[:]:  # Copy list to modify during iteration
                if idx in self.decoded_blocks:
                    # XOR out this known block
                    known = self.decoded_blocks[idx]
                    for i in range(len(data)):
                        data[i] ^= known[i]
                    block_ids.remove(idx)
                    changed = True
        
        # If all blocks are known, this packet is redundant
        if not block_ids:
            return self.is_complete()
        
        # Add to pending
        self.pending_packets.append((block_ids, bytes(data)))
        
        # Try to decode new blocks
        self._process_pending()
        
        return self.is_complete()
    
    def _process_pending(self):
        """Try to decode new blocks from pending packets."""
        changed = True
        while changed:
            changed = False
            
            for i in range(len(self.pending_packets)):
                block_ids, data = self.pending_packets[i]
                
                # If only one block left, we can decode it
                if len(block_ids) == 1:
                    idx = block_ids[0]
                    if idx not in self.decoded_blocks:
                        self.decoded_blocks[idx] = bytes(data)
                        self.pending_packets.pop(i)
                        changed = True
                        break
        
        # Try Gaussian elimination for remaining packets
        if len(self.pending_packets) > 1:
            self._gaussian_elimination()
    
    def _gaussian_elimination(self):
        """
        Perform Gaussian elimination over GF(2) on the pending packets.
        This is called when we have multiple equations but no single-variable equations.
        """
        if len(self.pending_packets) < 2:
            return
        
        # Build augmented matrix for small systems
        # For efficiency, we use a simpler approach: look for overlapping blocks
        
        # Sort by number of unknown blocks
        self.pending_packets.sort(key=lambda x: len(x[0]))
        
        # Try to eliminate variables
        for i in range(len(self.pending_packets)):
            if i >= len(self.pending_packets):
                break
                
            block_ids_i, data_i = self.pending_packets[i]
            
            for j in range(i + 1, len(self.pending_packets)):
                block_ids_j, data_j = self.pending_packets[j]
                
                # Find common blocks
                common = set(block_ids_i) & set(block_ids_j)
                if len(common) == 1:
                    # Can eliminate one variable
                    common_idx = list(common)[0]
                    
                    # XOR the two equations to eliminate common_idx
                    new_ids = list(set(block_ids_i) ^ set(block_ids_j))
                    new_data = bytearray(data_i)
                    for k in range(len(new_data)):
                        new_data[k] ^= data_j[k]
                    
                    # Update equation i
                    self.pending_packets[i] = (new_ids, bytes(new_data))
                    block_ids_i = new_ids
                    data_i = bytes(new_data)
                    
                    if len(block_ids_i) == 1:
                        # Now we can solve it
                        idx = block_ids_i[0]
                        if idx not in self.decoded_blocks:
                            self.decoded_blocks[idx] = data_i
                            self.pending_packets.pop(i)
                        break
    
    def is_complete(self) -> bool:
        """Check if all blocks have been decoded."""
        return len(self.decoded_blocks) >= self.k
    
    def get_decoded_data(self) -> Optional[bytes]:
        """
        Get the decoded data if complete.
        
        Returns:
            Original bytes or None if not complete
        """
        if not self.is_complete():
            return None
        
        # Reconstruct blocks in order
        blocks = [self.decoded_blocks[i] for i in range(self.k)]
        data = b''.join(blocks)
        
        # Trim to original size
        if self.original_size > 0:
            data = data[:self.original_size]
        
        # Verify checksum if available
        if self.checksum:
            actual_checksum = hashlib.md5(data).hexdigest()
            if actual_checksum != self.checksum:
                print(f"Checksum mismatch! Expected {self.checksum}, got {actual_checksum}")
                return None
        
        return data
    
    def get_progress(self) -> Tuple[int, int, int]:
        """Get decoding progress as (decoded_blocks, total_blocks, percent)."""
        total = self.k
        decoded = len(self.decoded_blocks)
        percent = int(decoded / max(1, total) * 100)
        return (decoded, total, percent)
    
    def get_stats(self) -> dict:
        """Get decoder statistics."""
        return {
            'packets_received': self.packets_received,
            'blocks_decoded': len(self.decoded_blocks),
            'total_blocks': self.k,
            'progress': len(self.decoded_blocks) / max(1, self.k),
            'efficiency': self.k / max(1, self.packets_received) if self.packets_received > 0 else 0
        }


def test_fountain():
    """Test fountain code encoding and decoding."""
    print("Testing Fountain Codes...")
    
    # Test with various data sizes
    test_cases = [
        b"Hello, World!",
        b"A" * 100,
        b"Test data " * 100,
        bytes(range(256)) * 10,  # All byte values
    ]
    
    for i, test_data in enumerate(test_cases):
        print(f"\nTest case {i + 1}: {len(test_data)} bytes")
        
        # Encode
        encoder = FountainEncoder(test_data, block_size=1024)
        print(f"  Source blocks (K): {encoder.k}")
        
        # Generate packets
        packets = list(encoder.generate_packets(max_packets=int(encoder.k * 1.5)))
        print(f"  Generated {len(packets)} packets")
        
        # Decode (simulate packet loss by dropping some)
        decoder = FountainDecoder(block_size=1024)
        
        # Drop first 20% of packets (simulating loss)
        drop_indices = set(random.sample(range(len(packets)), len(packets) // 5))
        
        for j, packet in enumerate(packets):
            if j not in drop_indices:
                decoder.add_packet(packet)
        
        print(f"  Dropped {len(drop_indices)} packets, sent {decoder.packets_received}")
        
        # Try to decode
        decoded = decoder.get_decoded_data()
        
        if decoded == test_data:
            print(f"  ✓ Decoded correctly!")
        else:
            progress = decoder.get_progress()
            print(f"  ✗ Failed: got {len(decoded) if decoded else 0} bytes, progress: {progress[0]}/{progress[1]}")
            if progress[0] < progress[1]:
                print(f"    Missing {progress[1] - progress[0]} blocks")
    
    print("\n" + "=" * 50)
    print("Testing Fountain Codes complete!")


if __name__ == "__main__":
    test_fountain()
