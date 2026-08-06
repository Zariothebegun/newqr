"""WSGI entry point for the VEF-3 sender and decoder.

Render imports the application passed to Gunicorn as ``module:object``.  This
module deliberately has no third-party imports at module load time, so the
health check can still be imported while the rest of the project is being
installed.  The public entry point is therefore::

    gunicorn wsgi:app --bind 0.0.0.0:$PORT

The same ``app`` object can be used by any WSGI-compatible server locally.
"""

from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import unquote


BASE_DIR = Path(__file__).resolve().parent
DECODER_DIR = BASE_DIR / "decoder"
INDEX_FILE = DECODER_DIR / "index.html"
SEND_DIR = BASE_DIR / "send"
SEND_INDEX_FILE = SEND_DIR / "index.html"

StartResponse = Callable[[str, list[tuple[str, str]], object | None], None]


# These headers are shared by the API and the static decoder because the
# decoder may be opened directly from another device on the local network.
_CORS_HEADERS = (
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type"),
)


def _finish(
    start_response: StartResponse,
    status: str,
    body: bytes,
    content_type: str,
    method: str,
    extra_headers: Iterable[tuple[str, str]] = (),
) -> list[bytes]:
    """Send a small WSGI response and honor ``HEAD`` requests."""

    headers = [
        ("Content-Type", content_type),
        # Content-Length describes the GET representation even for HEAD.
        ("Content-Length", str(len(body))),
        *(_CORS_HEADERS),
        *extra_headers,
    ]
    start_response(status, headers)
    return [b""] if method == "HEAD" else [body]


def _json_response(payload: dict[str, object]) -> bytes:
    """Serialize API data consistently and keep the response UTF-8 encoded."""

    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )


def _safe_decoder_file(path: str) -> Path | None:
    """Resolve a decoder asset without allowing path traversal."""

    # The WSGI server normally gives us a decoded PATH_INFO.  Decode once more
    # for servers that leave percent escapes in it, then reject NUL bytes and
    # traversal outside ``decoder``.
    try:
        decoded_path = unquote(path, encoding="utf-8", errors="strict")
    except UnicodeDecodeError:
        return None

    if "\x00" in decoded_path:
        return None

    relative_path = decoded_path.lstrip("/")
    candidate = (DECODER_DIR / relative_path).resolve()
    try:
        candidate.relative_to(DECODER_DIR.resolve())
    except ValueError:
        return None

    return candidate


def create_app() -> Callable:
    """Create the WSGI application.

    Keeping the factory makes the entry point straightforward to exercise in
    tests while ``app`` below remains the object Gunicorn imports.
    """

    def application(environ: dict, start_response: StartResponse) -> list[bytes]:
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        path = environ.get("PATH_INFO", "/") or "/"

        if method == "OPTIONS":
            return _finish(start_response, "204 No Content", b"", "text/plain", method)

        if method not in {"GET", "HEAD"}:
            return _finish(
                start_response,
                "405 Method Not Allowed",
                b"Method Not Allowed",
                "text/plain; charset=utf-8",
                method,
                (("Allow", "GET, HEAD, OPTIONS"),),
            )

        page_files = {
            "/": INDEX_FILE,
            "/index.html": INDEX_FILE,
            "/receive": INDEX_FILE,
            "/receive/": INDEX_FILE,
            "/receive/index.html": INDEX_FILE,
            "/send": SEND_INDEX_FILE,
            "/send/": SEND_INDEX_FILE,
            "/send/index.html": SEND_INDEX_FILE,
        }
        if path in page_files:
            page_file = page_files[path]
            if not page_file.is_file():
                return _finish(
                    start_response,
                    "503 Service Unavailable",
                    b"Web interface is unavailable",
                    "text/plain; charset=utf-8",
                    method,
                )
            body = page_file.read_bytes()
            return _finish(
                start_response,
                "200 OK",
                body,
                "text/html; charset=utf-8",
                method,
                (("Cache-Control", "no-cache"),),
            )

        if path == "/health":
            body = _json_response(
                {
                    "status": "ok",
                    "service": "VEF-3 Decoder",
                    "version": "1.0.0",
                }
            )
            return _finish(
                start_response,
                "200 OK",
                body,
                "application/json; charset=utf-8",
                method,
            )

        if path == "/api/info":
            body = _json_response(
                {
                    "name": "VEF-3 CORE",
                    "version": "1.0.0",
                    "description": "Visual Encoding File Transfer",
                    "endpoints": {
                        "/send/": "Choose a file and show transfer blocks",
                        "/receive/": "Read blocks with the camera",
                        "/health": "Health check",
                        "/api/info": "Service information",
                    },
                }
            )
            return _finish(
                start_response,
                "200 OK",
                body,
                "application/json; charset=utf-8",
                method,
            )

        # The current decoder is a self-contained HTML document, but serving
        # its assets safely here makes the WSGI entry point future-proof.
        if path.startswith("/static/") or path.startswith("/assets/"):
            asset = _safe_decoder_file(path)
            if asset is not None and asset.is_file():
                content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
                return _finish(
                    start_response,
                    "200 OK",
                    asset.read_bytes(),
                    content_type,
                    method,
                    (("Cache-Control", "public, max-age=3600"),),
                )

        return _finish(
            start_response,
            "404 Not Found",
            b"Not Found",
            "text/plain; charset=utf-8",
            method,
        )

    return application


# Gunicorn imports this exact module-level object.
app = create_app()
# ``application`` is also provided for WSGI servers that use that convention.
application = app


if __name__ == "__main__":
    from wsgiref.simple_server import make_server

    port = int(os.environ.get("PORT", "5000"))
    with make_server("0.0.0.0", port, app) as server:
        print(f"Serving VEF-3 Decoder on http://0.0.0.0:{port}")
        server.serve_forever()
