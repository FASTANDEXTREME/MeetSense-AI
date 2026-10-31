import logging
import os
import re
import time
from collections import defaultdict
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from app.config import GROQ_MODEL, get_groq_api_key
from app.meeting_agent import generate_summary, transcribe_audio_chunk
from app.vision_sdk import VisionAgent
from app.engagement import cleanup_engagement, remove_client_engagement, update_engagement
from app.rate_limiter import rate_limiter

logger = logging.getLogger("meetsense")

app = FastAPI(title="MeetSense AI")

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
rooms_connection_speakers = defaultdict(set)
rooms_signaling = defaultdict(dict)
rooms_peer_names = defaultdict(dict)

# Speaking analytics storage
rooms_speaking_time = defaultdict(lambda: defaultdict(float))
rooms_speaking_start = defaultdict(dict)
rooms_active_speakers = defaultdict(set)

# ── Summary optimization state ──────────────────────────────────────
SUMMARY_MIN_LINES = 10           # Don't auto-summarize fewer than 10 lines
SUMMARY_INTERVAL_SECONDS = 60    # At least 1 min between auto-summaries

rooms_last_summary_time = defaultdict(float)
rooms_cumulative_summary = defaultdict(lambda: None)


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "model": GROQ_MODEL,
        "groq_configured": bool(get_groq_api_key()),
    }


async def safe_broadcast(room_id: str, payload: dict, exclude: WebSocket = None):
    """Broadcast to all connections in a room, removing dead ones."""
    dead_connections = []
    for conn in list(rooms_connections[room_id]):
        if conn is exclude:
            continue
        try:
            await conn.send_json(payload)
        except Exception:
            dead_connections.append(conn)

    for conn in dead_connections:
        rooms_connection_speakers.pop(conn, None)
        try:
            rooms_connections[room_id].remove(conn)
        except ValueError:
            pass


def cleanup_room(room_id: str):
    """Remove all room data structures when the last connection leaves."""
    if not rooms_connections.get(room_id) and not rooms_signaling.get(room_id):
        rooms_transcripts.pop(room_id, None)
        rooms_connections.pop(room_id, None)
        rooms_signaling.pop(room_id, None)
        rooms_peer_names.pop(room_id, None)
        rooms_speaking_time.pop(room_id, None)
        rooms_speaking_start.pop(room_id, None)
        rooms_active_speakers.pop(room_id, None)
        rooms_last_summary_time.pop(room_id, None)
        rooms_cumulative_summary.pop(room_id, None)
        cleanup_engagement(room_id)
        rate_limiter.cleanup_room(room_id)
        logger.info(f"Room '{room_id}' cleaned up (no connections left).")


def _normalize_speech(text: str) -> str:
    """Lowercase and strip punctuation so 'hello' and 'Hello.' match identically."""
    cleaned = re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE)
    return " ".join(cleaned.split())


def is_near_duplicate(room_id: str, speaker: str, text: str) -> bool:
    """
    Check if the new transcript line is a near-duplicate of the last
    entry from the same speaker (ignoring case and punctuation differences
    between interim and finalized speech recognition results).
    Returns True if the entry should be skipped or merged in-place.
    """
    if not rooms_transcripts[room_id]:
        return False

    last = rooms_transcripts[room_id][-1]
    if not last.startswith(f"{speaker}:"):
        return False

    last_text = last.split(":", 1)[1].strip()
    new_text = text.strip()

    norm_last = _normalize_speech(last_text)
    norm_new = _normalize_speech(new_text)

    if not norm_new:
        return True

    # Identical words (e.g. "hello" -> "Hello."): prefer the better-formatted/longer version
    if norm_new == norm_last:
        if len(new_text) >= len(last_text) or any(ch.isupper() for ch in new_text):
            rooms_transcripts[room_id][-1] = f"{speaker}: {new_text}"
        return True

    # New text is a shorter fragment of the last line → skip
    if norm_new in norm_last:
        return True

    # Last text is a prefix/substring of the expanded new line → replace with longer version
    if norm_last and norm_last in norm_new:
        rooms_transcripts[room_id][-1] = f"{speaker}: {new_text}"
        return True

    return False


async def _do_summary(room_id: str):
    """Run the summarization and broadcast the result without losing transcript lines on failure."""
    snapshot = list(rooms_transcripts[room_id])
    if not snapshot:
        return

    transcript = "\n".join(snapshot)
    summary = await generate_summary(
        transcript,
        previous_summary=rooms_cumulative_summary[room_id],
    )

    if summary and "error" not in summary:
        rooms_cumulative_summary[room_id] = summary
        rooms_last_summary_time[room_id] = time.time()
        # Only clear lines that were actually included in this successful summary
        del rooms_transcripts[room_id][:len(snapshot)]

    await safe_broadcast(room_id, {
        "type": "summary",
        "data": summary,
    })


