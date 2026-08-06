#!/usr/bin/env python3
"""
VEF-3 CORE - Quick Demo
Generates sample frames to test the visual file transfer system.
"""

import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.fountain import FountainEncoder
from core.frame import FrameEncoder
from core.color_codec import ColorCodec


def quick_demo():
    """Run a quick demonstration of the system."""
    print("=" * 60)
    print("VEF-3 CORE - Quick Demo")
    print("=" * 60)
    
    # Test color codec
    print("\n1. Testing Color Codec...")
    ColorCodec.test_codec()
    
    # Test fountain codes
    print("\n2. Testing Fountain Codes...")
    from core.fountain import FountainEncoder, FountainDecoder
    
    test_data = b"VEF-3 CORE Demo! This message will be encoded and decoded using Fountain Codes."
    print(f"   Original: {test_data[:50]}...")
    
    # Encode
    encoder = FountainEncoder(test_data, block_size=1024)
    print(f"   Source blocks: {encoder.k}")
    
    # Generate some packets (simulate transmission with some loss)
    import random
    random.seed(42)
    
    packets = list(encoder.generate_packets(max_packets=int(encoder.k * 2)))
    print(f"   Generated {len(packets)} packets")
    
    # Drop some packets to simulate loss
    drop_indices = set(random.sample(range(len(packets)), len(packets) // 5))
    print(f"   Simulating {len(drop_indices)} lost packets...")
    
    # Decode
    decoder = FountainDecoder(block_size=1024)
    for i, packet in enumerate(packets):
        if i not in drop_indices:
            decoder.add_packet(packet)
    
    progress = decoder.get_progress()
    print(f"   Decoded: {progress[0]}/{progress[1]} blocks ({progress[2]}%)")
    
    decoded_data = decoder.get_decoded_data()
    if decoded_data == test_data:
        print("   ✓ Data matches!")
    else:
        print(f"   ✗ Mismatch: {len(decoded_data)} vs {len(test_data)}")
    
    # Test frame rendering
    print("\n3. Testing Frame Rendering...")
    frame_encoder = FrameEncoder()
    
    # Calibration frame
    calib_frame = frame_encoder.render_calibration_frame()
    calib_frame.save('/tmp/vef3_demo_calibration.png')
    print(f"   ✓ Calibration frame: {calib_frame.size}")
    
    # Data frames
    output_dir = Path('/tmp/vef3_demo_frames')
    output_dir.mkdir(exist_ok=True)
    
    for i in range(min(5, len(packets))):
        packet = packets[i]
        frame = frame_encoder.render_data_frame(packet, i)
        frame.save(output_dir / f'frame_{i:03d}.png')
    
    print(f"   ✓ Generated {min(5, len(packets))} data frames")
    
    print("\n" + "=" * 60)
    print("Demo complete! Frames saved to:")
    print(f"  - /tmp/vef3_demo_calibration.png")
    print(f"  - {output_dir}/")
    print("=" * 60)


if __name__ == '__main__':
    quick_demo()
