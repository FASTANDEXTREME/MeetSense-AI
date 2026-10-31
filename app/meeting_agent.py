import base64
import json
import hashlib
import logging
from collections import OrderedDict

from groq import AsyncGroq
from app.config import GROQ_MODEL, get_groq_api_key

logger = logging.getLogger("meetsense")

_WHISPER_MODEL = "whisper-large-v3-turbo"

# ── Groq Client Configuration (lazy-initialized) ────────────────────
_client: AsyncGroq | None = None
_client_api_key: str | None = None

# ── LRU Response Cache ──────────────────────────────────────────────
_summary_cache = OrderedDict()
_CACHE_MAX_SIZE = 50


def _get_client(api_key: str) -> AsyncGroq:
    """Return a cached AsyncGroq client, creating/recreating only when the key changes."""
    global _client, _client_api_key
    if _client is None or _client_api_key != api_key:
        _client = AsyncGroq(api_key=api_key)
        _client_api_key = api_key
    return _client


def _cache_key(transcript: str, previous_summary=None) -> str:
    """Normalize whitespace/case and include previous_summary to prevent cross-room collisions."""
    normalized_transcript = " ".join(transcript.lower().split())
    prev_serialized = ""
    if previous_summary and isinstance(previous_summary, dict) and "error" not in previous_summary:
        prev_serialized = json.dumps(previous_summary, sort_keys=True)
    payload = f"{prev_serialized}||{normalized_transcript}"
    return hashlib.sha256(payload.encode()).hexdigest()


async def transcribe_audio_chunk(audio_data_url: str) -> str:
    """
    Transcribe a base64 WebM/Opus audio chunk via Groq Whisper (whisper-large-v3-turbo).
    Used as an automatic fallback for browsers like Brave/Firefox that block Web Speech API.
    """
    api_key = get_groq_api_key()
    if not api_key or not audio_data_url:
        return ""

    try:
        encoded = audio_data_url.split(",", 1)[-1]
        audio_bytes = base64.b64decode(encoded)
        if len(audio_bytes) < 1000:
            return ""

        client = _get_client(api_key)
        transcription = await client.audio.transcriptions.create(
            model=_WHISPER_MODEL,
            file=("chunk.webm", audio_bytes),
            temperature=0.0,
            response_format="verbose_json",
        )

        # Filter silent chunks using Whisper's no_speech_prob when available
        segments = getattr(transcription, "segments", None)
        if segments:
            kept = [
                seg.get("text", "") if isinstance(seg, dict) else getattr(seg, "text", "")
                for seg in segments
                if (
                    seg.get("no_speech_prob", 0.0)
                    if isinstance(seg, dict)
                    else getattr(seg, "no_speech_prob", 0.0)
                )
                < 0.65
            ]
            return " ".join(s.strip() for s in kept if s and s.strip()).strip()

        text = (getattr(transcription, "text", "") or "").strip()
        return text
    except Exception as e:
        logger.error(f"Groq Whisper transcription error: {e}")
        return ""


# ── System Instruction ──────────────────────────────────────────────
_SYSTEM_INSTRUCTION = (
    "You are a meeting summarizer. Return ONLY valid JSON: "
    '{"speakers":{"Name":{"key_points":["max 5"],"action_items":["max 5"]}},'
    '"decisions":["..."],"sentiment":"positive|neutral|negative"}. '
    "Separate analysis per speaker. No markdown, no explanation."
)


async def generate_summary(transcript: str, previous_summary=None):
    """Generate a meeting summary via Groq, with caching and incremental context."""

    api_key = get_groq_api_key()
    if not api_key:
        return {"error": "GROQ_API_KEY is not configured. Add a valid key to your .env file."}

    if not transcript or not transcript.strip():
        return {"error": "Empty transcript."}

    # ── Cache lookup ────────────────────────────────────────────────
    cache_key = _cache_key(transcript, previous_summary)
    if cache_key in _summary_cache:
        _summary_cache.move_to_end(cache_key)
        logger.info("Summary cache HIT — skipping Groq API call")
        return _summary_cache[cache_key]

    # ── Build context-aware prompt ──────────────────────────────────
    context = ""
    if previous_summary and isinstance(previous_summary, dict) and "error" not in previous_summary:
        context = f"Previous summary (update/merge, don't repeat):\n{json.dumps(previous_summary)}\n\n"

    user_prompt = f"{context}New transcript:\n{transcript}"

    try:
        client = _get_client(api_key)
        request_kwargs = {
            "messages": [
                {
                    "role": "system",
                    "content": _SYSTEM_INSTRUCTION,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                },
            ],
            "model": GROQ_MODEL,
            "response_format": {"type": "json_object"},
            "temperature": 0.3,
            "max_completion_tokens": 2048,
        }

        # Keep reasoning overhead minimal on Groq reasoning models to preserve Free Tier TPM/TPD
        if "gpt-oss" in GROQ_MODEL or "qwen3" in GROQ_MODEL:
            request_kwargs["reasoning_effort"] = "low"

        chat_completion = await client.chat.completions.create(**request_kwargs)

        raw_text = chat_completion.choices[0].message.content or ""

        try:
            parsed = json.loads(raw_text)

            # ── Store in cache ──────────────────────────────────────
            _summary_cache[cache_key] = parsed
            if len(_summary_cache) > _CACHE_MAX_SIZE:
                _summary_cache.popitem(last=False)

            logger.info(f"Groq API call ({GROQ_MODEL}) succeeded — result cached")
            return parsed

        except Exception as e:
            logger.error(f"Failed to parse Groq JSON response: {e}")
            return {
                "error": "Invalid JSON returned from Groq",
                "raw": raw_text,
                "parse_error": str(e),
            }

    except Exception as e:
        logger.error(f"Groq API failure: {e}")
        return {
            "error": "Groq API failed",
            "details": str(e),
        }
