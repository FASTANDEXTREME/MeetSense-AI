# MeetSenseAI — Smart AI Video Conferencing & Meeting Assistant

MeetSenseAI is a full-stack, real-time AI video conferencing and meeting intelligence platform built with **FastAPI**, **React**, **WebRTC**, **Groq LPU Inference**, and **OpenCV YuNet**.

It works seamlessly across **Desktop and Mobile browsers** (Android Chrome, iOS Safari, Brave, Firefox, Edge), handles **mobile 4G/5G Symmetric CGNAT networks** out of the box without requiring a paid TURN server, and deploys cleanly on a **Headless Cloud VM (Microsoft Azure / AWS / GCP)** with a single Python service.

---

## Key Features

### 1. Mobile & Cross-Device Ready (Android, iOS Safari, Desktop)
- **Responsive Mobile-First UI**: Adaptive layout (`100dvh` dynamic viewport) that switches smoothly from a desktop split-screen studio to a mobile-optimized stacked layout with `4:3` participant grids, touch-sized controls, and zoom-safe (`16px`) form inputs.
- **Smart Camera & Mic Acquisition**: Front-camera targeting (`facingMode: "user"`) with a 4-stage progressive fallback (`video+audio` → `plain video+audio` → `video-only` → `audio-only`) and bidirectional SDP transceiver negotiation so participants without a free webcam or mic can still join and view everyone else.
- **iOS Safari & Mobile WebKit Support**: Handles streamless `ontrack` events, mobile autoplay policies (automatic muted-play + one-tap audio unlock), portrait-aware vision framing, and `audio/mp4` / `audio/webm` container negotiation.

### 2. Built-In 4G/5G CGNAT Video Relay (Zero-TURN Fallback)
- **Direct WebRTC P2P First**: Low-latency peer-to-peer media over Google & Cloudflare STUN (`/api/ice-servers`) with **Polite Peer** glare resolution and automatic ICE restarts on network switches (Wi-Fi ↔ Mobile Data).
- **Automatic WSS Frame Relay**: When mobile carriers (e.g., Jio/Airtel 4G/5G) or strict corporate Symmetric NATs block direct UDP P2P and no TURN server is configured, MeetSenseAI automatically streams aspect-ratio-preserved video frames over `wss://` (port `443`) with WebSocket backpressure control—only to the specific peers whose P2P ICE link cannot connect.

### 3. Hands-Free Always-On English Transcription & Multi-Speaker Overlap
- **Zero-Friction Controls**: Clean 3-button meeting bar (**`Mic On / Mic Off`**, **`Camera On / Camera Off`**, **`Generate Summary`**). Everything spoken while **`Mic On`** is active is transcribed automatically; toggling **`Mic Off`** pauses transcription immediately.
- **Hybrid Speech Recognition Engine**:
  - **Desktop Chrome / Edge**: Instant word-by-word interim captions via the Web Speech API.
  - **Mobile (Android / iOS), Brave, Firefox & Safari**: Clones the active WebRTC audio track into a pause-driven **Groq Whisper (`whisper-large-v3-turbo`)** pipeline—avoiding mobile hardware mic contention and OS recognition chimes—complete with Whisper 30s window-overflow hallucination filtering.
- **Natural Turn Merging & Simultaneous Speakers**: Utterance VAD (`1.15s` natural pause + breath-aware splitting) merges continuous clauses cleanly while keeping overlapping / simultaneous speakers in their own chronological transcript bubbles.

### 4. Voice-Activated Green Tile Indicator & Talk-Time Analytics
- **True Voice Activity Highlighting**: Powered by a real-time WebAudio `AnalyserNode` monitor with an **adaptive ambient noise floor** (ignores mic clicks and steady fan/AC background hum).
- **Dynamic Speaking Border**: Participant video tiles light up green **only while someone is actively talking** (`~160ms` voice onset, `650ms` hold release)—never staying stuck green when a user's mic is on and silent.
- **Speaking Analytics**: Tracks cumulative speaking duration per participant in real time.