async def _record_and_maybe_summarize(room_id: str, speaker: str, text: str, is_final: bool = True):
    """Broadcast transcript line and append finalized utterances to room summary buffer."""
    if not _normalize_speech(text):
        return

    await safe_broadcast(room_id, {
        "type": "transcript",
        "speaker": speaker,
        "text": text,
        "is_final": is_final,
    })

    # Keep interim updates UI-only until finalized (or merge via normalized deduplication)
    if not is_final:
        return

    if not is_near_duplicate(room_id, speaker, text):
        rooms_transcripts[room_id].append(f"{speaker}: {text}")

    # ── Auto-summary: 1 min interval + 10 lines minimum ────
    now = time.time()
    line_count = len(rooms_transcripts[room_id])
    elapsed = now - rooms_last_summary_time[room_id]

    if line_count >= SUMMARY_MIN_LINES and elapsed >= SUMMARY_INTERVAL_SECONDS:
        if rate_limiter.can_call(room_id):
            result = await rate_limiter.execute(
                room_id,
                lambda: _do_summary(room_id),
            )
            if result is None:
                logger.debug(f"Auto-summary skipped by rate limiter for room '{room_id}'")


async def _finalize_disconnected_speakers(room_id: str, websocket: WebSocket):
    """Finalize speaking durations if a participant disconnects while their mic is active."""
    speakers = rooms_connection_speakers.pop(websocket, set())
    updated_talk_time = False

    for speaker in speakers:
        start_time = rooms_speaking_start[room_id].get(speaker)
        if start_time:
            duration = time.time() - start_time
            rooms_speaking_time[room_id][speaker] += duration
            rooms_speaking_start[room_id][speaker] = None
            updated_talk_time = True

        if speaker in rooms_active_speakers[room_id]:
            rooms_active_speakers[room_id].discard(speaker)
            await safe_broadcast(room_id, {
                "type": "stopped_speaking",
                "speaker": speaker,
                "active_speakers": sorted(rooms_active_speakers[room_id]),
            })

    if updated_talk_time:
        await safe_broadcast(room_id, {
            "type": "talk_time",
            "data": dict(rooms_speaking_time[room_id]),
        })


# ================= TRANSCRIPT + SUMMARY =================

