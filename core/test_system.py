#!/usr/bin/env python3
"""
VEF-3 CORE - Complete System Test
Generates frames, simulates reading, verifies data integrity.
"""

import sys
import os
from pathlib import Path
import hashlib
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.fountain import OptimizedFountainEncoder, BeliefPropagationDecoder, AdaptiveFountainSystem
from core.color_codec import ColorCodec
from core.calibration import ColorCalibrator
from PIL import Image, ImageDraw
import random


# Frame configuration
FRAME_COLS = 80
FRAME_ROWS = 50
BLOCK_SIZE = 8
FRAME_WIDTH = FRAME_COLS * BLOCK_SIZE
FRAME_HEIGHT = FRAME_ROWS * BLOCK_SIZE


def generate_test_frame(encoder: OptimizedFountainEncoder, packet_id: int, 
                       calibrator: ColorCalibrator = None) -> Image.Image:
    """Generate a test frame from a fountain packet."""
    packet = encoder.generate_packet(packet_id)
    
    # Convert packet data to values
    data = packet['data']
    values = ColorCodec.bytes_to_values(data)
    
    # Pad to fill frame
    frame_values = values + [0] * (FRAME_COLS * (FRAME_ROWS - 2))  # Leave margin for calibration
    
    # Create image
    img = Image.new('RGB', (FRAME_WIDTH, FRAME_HEIGHT), (0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Draw corner markers
    draw.rectangle([10, 10, 40, 15], fill=(0, 255, 0))  # TL - Green
    draw.rectangle([10, 10, 15, 40], fill=(0, 255, 0))
    
    draw.rectangle([FRAME_WIDTH - 40, 10, FRAME_WIDTH - 10, 15], fill=(255, 0, 0))  # TR - Red
    draw.rectangle([FRAME_WIDTH - 15, 10, FRAME_WIDTH - 10, 40], fill=(255, 0, 0))
    
    draw.rectangle([10, FRAME_HEIGHT - 15, 40, FRAME_HEIGHT - 10], fill=(0, 0, 255))  # BL - Blue
    draw.rectangle([10, FRAME_HEIGHT - 40, 15, FRAME_HEIGHT - 10], fill=(0, 0, 255))
    
    draw.rectangle([FRAME_WIDTH - 40, FRAME_HEIGHT - 15, FRAME_WIDTH - 10, FRAME_HEIGHT - 10], fill=(255, 255, 0))  # BR - Yellow
    draw.rectangle([FRAME_WIDTH - 15, FRAME_HEIGHT - 40, FRAME_WIDTH - 10, FRAME_HEIGHT - 10], fill=(255, 255, 0))
    
    # Draw data blocks
    for i, value in enumerate(frame_values[:FRAME_COLS * (FRAME_ROWS - 2)]):
        row = 2 + i // FRAME_COLS
        col = i % FRAME_COLS
        
        if row >= FRAME_ROWS - 1:
            break
        
        x = col * BLOCK_SIZE
        y = row * BLOCK_SIZE
        
        rgb = ColorCodec.value_to_rgb(value)
        draw.rectangle([x, y, x + BLOCK_SIZE - 1, y + BLOCK_SIZE - 1], fill=rgb)
    
    # Draw calibration grid (8x8) at top-left data area
    if calibrator:
        grid_x, grid_y = 10, 5
        colors = calibrator.REFERENCE_COLORS
        
        for i, color in enumerate(colors):
            row = i // 8
            col = i % 8
            
            x = (grid_x + col) * BLOCK_SIZE
            y = (grid_y + row) * BLOCK_SIZE
            
            # Add some noise to simulate camera capture
            noise = tuple(max(0, min(255, c + random.randint(-20, 20))) for c in color)
            draw.rectangle([x, y, x + BLOCK_SIZE - 1, y + BLOCK_SIZE - 1], fill=noise)
    
    return img


def simulate_read_frame(img: Image.Image, calibrator: ColorCalibrator, noise_level: int = 15) -> list:
    """Simulate reading a frame from camera with noise."""
    img_array = np.array(img)
    values = []
    
    # Read data blocks (rows 2 to 47)
    for row in range(2, 48):
        for col in range(FRAME_COLS):
            x = col * BLOCK_SIZE + BLOCK_SIZE // 2
            y = row * BLOCK_SIZE + BLOCK_SIZE // 2
            
            # Sample 4x4 region
            x1, x2 = max(0, x - 2), min(img.width, x + 2)
            y1, y2 = max(0, y - 2), min(img.height, y + 2)
            
            region = img_array[y1:y2, x1:x2]
            
            # Add noise
            noise = np.random.randint(-noise_level, noise_level + 1, 3)
            avg = np.clip(region.mean(axis=(0, 1)) + noise, 0, 255).astype(int)
            
            # Decode color
            value = calibrator.decode_color(avg[0], avg[1], avg[2])
            values.append(value)
    
    return values


def extract_calibration_from_frame(img: Image.Image, calibrator: ColorCalibrator):
    """Extract calibration data from a frame."""
    img_array = np.array(img)
    
    grid_x, grid_y = 10, 5
    
    for i in range(64):
        row = i // 8
        col = i % 8
        
        x = (grid_x + col) * BLOCK_SIZE + BLOCK_SIZE // 2
        y = (grid_y + row) * BLOCK_SIZE + BLOCK_SIZE // 2
        
        x1, x2 = max(0, x - 3), min(img.width, x + 3)
        y1, y2 = max(0, y - 3), min(img.height, y + 3)
        
        region = img_array[y1:y2, x1:x2]
        avg = region.mean(axis=(0, 1)).astype(int)
        
        # Expected color
        ref = calibrator.REFERENCE_COLORS[i]
        
        # Add calibration sample
        calibrator.add_calibration_sample(tuple(avg), ref)
    
    calibrator.calibrate()


def full_system_test():
    """Complete end-to-end system test."""
    print("=" * 70)
    print("VEF-3 CORE - Full System Test")
    print("=" * 70)
    
    # Test data - a meaningful message
    test_data = b"""
    VEF-3 CORE - Complete Visual File Transfer System
    
    This is a test of the complete VEF-3 system including:
    - Fountain codes for robust encoding
    - Color codec for visual representation
    - Frame generation and reading
    - Calibration and noise handling
    
    If you can read this, the system works!
    
    Technical specs:
    - 80x50 blocks per frame
    - 6 bits per block (64 colors)
    - ~2.4 KB per frame
    - Fountain codes with ~20% overhead
    
    Created by Arena.ai Agent
    """
    
    print(f"\n1. Original data: {len(test_data)} bytes")
    print(f"   MD5: {hashlib.md5(test_data).hexdigest()}")
    
    # Initialize system
    print("\n2. Initializing Adaptive Fountain System...")
    system = AdaptiveFountainSystem(test_data, block_size=1024)
    print(f"   Source blocks (K): {system.encoder.k}")
    
    # Generate packets
    print("\n3. Generating fountain-encoded packets...")
    packets = system.generate_batch()
    print(f"   Generated {len(packets)} packets")
    
    # Create calibrator for frame generation
    frame_calibrator = ColorCalibrator()
    frame_calibrator.calibrate()  # Perfect calibration for generation
    
    # Generate frames
    print("\n4. Generating visual frames...")
    frames = []
    
    # First frame is calibration
    calib_frame = generate_test_frame(system.encoder, 0, frame_calibrator)
    frames.append(calib_frame)
    
    # Data frames
    for i in range(min(10, len(packets))):
        frame = generate_test_frame(system.encoder, i, frame_calibrator)
        frames.append(frame)
    
    print(f"   Generated {len(frames)} frames ({len(frames) - 1} data frames)")
    
    # Save frames for inspection
    frame_dir = Path('/tmp/vef3_test_frames')
    frame_dir.mkdir(exist_ok=True)
    
    for i, frame in enumerate(frames):
        frame.save(frame_dir / f'frame_{i:03d}.png')
    
    print(f"   Frames saved to {frame_dir}")
    
    # Simulate reading frames with camera noise
    print("\n5. Simulating frame reading with camera noise...")
    
    # Create reader calibrator (needs calibration from first frame)
    reader_calibrator = ColorCalibrator()
    
    # Process first frame for calibration
    calib_frame_read = Image.open(frame_dir / 'frame_000.png')
    extract_calibration_from_frame(calib_frame_read, reader_calibrator)
    print(f"   Calibration confidence: {reader_calibrator.get_confidence():.0%}")
    
    # Read data frames with noise
    received_packets = []
    
    for i in range(1, len(frames)):
        frame = Image.open(frame_dir / f'frame_{i:03d}.png')
        
        # Simulate reading with noise
        values = simulate_read_frame(frame, reader_calibrator, noise_level=15)
        
        # Convert values back to bytes
        data = ColorCodec.values_to_bytes(values)
        
        if len(data) >= 1024:
            received_packets.append({
                'block_indices': [i - 1],
                'num_blocks': system.encoder.k,
                'data': data[:1024],
                'checksum': '',
                'original_size': len(test_data)
            })
    
    print(f"   Read {len(received_packets)} packets from frames")
    
    # Decode
    print("\n6. Decoding received packets...")
    decoder = BeliefPropagationDecoder()
    
    for packet in received_packets:
        complete = decoder.add_packet(packet)
        if complete:
            break
    
    progress = decoder.get_progress()
    print(f"   Decoding progress: {progress[0]}/{progress[1]} blocks ({progress[2]}%)")
    
    # Try to get decoded data
    decoded_data = decoder.get_decoded_data()
    
    if decoded_data:
        print(f"\n   ✓ Successfully decoded {len(decoded_data)} bytes")
        print(f"   MD5: {hashlib.md5(decoded_data).hexdigest()}")
        
        if decoded_data == test_data:
            print("\n   ✓✓✓ PERFECT MATCH! System works correctly! ✓✓✓")
        else:
            # Check partial match
            common_prefix = 0
            for i in range(min(len(decoded_data), len(test_data))):
                if decoded_data[i] == test_data[i]:
                    common_prefix = i + 1
                else:
                    break
            
            print(f"\n   Partial match: {common_prefix}/{len(test_data)} bytes ({common_prefix/len(test_data)*100:.1f}%)")
            print(f"   Original preview: {test_data[:50]}")
            print(f"   Decoded preview:  {decoded_data[:50]}")
    else:
        print("\n   ✗ Decoding failed - need more packets")
        
        # Try adaptive system
        print("\n7. Trying adaptive encoding with more packets...")
        
        all_packets = list(system.encoder.generate_packets(int(system.encoder.k * 3)))
        received_all = []
        
        for i, packet in enumerate(all_packets[:15]):
            if i < len(frames):
                frame = Image.open(frame_dir / f'frame_{i:03d}.png')
                values = simulate_read_frame(frame, reader_calibrator, noise_level=20)
                data = ColorCodec.values_to_bytes(values)
                
                if len(data) >= 1024:
                    received_all.append({
                        'block_indices': packet['block_indices'],
                        'num_blocks': packet['num_blocks'],
                        'data': data[:1024],
                        'checksum': packet['checksum'],
                        'original_size': packet['original_size']
                    })
        
        decoder2 = BeliefPropagationDecoder()
        for p in received_all:
            decoder2.add_packet(p)
            if decoder2.is_complete():
                break
        
        decoded2 = decoder2.get_decoded_data()
        if decoded2:
            print(f"   ✓ Adaptive decode success: {len(decoded2)} bytes")
        else:
            print("   ✗ Still failing - noise too high for current implementation")
    
    # Statistics
    print("\n" + "=" * 70)
    print("System Statistics:")
    print("=" * 70)
    stats = decoder.get_stats() if 'decoder' in dir() else {}
    print(f"  Packets received: {stats.get('packets_received', 0)}")
    print(f"  Blocks decoded: {stats.get('blocks_decoded', 0)}/{stats.get('total_blocks', 0)}")
    print(f"  Pending equations: {stats.get('pending_equations', 0)}")
    print(f"  Efficiency: {stats.get('efficiency', 0):.2f}")
    print("=" * 70)
    
    return decoded_data is not None and decoded_data == test_data


if __name__ == '__main__':
    success = full_system_test()
    sys.exit(0 if success else 1)
