# MeetSenseAI — Smart Meeting Assistant

MeetSenseAI is a web-based AI meeting assistant that provides real-time audio transcription, incremental AI meeting summarization, facial engagement & head-pose tracking, and multi-user WebRTC video conferencing.

It runs locally on **Windows, macOS, and Linux** and is ready for **Headless Cloud VM deployment (Microsoft Azure / AWS / GCP)** without requiring a GUI or display server.

## Features
- **Real-Time Transcription & Talk-Time Analytics**: Live word-by-word speech captions via Web Speech API (Chrome/Edge) with automatic **Groq Whisper (`whisper-large-v3-turbo`)** fallback for privacy-hardened browsers like **Brave** and **Firefox**, plus case/punctuation-aware deduplication and per-speaker talk-time tracking.
- **Incremental AI Summarization**: Extracts per-speaker key points, action items, decisions, and meeting sentiment via **Groq** (`openai/gpt-oss-20b` by default — lightweight & Free Tier eligible).
- **Headless Facial Engagement Tracking**: Uses `opencv-python-headless` with OpenCV's **`FaceDetectorYN` (YuNet ONNX)** detector (compatible with both OpenCV 4.x and 5.x) to evaluate face presence and 5-landmark head-pose orientation (`Attentive` vs `Looking Away`).
- **Multi-Peer WebRTC Conferencing**: Peer-to-peer audio/video streaming with participant name badges, active-speaker highlights, audio/video mute controls, and automatic peer disconnect cleanup.

## Tech Stack
- **Backend**: FastAPI (Python 3.10+), Uvicorn, OpenCV (`FaceDetectorYN` + YuNet ONNX), Groq Async SDK
- **Frontend**: React, WebRTC, Web Speech API + MediaRecorder Whisper Fallback, WebSocket API
- **AI Models**: `openai/gpt-oss-20b` & `whisper-large-v3-turbo` (Groq Cloud API), `face_detection_yunet_2023mar.onnx` (OpenCV Zoo)

---

## Local Development Setup

### 1. Clone & Configure `.env`
```bash
git clone https://github.com/FASTANDEXTREME/MeetSense-AI.git
cd MeetSense-AI
cp .env.example .env
```
Edit `.env` and set your free [Groq API key](https://console.groq.com/keys):
```env
GROQ_API_KEY="your_groq_api_key_here"
GROQ_MODEL="openai/gpt-oss-20b"
```

### 2A. Run Locally on Windows (PowerShell)
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```
*(Or run Backend and Frontend in two separate terminals: `python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` and `cd frontend && npm start`.)*

### 2B. Run Locally on Linux / macOS
```bash
chmod +x run.sh
./run.sh
```

Open `http://localhost:3000` in your browser.

---

## Microsoft Azure VM Deployment Guide (Ubuntu 22.04 / 24.04 LTS)

> **Important Browser Requirement (`HTTPS`):** Modern browsers block camera and microphone access (`navigator.mediaDevices.getUserMedia`) on plain `http://<PUBLIC_IP>` URLs (only `localhost` and `https://` are allowed). Follow Step 5 below to get free automatic HTTPS on your Azure VM using Azure's built-in DNS name + **Caddy** in under 2 minutes.

### 1. Configure Azure VM Networking (NSG Inbound Port Rules)
In the **Azure Portal** → your **Virtual Machine** → **Networking** → **Network settings**:
1. Add Inbound Port Rules allowing TCP ports **`22`** (SSH), **`80`** (HTTP / ACME challenge), and **`443`** (HTTPS + WSS). *(Also allow `8000` / `3000` only if testing via plain HTTP + SSH tunnel).*
2. Click your VM's **Public IP address** → **Configuration** → set a **DNS name label** (e.g., `meetsense-demo`), which gives you a free domain like:
   `meetsense-demo.<region>.cloudapp.azure.com`

### 2. Install System Packages (Node.js 20 LTS, Python & Headless OpenCV Libs)
SSH into your Azure Ubuntu VM and run:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3 python3-pip python3-venv git curl libglib2.0-0 libgomp1

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Clone Project, Configure `.env` & Build Production Frontend
FastAPI automatically serves `frontend/build` when built, so you only need **one lightweight backend service** in production (works even on 1 GB RAM VMs; add a 2 GB swapfile first if building on a `B1s` 1 GB VM):
```bash
git clone https://github.com/FASTANDEXTREME/MeetSense-AI.git
cd MeetSense-AI

cp .env.example .env
nano .env   # Paste your GROQ_API_KEY

# Install backend dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Build optimized React production bundle
cd frontend
npm install --legacy-peer-deps
npm run build
cd ..
```

### 4. Run MeetSenseAI as a Persistent `systemd` Service
Create `/etc/systemd/system/meetsense.service` (replace `<YOUR_VM_USER>` with your Linux username, e.g. `azureuser`):
```bash
sudo tee /etc/systemd/system/meetsense.service > /dev/null << 'EOF'
[Unit]
Description=MeetSenseAI FastAPI + React Production Server
After=network.target

[Service]
User=azureuser
WorkingDirectory=/home/azureuser/MeetSense-AI
EnvironmentFile=/home/azureuser/MeetSense-AI/.env
ExecStart=/home/azureuser/MeetSense-AI/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now meetsense
sudo systemctl status meetsense
```

### 5. Enable Automatic Free HTTPS + `wss://` with Caddy
Install Caddy and point your Azure VM's DNS name to `127.0.0.1:8000`:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
meetsense-demo.<region>.cloudapp.azure.com {
    reverse_proxy 127.0.0.1:8000
}
EOF

sudo systemctl reload caddy
```

Now anyone can open **`https://meetsense-demo.<region>.cloudapp.azure.com`** from any device — HTTPS, camera/mic permissions, WebRTC signaling (`wss://`), live transcription, facial engagement, and Groq AI summaries all work over port `443`.

### Optional: TURN Server for Strict Firewalls
WebRTC streams audio/video peer-to-peer using Google STUN servers by default. If participants are behind strict corporate Symmetric NATs, set `REACT_APP_TURN_URL`, `REACT_APP_TURN_USERNAME`, and `REACT_APP_TURN_CREDENTIAL` before running `npm run build`.
