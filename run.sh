#!/usr/bin/env bash
# Quick Start Script for Kite Pulse Dashboard

echo "=========================================================="
echo " Starting Kite Pulse Dashboard (Low Token Utilization)    "
echo "=========================================================="

# Check if python3 is available
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required."
    exit 1
fi

# Run FastAPI backend with Uvicorn
python3 main.py
