"""VEF-3 CORE modules for visual file transfer.

The public codec classes are loaded lazily so lightweight pieces such as the
wire protocol can be used by deployment checks without importing NumPy/Pillow
first.  Importing ``from core import FountainEncoder`` keeps the old API.
"""

__all__ = [
    "FountainEncoder",
    "FountainDecoder",
    "AdaptiveFountainSystem",
    "ColorCodec",
    "FrameEncoder",
    "FrameDecoder",
    "ColorCalibrator",
    "FrameVerifier",
    "PacketReconstructor",
]


def __getattr__(name):
    if name in {"FountainEncoder", "FountainDecoder", "AdaptiveFountainSystem"}:
        from .fountain import AdaptiveFountainSystem, FountainDecoder, FountainEncoder

        return {
            "FountainEncoder": FountainEncoder,
            "FountainDecoder": FountainDecoder,
            "AdaptiveFountainSystem": AdaptiveFountainSystem,
        }[name]
    if name == "ColorCodec":
        from .color_codec import ColorCodec

        return ColorCodec
    if name in {"FrameEncoder", "FrameDecoder"}:
        from .frame import FrameDecoder, FrameEncoder

        return {"FrameEncoder": FrameEncoder, "FrameDecoder": FrameDecoder}[name]
    if name in {"ColorCalibrator", "FrameVerifier", "PacketReconstructor"}:
        from .calibration import ColorCalibrator, FrameVerifier, PacketReconstructor

        return {
            "ColorCalibrator": ColorCalibrator,
            "FrameVerifier": FrameVerifier,
            "PacketReconstructor": PacketReconstructor,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
