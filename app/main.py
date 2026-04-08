import json
import logging
import time
from collections import defaultdict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from app.meeting_agent import generate_summary
from app.vision_sdk import VisionAgent
from app.engagement import update_engagement

logger = logging.getLogger("meetsense")

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

# Speaking analytics storage
rooms_speaking_time = defaultdict(lambda: defaultdict(float))
rooms_speaking_start = defaultdict(dict)


async def safe_broadcast(room_id: str, payload: dict, exclude: WebSocket = None):
    """Broadcast to all connections in a room, removing dead ones."""
    dead_connections = []
    for conn in rooms_connections[room_id]:
        if conn is exclude:
            continue
        try:
            await conn.send_json(payload)
        except Exception:
            dead_connections.append(conn)

    for conn in dead_connections:
        try:
            rooms_connections[room_id].remove(conn)
        except ValueError:
            pass


def cleanup_room(room_id: str):
    """Remove all room data structures when the last connection leaves."""
    if not rooms_connections.get(room_id):
        rooms_transcripts.pop(room_id, None)
        rooms_connections.pop(room_id, None)
        rooms_signaling.pop(room_id, None)
        rooms_speaking_time.pop(room_id, None)
        rooms_speaking_start.pop(room_id, None)
        logger.info(f"Room '{room_id}' cleaned up (no connections left).")


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
                speaker = data.get("speaker")
                if not speaker:
                    continue

                rooms_speaking_start[room_id][speaker] = time.time()

                await safe_broadcast(room_id, {
                    "type": "speaking",
                    "speaker": speaker
                })
                continue

            # ================= SPEAKING STOP =================
            if data.get("type") == "stopped_speaking":
                speaker = data.get("speaker")
                if not speaker:
                    continue

                start_time = rooms_speaking_start[room_id].get(speaker)
                if start_time:
                    duration = time.time() - start_time
                    rooms_speaking_time[room_id][speaker] += duration
                    rooms_speaking_start[room_id][speaker] = None

                # B2 fix: convert defaultdict to plain dict for JSON serialization
                await safe_broadcast(room_id, {
                    "type": "talk_time",
                    "data": dict(rooms_speaking_time[room_id])
                })

                await safe_broadcast(room_id, {
                    "type": "stopped_speaking",
                    "speaker": speaker
                })
                continue

            # ================= NORMAL TRANSCRIPT =================
            speaker = data.get("speaker")
            text = data.get("text")

            if not speaker or not text:
                continue

            rooms_transcripts[room_id].append(f"{speaker}: {text}")

            await safe_broadcast(room_id, {
                "type": "transcript",
                "speaker": speaker,
                "text": text
            })

            # Auto summary every 5 lines
            if len(rooms_transcripts[room_id]) >= 5:
                transcript = " ".join(rooms_transcripts[room_id])
                summary = await generate_summary(transcript)

                await safe_broadcast(room_id, {
                    "type": "summary",
                    "data": summary
                })

                rooms_transcripts[room_id] = []

    except WebSocketDisconnect:
        try:
            rooms_connections[room_id].remove(websocket)
        except ValueError:
            pass
        cleanup_room(room_id)
    except Exception as e:
        logger.error(f"Transcript WS error: {e}")
        try:
            rooms_connections[room_id].remove(websocket)
        except ValueError:
            pass
        cleanup_room(room_id)


# ================= VISION =================

@app.websocket("/ws/vision/{room_id}/{client_id}")
async def websocket_vision(websocket: WebSocket, room_id: str, client_id: str):
    await websocket.accept()

    try:
        while True:
            image_data = await websocket.receive_text()

            # B1 fix: method is 'detect', not 'analyze'
            vision_result = vision_agent.detect(image_data)

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
    except Exception as e:
        logger.error(f"Vision WS error for {client_id}: {e}")


# ================= WEBRTC SIGNALING =================

@app.websocket("/ws/signal/{room_id}/{client_id}")
async def signaling(websocket: WebSocket, room_id: str, client_id: str):
    await websocket.accept()
    rooms_signaling[room_id][client_id] = websocket

    for cid, conn in list(rooms_signaling[room_id].items()):
        if cid != client_id:
            try:
                await conn.send_json({
                    "type": "new_peer",
                    "client_id": client_id
                })
            except Exception:
                rooms_signaling[room_id].pop(cid, None)

    try:
        while True:
            data = await websocket.receive_json()
            target = data.get("target")

            if target and target in rooms_signaling[room_id]:
                data["sender"] = client_id
                try:
                    await rooms_signaling[room_id][target].send_json(data)
                except Exception:
                    rooms_signaling[room_id].pop(target, None)

    except WebSocketDisconnect:
        rooms_signaling[room_id].pop(client_id, None)
    except Exception as e:
        logger.error(f"Signaling WS error for {client_id}: {e}")
        rooms_signaling[room_id].pop(client_id, None)