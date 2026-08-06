#!/usr/bin/env python3
"""
VEF-3 CORE - Video Generator
Generates video files for visual file transfer.
"""

import argparse
import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.fountain import FountainEncoder
from core.frame import FrameEncoder, FRAME_COLS, FRAME_ROWS, BLOCK_SIZE


def generate_transfer_video(
    file_path: str,
    output_path: str = None,
    fps: int = 30,
    block_size: int = 8,
    target_frames: int = None,
    show_preview: bool = False
) -> str:
    """
    Generate a video file for transferring a file visually.

    Args:
        file_path: Path to the file to transfer
        output_path: Output video path (default: input_name.vef3.mp4)
        fps: Frames per second (30 or 60)
        block_size: Size of each color block in pixels
        target_frames: Target number of frames (auto-calculated if None)
        show_preview: Show preview frames during generation

    Returns:
        Path to generated video file
    """
    print(f"=" * 60)
    print(f"VEF-3 CORE - Video Generator")
    print(f"=" * 60)

    # Read input file
    input_path = Path(file_path)
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    file_data = input_path.read_bytes()
    file_size = len(file_data)

    print(f"\nInput file: {input_path.name}")
    print(f"File size: {file_size:,} bytes ({file_size / 1024:.2f} KB)")

    # Calculate transfer parameters
    from core.color_codec import BLOCKS_PER_FRAME, DATA_BLOCKS_PER_FRAME, BITS_PER_BLOCK, BYTES_PER_FRAME

    bytes_per_frame = BYTES_PER_FRAME
    k = (file_size + 1023) // 1024  # Number of 1KB blocks

    print(f"\nTransfer Parameters:")
    print(f"  Frame size: {FRAME_COLS}x{FRAME_ROWS} blocks ({BLOCKS_PER_FRAME} blocks)")
    print(f"  Data blocks per frame: {DATA_BLOCKS_PER_FRAME}")
    print(f"  Bytes per frame: ~{bytes_per_frame} bytes")
    print(f"  Fountain blocks (K): {k}")
    print(f"  FPS: {fps}")

    # Estimate transfer time
    transfer_rate = bytes_per_frame * fps
    estimated_seconds = file_size / transfer_rate

    print(f"\nEstimated transfer:")
    print(f"  Channel rate: {transfer_rate / 1024:.1f} KB/s")
    print(f"  Time: {estimated_seconds:.1f} seconds ({estimated_seconds/60:.1f} minutes)")
    print(f"  With 30% overhead: ~{estimated_seconds * 1.3:.1f} seconds")

    # Generate fountain-encoded packets
    print(f"\nGenerating fountain-encoded packets...")
    encoder = FountainEncoder(file_data, block_size=1024)

    # Generate enough packets (about 2x the number of blocks for robustness)
    num_packets = target_frames or int(k * 2.1)
    packets = list(encoder.generate_packets(max_packets=num_packets))

    print(f"  Generated {len(packets)} packets")

    # Create frame encoder
    frame_encoder = FrameEncoder(block_size_pixels=block_size)

    # Generate frames
    print(f"\nGenerating {len(packets) + 1} frames...")
    frames = []

    # Frame 0: Calibration
    print(f"  Frame 0: Calibration")
    calib_frame = frame_encoder.render_calibration_frame()
    frames.append(calib_frame)

    # Frames 1-N: Data
    for i, packet in enumerate(packets):
        if (i + 1) % 50 == 0:
            print(f"  Frame {i + 1}/{len(packets)}...")

        data_frame = frame_encoder.render_data_frame(packet, i + 1)
        frames.append(data_frame)

        if show_preview and (i + 1) % 100 == 0:
            data_frame.save(f'/tmp/preview_frame_{i+1}.png')

    # Save frames as PNG sequence (for debugging)
    print(f"\nSaving frame sequence...")
    frame_dir = Path(output_path).parent / f"{input_path.stem}_frames" if output_path else Path('/tmp/vef3_frames')
    frame_dir.mkdir(parents=True, exist_ok=True)

    for i, frame in enumerate(frames):
        frame.save(frame_dir / f"frame_{i:04d}.png")

    print(f"  Saved {len(frames)} frames to {frame_dir}")

    # Create video using ffmpeg
    if output_path is None:
        output_path = str(input_path.parent / f"{input_path.stem}.vef3.mp4")

    print(f"\nCreating video...")
    try:
        import subprocess

        cmd = [
            'ffmpeg', '-y',
            '-framerate', str(fps),
            '-i', str(frame_dir / 'frame_%04d.png'),
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-frames:v', str(len(frames)),
            output_path
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0:
            video_size = os.path.getsize(output_path)
            print(f"\n✓ Video created: {output_path}")
            print(f"  Video size: {video_size / 1024 / 1024:.2f} MB")
            print(f"  Total frames: {len(frames)}")
        else:
            print(f"  FFmpeg error: {result.stderr}")
            print(f"\n  Note: Install ffmpeg for video creation:")
            print(f"    sudo apt install ffmpeg")
            print(f"\n  Frames saved to: {frame_dir}")
            print(f"  Convert to video with:")
            print(f"    ffmpeg -framerate {fps} -i {frame_dir}/frame_%04d.png -c:v libx264 output.mp4")
            output_path = str(frame_dir)

    except FileNotFoundError:
        print(f"\n⚠ FFmpeg not found. Frames saved to: {frame_dir}")
        print(f"\nTo create video, install ffmpeg and run:")
        print(f"  ffmpeg -framerate {fps} -i {frame_dir}/frame_%04d.png -c:v libx264 {input_path.stem}.mp4")
        output_path = str(frame_dir)

    # Print summary
    print(f"\n" + "=" * 60)
    print(f"Transfer Summary")
    print(f"=" * 60)
    print(f"  File: {input_path.name} ({file_size:,} bytes)")
    print(f"  Output: {output_path}")
    print(f"  Frames: {len(frames)} ({fps} fps)")
    print(f"  Play time: {len(frames) / fps:.1f} seconds")
    print(f"\nTo receive this file:")
    print(f"  1. Open the VEF-3 decoder on your phone")
    print(f"  2. Point camera at screen showing the video")
    print(f"  3. Wait for transfer to complete")
    print(f"=" * 60)

    return output_path


def generate_calibration_video(output_path: str = '/tmp/calibration.vef3.mp4', fps: int = 30):
    """Generate a calibration video loop."""
    print("Generating calibration video...")

    frame_encoder = FrameEncoder()
    frames = [frame_encoder.render_calibration_frame() for _ in range(30)]  # 1 second loop

    # Save frames
    frame_dir = Path(output_path).parent / 'calibration_frames'
    frame_dir.mkdir(parents=True, exist_ok=True)

    for i, frame in enumerate(frames):
        frame.save(frame_dir / f"frame_{i:04d}.png")

    # Create video
    try:
        import subprocess
        cmd = [
            'ffmpeg', '-y',
            '-framerate', str(fps),
            '-i', str(frame_dir / 'frame_%04d.png'),
            '-loop', '1',
            '-c:v', 'libx264',
            '-tune', 'stillimage',
            '-pix_fmt', 'yuv420p',
            output_path
        ]
        subprocess.run(cmd, capture_output=True)
        print(f"Calibration video saved: {output_path}")
    except FileNotFoundError:
        print(f"Frames saved to: {frame_dir}")


def main():
    parser = argparse.ArgumentParser(
        description='VEF-3 CORE - Generate visual transfer video',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s document.pdf
  %(prog)s image.png -o output.mp4 --fps 60
  %(prog)s video.mp4 --show-preview
        """
    )

    parser.add_argument('input_file', help='File to transfer')
    parser.add_argument('-o', '--output', help='Output video path')
    parser.add_argument('--fps', type=int, default=30, choices=[30, 60], help='Frames per second (default: 30)')
    parser.add_argument('--block-size', type=int, default=8, help='Block size in pixels (default: 8)')
    parser.add_argument('--frames', type=int, help='Target number of frames')
    parser.add_argument('--preview', action='store_true', help='Show preview frames')
    parser.add_argument('--calibration', action='store_true', help='Generate calibration video only')

    args = parser.parse_args()

    if args.calibration:
        generate_calibration_video(args.output or '/tmp/calibration.vef3.mp4', args.fps)
    else:
        generate_transfer_video(
            args.input_file,
            args.output,
            args.fps,
            args.block_size,
            args.frames,
            args.preview
        )


if __name__ == '__main__':
    main()
