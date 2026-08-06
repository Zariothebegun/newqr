"""
VEF-3 CORE - WSGI Application for Render Deployment
Serves the decoder web interface and optionally the encoder API.
"""

import os
from pathlib import Path
from werkzeug.wsgi import DispatcherMiddleware
from werkzeug.serving import run_simple


def create_app():
    """Create the WSGI application."""
    from werkzeug.wrappers import Request, Response
    from werkzeug.exceptions import HTTPException
    import json
    
    # Get the base directory
    BASE_DIR = Path(__file__).parent
    DECODER_DIR = BASE_DIR / 'decoder'
    
    @Request.application
    def application(request):
        """Main application dispatcher."""
        path = request.path
        
        # CORS headers for all responses
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        }
        
        if request.method == 'OPTIONS':
            return Response('', status=200, headers=headers)
        
        # Root path - serve decoder
        if path == '/' or path == '/index.html':
            index_path = DECODER_DIR / 'index.html'
            if index_path.exists():
                with open(index_path, 'r') as f:
                    content = f.read()
                return Response(content, mimetype='text/html', headers=headers)
            return Response('Decoder not found', status=404)
        
        # Health check
        if path == '/health':
            return Response(json.dumps({
                'status': 'ok',
                'service': 'VEF-3 Decoder',
                'version': '1.0.0'
            }), mimetype='application/json', headers=headers)
        
        # Serve static files from decoder directory
        if path.startswith('/static/') or path.startswith('/assets/'):
            file_path = DECODER_DIR / path.lstrip('/')
            if file_path.exists() and file_path.is_file():
                # Determine mimetype
                ext = file_path.suffix.lower()
                mimetypes = {
                    '.html': 'text/html',
                    '.js': 'application/javascript',
                    '.css': 'text/css',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.svg': 'image/svg+xml',
                    '.json': 'application/json',
                    '.woff': 'font/woff',
                    '.woff2': 'font/woff2',
                }
                mimetype = mimetypes.get(ext, 'application/octet-stream')
                
                with open(file_path, 'rb') as f:
                    return Response(f.read(), mimetype=mimetype, headers=headers)
        
        # API endpoints
        if path == '/api/info':
            return Response(json.dumps({
                'name': 'VEF-3 CORE Decoder API',
                'version': '1.0.0',
                'description': 'Visual Encoding File Transfer - Decoder Service',
                'endpoints': {
                    '/health': 'Health check',
                    '/api/info': 'This info',
                    '/api/generate': 'Generate test frames (POST)'
                }
            }), mimetype='application/json', headers=headers)
        
        # 404 for everything else
        return Response('Not Found', status=404, headers=headers)
    
    return application


# Create app instance
app = create_app()


if __name__ == '__main__':
    # Development server
    port = int(os.environ.get('PORT', 5000))
    run_simple('0.0.0.0', port, app, use_debugger=True, use_reloader=True)
