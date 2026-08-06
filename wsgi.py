"""
VEF-3 CORE - WSGI Server for Render
Simple WSGI application.
"""

import os
from pathlib import Path


def create_app():
    """Create WSGI application."""
    BASE_DIR = Path(__file__).parent
    DECODER_DIR = BASE_DIR / 'decoder'
    
    def app(environ, start_response):
        path = environ.get('PATH_INFO', '/')
        
        # CORS headers
        headers = [
            ('Access-Control-Allow-Origin', '*'),
            ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
        ]
        
        if path == '/' or path == '/index.html':
            index_file = DECODER_DIR / 'index.html'
            if index_file.exists():
                with open(index_file, 'r') as f:
                    content = f.read()
                start_response('200 OK', headers + [('Content-Type', 'text/html')])
                return [content.encode()]
        
        if path == '/health':
            start_response('200 OK', headers + [('Content-Type', 'application/json')])
            return [b'{"status": "ok", "service": "VEF-3 Decoder"}']
        
        # 404
        start_response('404 Not Found', headers)
        return [b'Not Found']
    
    return app


app = create_app()


if __name__ == '__main__':
    from werkzeug.serving import run_simple
    port = int(os.environ.get('PORT', 5000))
    run_simple('0.0.0.0', port, app)