### 5. Authoritative Room Roster & Reconnection Sync
- **Consistent Participant Tiles Everywhere**: Server-authoritative `room_peers` broadcasts with `15s` `ping`/`pong` heartbeats (`45s` dead-socket eviction) guarantee mobile and desktop browsers always show the exact same participant count (`● X online` badge).
- **Ghost-Tile Prevention**: Per-tab `sessionStorage` client IDs and `visibilitychange` / `online` wake-up reconnection ensure mobile pull-to-refresh or brief signal drops replace stale connections cleanly instead of leaving duplicate tiles.

### 6. Incremental AI Meeting Summaries
- **One-Click Structured Insights**: Snapshot-safe incremental summarization powered by **Groq (`openai/gpt-oss-20b`)** extracts per-speaker **Key Points**, **Action Items**, **Decisions**, and **Overall Meeting Sentiment** as the conversation progresses.

### 7. Headless Facial Engagement & Attention Tracking
- **Head-Pose & Presence Detection**: Uses `opencv-python-headless` with OpenCV's **`FaceDetectorYN` (YuNet ONNX)** 5-landmark detector (compatible with OpenCV 4.x & 5.x) to classify real-time attention (`Attentive`, `Looking Away`, `No Face Detected`) and compute a smoothed engagement score with a one-click Pause/Resume toggle.

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Backend** | Python 3.10+, FastAPI, Uvicorn, WebSockets, Async Groq SDK, NumPy |
| **Computer Vision** | `opencv-python-headless`, OpenCV Zoo `FaceDetectorYN` (`face_detection_yunet_2023mar.onnx`) |
| **Frontend** | React 19, WebRTC (`RTCPeerConnection` + WSS CGNAT Relay), WebAudio API VAD, Web Speech API + `MediaRecorder` |
| **AI Models** | `openai/gpt-oss-20b` (Meeting Summarization), `whisper-large-v3-turbo` (English Speech-to-Text) |

### API & WebSocket Endpoints
- `GET /health` — Backend & Groq configuration health check
- `GET /api/ice-servers` — STUN + optional TURN ICE server configuration
- `WS /ws/{room_id}` — Live transcription, active-speaker events, talk-time analytics, and AI summaries
- `WS /ws/signal/{room_id}/{client_id}` — WebRTC SDP/ICE signaling, authoritative `room_peers` roster sync, heartbeats, and CGNAT video frame fallback
- `WS /ws/vision/{room_id}/{client_id}` — Real-time facial engagement & head-pose telemetry

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

> **Important Browser Requirement (`HTTPS`):** Modern desktop and mobile browsers block camera and microphone access (`navigator.mediaDevices.getUserMedia`) on plain `http://<PUBLIC_IP>` URLs (only `localhost` and `https://` are allowed). Follow Step 5 below to get free automatic HTTPS on your Azure VM using Azure's built-in DNS name + **Caddy** in under 2 minutes.

### 1. Configure Azure VM Networking (NSG Inbound Port Rules)
In the **Azure Portal** → your **Virtual Machine** → **Networking** → **Network settings**:
1. Add Inbound Port Rules allowing TCP ports **`22`** (SSH), **`80`** (HTTP / ACME challenge), and **`443`** (HTTPS + WSS).
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
Create `/etc/systemd/system/meetsense.service` (replace `azureuser` with your Linux username if different):
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
curl -1sLf 'https://dl.cloudsmith.com/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
meetsense-demo.<region>.cloudapp.azure.com {
    reverse_proxy 127.0.0.1:8000
}
EOF

sudo systemctl reload caddy
```

Now anyone can open **`https://meetsense-demo.<region>.cloudapp.azure.com`** from **any mobile phone or desktop computer** — HTTPS, camera/mic permissions, WebRTC signaling (`wss://`), CGNAT video fallback, hands-free live transcription, voice-activated speaker highlights, facial engagement, and Groq AI summaries all run over port `443`.

### Optional: Custom TURN Server
MeetSenseAI includes a built-in `wss://` video relay fallback for mobile 4G/5G CGNAT networks out of the box. If you also want native WebRTC TURN media relay (e.g., Metered / Cloudflare / coturn), simply add `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` to your backend `.env`—no frontend rebuild needed (`/api/ice-servers` serves them dynamically).
