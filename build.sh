#!/usr/bin/env bash
# Render build command for deployments that use this script directly.
set -euo pipefail

python -m pip install --upgrade pip
python -m pip install -r requirements.txt
