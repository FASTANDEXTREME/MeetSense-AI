#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "======================================"
echo " Starting MeetSenseAI (Headless Mode) "
echo "======================================"

# 1. Install Backend Dependencies
echo "--> Installing Python backend dependencies..."
pip install -r requirement.txt

# 2. Install Frontend Dependencies
echo "--> Installing Node.js frontend dependencies..."
cd frontend
npm install
cd ..

# 3. Start the Backend
echo "--> Starting FastAPI Backend on port 8000..."
# Running in the background
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# 4. Start the Frontend
echo "--> Starting React Frontend on port 3000..."
cd frontend
# Start the development server (runs on 3000 by default but we enforce it just in case)
PORT=3000 BROWSER=none npm start &
FRONTEND_PID=$!
cd ..

echo "======================================"
echo " MeetSenseAI is now up and running!   "
echo " Backend running at: http://<VM_IP>:8000"
echo " Frontend running at: http://<VM_IP>:3000"
echo " Press Ctrl+C to stop all services.   "
echo "======================================"

# Handle termination gracefully
trap "echo 'Stopping services...'; kill $BACKEND_PID $FRONTEND_PID; exit 0" SIGINT SIGTERM

# Wait for background processes to keep script alive
wait $BACKEND_PID $FRONTEND_PID
