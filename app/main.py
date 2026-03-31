import json
import time
from collections import defaultdict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from app.meeting_agent import generate_summary
from app.vision_sdk import VisionAgent
from app.engagement import update_engagement

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

vision_agent = VisionAgent()

rooms_transcripts = defaultdict(list)
rooms_connections = defaultdict(list)
rooms_signaling = defaultdict(dict)

# 🔥 NEW — speaking analytics storage
rooms_speaking_time = defaultdict(lambda: defaultdict(float))
rooms_speaking_start = defaultdict(dict)


# ================= TRANSCRIPT + SUMMARY =================

@app.websocket("/ws/{room_id}")
async def websocket_transcript(websocket: WebSocket, room_id: str):
    await websocket.accept()
    rooms_connections[room_id].append(websocket)

    try:
        while True:
            data = await websocket.receive_json()

            # ================= SPEAKING START =================
            if data.get("type") == "speaking":
                speaker = data["speaker"]
                rooms_speaking_start[room_id][speaker] = time.time()

                for conn in rooms_connections[room_id]:
                    await conn.send_json({
                        "type": "speaking",
                        "speaker": speaker
                    })
                continue

            # ================= SPEAKING STOP =================
            if data.get("type") == "stopped_speaking":
                speaker = data["speaker"]

                start_time = rooms_speaking_start[room_id].get(speaker)
                if start_time:
                    duration = time.time() - start_time
                    rooms_speaking_time[room_id][speaker] += duration
                    rooms_speaking_start[room_id][speaker] = None

                # Broadcast updated talk-time
                for conn in rooms_connections[room_id]:
                    await conn.send_json({
                        "type": "talk_time",
                        "data": rooms_speaking_time[room_id]
                    })

                # Remove glow
                for conn in rooms_connections[room_id]:
                    await conn.send_json({
                        "type": "stopped_speaking",
                        "speaker": speaker
                    })

                continue

            # ================= NORMAL TRANSCRIPT =================
            speaker = data["speaker"]
            text = data["text"]

            rooms_transcripts[room_id].append(f"{speaker}: {text}")

            for conn in rooms_connections[room_id]:
                await conn.send_json({
                    "type": "transcript",
                    "speaker": speaker,
                    "text": text
                })

            # Auto summary every 5 lines
            if len(rooms_transcripts[room_id]) >= 5:
                transcript = " ".join(rooms_transcripts[room_id])
                summary = await generate_summary(transcript)

                for conn in rooms_connections[room_id]:
                    await conn.send_json({
                        "type": "summary",
                        "data": summary
                    })

                rooms_transcripts[room_id] = []

    except WebSocketDisconnect:
        rooms_connections[room_id].remove(websocket)


# ================= VISION =================

@app.websocket("/ws/vision/{room_id}/{client_id}")
async def websocket_vision(websocket: WebSocket, room_id: str, client_id: str):
    await websocket.accept()

    try:
        while True:
            image_data = await websocket.receive_text()

            vision_result = vision_agent.analyze(image_data)

            engagement_score = update_engagement(
                room_id,
                client_id,
                vision_result["looking_forward"]
            )

            await websocket.send_json({
                "type": "vision",
                "engagement_score": engagement_score,
                "face_detected": vision_result["face_detected"],
                "confidence": vision_result["confidence"]
            })

    except WebSocketDisconnect:
        pass


# ================= WEBRTC SIGNALING =================

@app.websocket("/ws/signal/{room_id}/{client_id}")
async def signaling(websocket: WebSocket, room_id: str, client_id: str):
    await websocket.accept()
    rooms_signaling[room_id][client_id] = websocket

    for cid, conn in rooms_signaling[room_id].items():
        if cid != client_id:
            await conn.send_json({
                "type": "new_peer",
                "client_id": client_id
            })

    try:
        while True:
            data = await websocket.receive_json()
            target = data.get("target")

            if target in rooms_signaling[room_id]:
                data["sender"] = client_id
                await rooms_signaling[room_id][target].send_json(data)

    except WebSocketDisconnect:
            rooms_signaling[room_id].pop(client_id, None)