@app.websocket("/ws/{room_id}")
async def websocket_transcript(websocket: WebSocket, room_id: str):
    await websocket.accept()
    rooms_connections[room_id].append(websocket)

    # Hydrate newly joined/reconnected client with current room state
    if rooms_speaking_time[room_id]:
        await websocket.send_json({
            "type": "talk_time",
            "data": dict(rooms_speaking_time[room_id]),
        })
    if rooms_active_speakers[room_id]:
        active_list = sorted(rooms_active_speakers[room_id])
        await websocket.send_json({
            "type": "speaking",
            "speaker": active_list[-1],
            "active_speakers": active_list,
        })
    if rooms_cumulative_summary[room_id]:
        await websocket.send_json({
            "type": "summary",
            "data": rooms_cumulative_summary[room_id],
        })

    try:
        while True:
            data = await websocket.receive_json()

            # ================= SPEAKING START =================
            if data.get("type") == "speaking":
                speaker = data.get("speaker")
                if not speaker:
                    continue

                rooms_connection_speakers[websocket].add(speaker)
                if not rooms_speaking_start[room_id].get(speaker):
                    rooms_speaking_start[room_id][speaker] = time.time()
                rooms_active_speakers[room_id].add(speaker)

                await safe_broadcast(room_id, {
                    "type": "speaking",
                    "speaker": speaker,
                    "active_speakers": sorted(rooms_active_speakers[room_id]),
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

                rooms_active_speakers[room_id].discard(speaker)

                await safe_broadcast(room_id, {
                    "type": "talk_time",
                    "data": dict(rooms_speaking_time[room_id]),
                })

                await safe_broadcast(room_id, {
                    "type": "stopped_speaking",
                    "speaker": speaker,
                    "active_speakers": sorted(rooms_active_speakers[room_id]),
                })
                continue

            # ================= AUDIO CHUNK FALLBACK (BRAVE / FIREFOX) =================
            if data.get("type") == "audio_chunk":
                speaker = data.get("speaker")
                audio_data = data.get("audio")
                if not speaker or not audio_data:
                    continue

                rooms_connection_speakers[websocket].add(speaker)
                text = await transcribe_audio_chunk(audio_data)
                if text:
                    await _record_and_maybe_summarize(room_id, speaker, text, is_final=True)
                continue

            # ================= MANUAL SUMMARY REQUEST =================
            if data.get("type") == "request_summary":
                if rooms_transcripts[room_id]:
                    rate_limiter.force_reset(room_id)
                    await rate_limiter.execute(room_id, lambda: _do_summary(room_id))
                elif rooms_cumulative_summary[room_id]:
                    await safe_broadcast(room_id, {
                        "type": "summary",
                        "data": rooms_cumulative_summary[room_id],
                    })
                else:
                    await websocket.send_json({
                        "type": "summary",
                        "data": {"error": "No transcript lines recorded yet. Speak first to generate a summary."},
                    })
                continue

            # ================= NORMAL TRANSCRIPT =================
            speaker = data.get("speaker")
            text = data.get("text")

            if not speaker or not text:
                continue

            is_final = data.get("is_final", True) is not False
            rooms_connection_speakers[websocket].add(speaker)
            await _record_and_maybe_summarize(room_id, speaker, text, is_final=is_final)

    except WebSocketDisconnect:
        try:
            rooms_connections[room_id].remove(websocket)
        except ValueError:
            pass
        await _finalize_disconnected_speakers(room_id, websocket)
        cleanup_room(room_id)
    except Exception as e:
        logger.error(f"Transcript WS error: {e}")
        try:
            rooms_connections[room_id].remove(websocket)
        except ValueError:
            pass
        await _finalize_disconnected_speakers(room_id, websocket)
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
                vision_result["looking_forward"],
            )

            await websocket.send_json({
                "type": "vision",
                "engagement_score": engagement_score,
                "face_detected": vision_result["face_detected"],
                "looking_forward": vision_result["looking_forward"],
                "confidence": vision_result["confidence"],
            })

    except WebSocketDisconnect:
        remove_client_engagement(room_id, client_id)
    except Exception as e:
        logger.error(f"Vision WS error for {client_id}: {e}")
        remove_client_engagement(room_id, client_id)


# ================= WEBRTC SIGNALING =================

@app.websocket("/ws/signal/{room_id}/{client_id}")
async def signaling(
    websocket: WebSocket,
    room_id: str,
    client_id: str,
    name: str = Query(default="Participant"),
):
    await websocket.accept()
    rooms_signaling[room_id][client_id] = websocket
    rooms_peer_names[room_id][client_id] = name

    existing_peers = {
        cid: rooms_peer_names[room_id].get(cid, "Participant")
        for cid in rooms_signaling[room_id]
        if cid != client_id
    }
    if existing_peers:
        try:
            await websocket.send_json({
                "type": "existing_peers",
                "peers": existing_peers,
            })
        except Exception:
            pass

    for cid, conn in list(rooms_signaling[room_id].items()):
        if cid != client_id:
            try:
                await conn.send_json({
                    "type": "new_peer",
                    "client_id": client_id,
                    "name": name,
                })
            except Exception:
                rooms_signaling[room_id].pop(cid, None)
                rooms_peer_names[room_id].pop(cid, None)

    try:
        while True:
            data = await websocket.receive_json()
            target = data.get("target")

            if target and target in rooms_signaling[room_id]:
                data["sender"] = client_id
                data["sender_name"] = rooms_peer_names[room_id].get(client_id, "Participant")

                if "type" not in data:
                    if "offer" in data:
                        data["type"] = "offer"
                    elif "answer" in data:
                        data["type"] = "answer"
                    elif "candidate" in data:
                        data["type"] = "ice"

                try:
                    await rooms_signaling[room_id][target].send_json(data)
                except Exception:
                    rooms_signaling[room_id].pop(target, None)
                    rooms_peer_names[room_id].pop(target, None)

    except WebSocketDisconnect:
        await _handle_peer_disconnect(room_id, client_id)
    except Exception as e:
        logger.error(f"Signaling WS error for {client_id}: {e}")
        await _handle_peer_disconnect(room_id, client_id)


async def _handle_peer_disconnect(room_id: str, client_id: str):
    """Remove disconnected signaling client and notify remaining peers to clean up video tiles."""
    rooms_signaling[room_id].pop(client_id, None)
    rooms_peer_names[room_id].pop(client_id, None)

    for cid, conn in list(rooms_signaling[room_id].items()):
        try:
            await conn.send_json({
                "type": "peer_left",
                "client_id": client_id,
            })
        except Exception:
            rooms_signaling[room_id].pop(cid, None)
            rooms_peer_names[room_id].pop(cid, None)

    if not rooms_signaling[room_id]:
        rooms_signaling.pop(room_id, None)
        rooms_peer_names.pop(room_id, None)

    cleanup_room(room_id)


# ================= PRODUCTION FRONTEND STATIC SERVING =================
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_FRONTEND_BUILD_DIR = os.path.join(_PROJECT_ROOT, "frontend", "build")

if os.path.isfile(os.path.join(_FRONTEND_BUILD_DIR, "index.html")):
    _STATIC_SUBDIR = os.path.join(_FRONTEND_BUILD_DIR, "static")
    if os.path.isdir(_STATIC_SUBDIR):
        app.mount("/static", StaticFiles(directory=_STATIC_SUBDIR), name="frontend-static")

    @app.get("/{full_path:path}")
    async def serve_react_spa(full_path: str):
        candidate = os.path.normpath(os.path.join(_FRONTEND_BUILD_DIR, full_path))
        if (
            full_path
            and candidate.startswith(_FRONTEND_BUILD_DIR)
            and os.path.isfile(candidate)
        ):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_FRONTEND_BUILD_DIR, "index.html"))

