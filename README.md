# MeetSenseAI - Headless VM Deployment

MeetSenseAI is an advanced web-based AI meeting assistant that performs real-time audio transcription, meeting summarization, facial engagement tracking, and multi-user WebRTC video conferencing.

This repository has been fully optimized and prepared to run efficiently on a **Headless Linux Virtual Machine (VM)** (e.g., Ubuntu Server, Debian) without the need for a GUI or display server.

## Features
- **Real-time Transcription & Summarization**: Connects to the device's microphone and provides ongoing text transcripts, automatically summarizing using the Gemini API.
- **Engagement Analytics**: Uses `opencv-python-headless` and a baked-in AI SSD model to evaluate viewer engagement in a fully backend-driven, headless environment.
- **WebRTC Conferencing**: Facilitates peer-to-peer audio/video streaming via websockets.

## Tech Stack
- **Backend**: FastAPI (Python 3), Uvicorn, OpenCV (DNN for headless face detection)
- **Frontend**: React.js, WebRTC, WebSocket API
- **AI Models**: Gemini API (for summarization), MobileNet-SSD (for facial tracking)

## System Requirements
- **OS**: Any Linux Distribution (Ubuntu 20.04/22.04+ or Debian recommended)
- **Dependencies**: 
  - Python 3.9+
  - Node.js 18+ and npm
  - pip (Python package manager)

---

## 🛠️ Installation & Setup (Headless Linux VM)

### 1. Install System Dependencies (Ubuntu/Debian)
Update your package list and install the required OS-level packages:
```bash
sudo apt update
sudo apt install -y nodejs npm
sudo apt install -y python3 python3-pip python3-venv git curl wget
```

### 2. Clone the Repository
SSH into your Linux VM and clone the project:
```bash
git clone https://github.com/FASTANDEXTREME/MeetSenseAI.git
cd MeetSenseAI
```

### 3. Environment Configuration
Create a `.env` file from the supplied example:
```bash
cp .env.example .env
```
Open `.env` using `nano` or `vim` and fill in your API keys:
```bash
nano .env
```
Provide the keys:
```env
OPENAI_API_KEY="your_openai_api_key_here"
GOOGLE_API_KEY="your_google_api_key_here"
```

---

## 🚀 How to Run the Project

### Method 1: Using the automated `run.sh` script
We provide an all-in-one execution script:
```bash
# Make the script executable
chmod +x run.sh

# Run the script
./run.sh
```
This script will:
1. Automatically install Python requirements (`requirements.txt`).
2. Automatically install Node dependencies (`npm install`).
3. Start the FastAPI server in the background on port `8000`.
4. Start the React Frontend server on port `3000`.

*Note: Since this relies on `npm start`, it's recommended mainly for development or testing VM use.*

### Method 2: Running As Background Services (Production/Systemd)
If you close your SSH terminal, the `./run.sh` processes will terminate. To keep them running persistently:

**Using `nohup`:**
```bash
nohup ./run.sh > meetsense.log 2>&1 &
```

**Using `pm2` (Recommended for Node & Python apps):**
```bash
# Install pm2 globally
sudo npm i -g pm2

# Start Backend
pm2 start "venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000" --name "meetsense-backend"

# Start Frontend
cd frontend
pm2 start "npm start" --name "meetsense-frontend"

# Save pm2 list to restart on VM reboot
pm2 save
pm2 startup
```

---

## Accessing the App

Once running, navigate to the frontend URL via a web browser on your *local* machine (not the VM):
```text
http://<YOUR_VM_PUBLIC_IP_OR_DOMAIN>:3000
```
*(Ensure that ports `3000` and `8000` are open in your server's security group/ufw firewall rules!)*

---

## 🛑 Troubleshooting

- **WebSocket Connection Fails (`ws://` error in browser console):**
  - Ensure the backend is successfully running on port `8000`.
  - Ensure your VM's firewall permits inbound TCP traffic on port `8000`.
- **OpenCV/Import Errors:**
  - The project intentionally uses `opencv-python-headless`. If you install `opencv-python` instead, you may encounter missing `libGL.so.1` or X11 errors on a headless server. Stick to `requirement.txt`.
- **Camera/Mic not working on Frontend:**
  - Modern web browsers block `getUserMedia` (camera/mic) over standard HTTP unless hosted on `localhost`. To access the site remotely (via your VM's IP), you *must* secure the frontend domain with an SSL Certificate (`HTTPS`) or use an SSH Port Forward tunnel for local testing.
  - **SSH Tunnel Example (to spoof localhost):** 
    Run this on your *local computer* to access the VM safely:
    ```bash
    ssh -L 3000:localhost:3000 -L 8000:localhost:8000 user@vm-ip
    ```
    Then visit `http://localhost:3000` locally.
