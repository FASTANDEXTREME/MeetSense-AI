import json
import logging
import time
from collections import defaultdict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from app.meeting_agent import generate_summary
from app.vision_sdk import VisionAgent
from app.engagement import update_engagement
from app.rate_limiter import rate_limiter

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

# ── Summary optimization state ──────────────────────────────────────
SUMMARY_MIN_LINES = 10           # Don't auto-summarize fewer than 10 lines
SUMMARY_INTERVAL_SECONDS = 60    # At least 1 min between auto-summaries

rooms_last_summary_time = defaultdict(float)
rooms_cumulative_summary = defaultdict(lambda: None)


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
        rooms_last_summary_time.pop(room_id, None)
        rooms_cumulative_summary.pop(room_id, None)
        logger.info(f"Room '{room_id}' cleaned up (no connections left).")


def is_near_duplicate(room_id: str, speaker: str, text: str) -> bool:
    """
    Check if the new transcript line is a near-duplicate of the last
    entry from the same speaker. Speech recognition often emits
    corrections that are substrings of each other.
    Returns True if the entry should be skipped (or merged).
    """
    if not rooms_transcripts[room_id]:
        return False

    last = rooms_transcripts[room_id][-1]
    if not last.startswith(f"{speaker}:"):
        return False

    last_text = last.split(":", 1)[1].strip()
    new_text = text.strip()

    # If new text is contained in the last, skip entirely
    if new_text in last_text:
        return True

    # If last text is contained in new, replace with the longer version
    if last_text in new_text:
        rooms_transcripts[room_id][-1] = f"{speaker}: {new_text}"
        return True

    return False


async def _do_summary(room_id: str):
    """Run the summarization and broadcast the result."""
    transcript = "\n".join(rooms_transcripts[room_id])
    summary = await generate_summary(
        transcript,
        previous_summary=rooms_cumulative_summary[room_id]
    )

    if summary and "error" not in summary:
        rooms_cumulative_summary[room_id] = summary

    rooms_last_summary_time[room_id] = time.time()
    rooms_transcripts[room_id] = []

    await safe_broadcast(room_id, {
        "type": "summary",
        "data": summary
    })


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

                await safe_broadcast(room_id, {
                    "type": "talk_time",
                    "data": dict(rooms_speaking_time[room_id])
                })

                await safe_broadcast(room_id, {
                    "type": "stopped_speaking",
                    "speaker": speaker
                })
                continue

            # ================= MANUAL SUMMARY REQUEST =================
            if data.get("type") == "request_summary":
                if rooms_transcripts[room_id]:
                    # Force-reset rate limiter so manual requests always work
                    rate_limiter.force_reset(room_id)
                    await _do_summary(room_id)
                else:
                    # Send back the last known summary if no new transcript
                    if rooms_cumulative_summary[room_id]:
                        await safe_broadcast(room_id, {
                            "type": "summary",
                            "data": rooms_cumulative_summary[room_id]
                        })
                continue

            # ================= NORMAL TRANSCRIPT =================
            speaker = data.get("speaker")
            text = data.get("text")

            if not speaker or not text:
                continue

            # Deduplicate near-identical speech recognition results
            if is_near_duplicate(room_id, speaker, text):
                # Still broadcast the transcript to the UI (use latest text)
                await safe_broadcast(room_id, {
                    "type": "transcript",
                    "speaker": speaker,
                    "text": text
                })
                continue

            rooms_transcripts[room_id].append(f"{speaker}: {text}")

            await safe_broadcast(room_id, {
                "type": "transcript",
                "speaker": speaker,
                "text": text
            })

            # ── Auto-summary: 1 min interval + 10 lines minimum ────
            now = time.time()
            line_count = len(rooms_transcripts[room_id])
            elapsed = now - rooms_last_summary_time[room_id]

            if line_count >= SUMMARY_MIN_LINES and elapsed >= SUMMARY_INTERVAL_SECONDS:
                if rate_limiter.can_call(room_id):
                    result = await rate_limiter.execute(
                        room_id,
                        _do_summary(room_id)
                    )
                    if result is None:
                        logger.debug(f"Auto-summary skipped by rate limiter for room '{room_id}'")

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