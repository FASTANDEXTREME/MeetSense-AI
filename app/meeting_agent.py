import base64
import json
import hashlib
import logging
import re
from collections import OrderedDict

from groq import AsyncGroq
from app.config import GROQ_MODEL, WHISPER_LANGUAGE, get_groq_api_key

logger = logging.getLogger("meetsense")

_WHISPER_MODEL = "whisper-large-v3-turbo"

# Known Whisper subtitle artifacts emitted when fed background fan/room noise
_WHISPER_HALLUCINATIONS = {
    "thank you",
    "thanks for watching",
    "thank you for watching",
    "subscribe",
    "please subscribe",
    "subtitles by",
    "amara org",
    "gracias",
    "merci",
    "i m going to go",
    "im going to go",
}

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


def _clean_alnum(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE).split())


def _seg_field(seg, name: str, default):
    if isinstance(seg, dict):
        return seg.get(name, default)
    return getattr(seg, name, default)


async def transcribe_audio_chunk(audio_data_url: str) -> str:
    """
    Transcribe a base64 WebM/Opus audio chunk via Groq Whisper (whisper-large-v3-turbo)
    with silence/hallucination filtering tailored for Groq LPU verbose_json outputs.
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
        req_kwargs = {
            "model": _WHISPER_MODEL,
            "file": ("chunk.webm", audio_bytes),
            "temperature": 0.0,
            "response_format": "verbose_json",
        }
        if WHISPER_LANGUAGE and WHISPER_LANGUAGE.lower() != "auto":
            req_kwargs["language"] = WHISPER_LANGUAGE

        transcription = await client.audio.transcriptions.create(**req_kwargs)
        clip_duration = float(getattr(transcription, "duration", 0.0) or 0.0)

        segments = getattr(transcription, "segments", None)
        if segments is not None:
            kept = []
            for seg in segments:
                seg_text = (_seg_field(seg, "text", "") or "").strip()
                if not seg_text:
                    continue

                no_speech_prob = float(_seg_field(seg, "no_speech_prob", 0.0) or 0.0)
                avg_logprob = float(_seg_field(seg, "avg_logprob", 0.0) or 0.0)
                compression_ratio = float(_seg_field(seg, "compression_ratio", 1.0) or 1.0)
                seg_end = float(_seg_field(seg, "end", 0.0) or 0.0)

                if no_speech_prob > 0.55 or avg_logprob < -1.1 or compression_ratio > 2.4:
                    continue

                cleaned = _clean_alnum(seg_text)
                if not cleaned:
                    continue

                # On silent short clips, Whisper predicts the 29.98s end-of-window token
                # alongside stock phrases ("Thank you.", "Gracias.", "I'm going to go.")
                is_window_overflow = clip_duration > 0 and seg_end > (clip_duration + 4.0)
                if is_window_overflow and (cleaned in _WHISPER_HALLUCINATIONS or avg_logprob < -0.22):
                    continue

                if cleaned in _WHISPER_HALLUCINATIONS and avg_logprob < -0.35:
                    continue

                kept.append(seg_text)

            result_text = " ".join(kept).strip()
        else:
            result_text = (getattr(transcription, "text", "") or "").strip()

        cleaned_full = _clean_alnum(result_text)
        if not cleaned_full or cleaned_full in {"gracias", "subtitles by", "amara org"}:
            return ""

        return result_text
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

        if "gpt-oss" in GROQ_MODEL or "qwen3" in GROQ_MODEL:
            request_kwargs["reasoning_effort"] = "low"

        chat_completion = await client.chat.completions.create(**request_kwargs)

        raw_text = chat_completion.choices[0].message.content or ""

        try:
            parsed = json.loads(raw_text)

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
