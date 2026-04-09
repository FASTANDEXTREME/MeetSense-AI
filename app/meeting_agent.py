import json
import hashlib
import logging
from collections import OrderedDict

from groq import AsyncGroq
from app.config import GROQ_API_KEY

logger = logging.getLogger("meetsense")

# ── Groq Client Configuration ───────────────────────────────────────
client = AsyncGroq(api_key=GROQ_API_KEY)
_MODEL_NAME = "llama-3.3-70b-versatile"

# ── LRU Response Cache ──────────────────────────────────────────────
_summary_cache = OrderedDict()
_CACHE_MAX_SIZE = 50


def _cache_key(transcript: str) -> str:
    """Normalize whitespace/case and hash for near-duplicate detection."""
    normalized = " ".join(transcript.lower().split())
    return hashlib.sha256(normalized.encode()).hexdigest()


# ── System Instruction ──────────────────────────────────────────────
_SYSTEM_INSTRUCTION = (
    "You are a meeting summarizer. Return ONLY valid JSON: "
    '{"speakers":{"Name":{"key_points":["max 5"],"action_items":["max 5"]}},'
    '"decisions":["..."],"sentiment":"positive|neutral|negative"}. '
    "Separate analysis per speaker. No markdown, no explanation."
)


async def generate_summary(transcript: str, previous_summary=None):
    """Generate a meeting summary via Groq, with caching and incremental context."""

    if not GROQ_API_KEY:
        return {"error": "GROQ_API_KEY is not configured."}

    if not transcript or not transcript.strip():
        return {"error": "Empty transcript."}

    # ── Cache lookup ────────────────────────────────────────────────
    cache_key = _cache_key(transcript)
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
        chat_completion = await client.chat.completions.create(
            messages=[
                {
                    "role": "system",
                    "content": _SYSTEM_INSTRUCTION,
                },
                {
                    "role": "user",
                    "content": user_prompt,
                }
            ],
            model=_MODEL_NAME,
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=2048,
        )

        raw_text = chat_completion.choices[0].message.content
        
        try:
            parsed = json.loads(raw_text)

            # ── Store in cache ──────────────────────────────────────
            _summary_cache[cache_key] = parsed
            if len(_summary_cache) > _CACHE_MAX_SIZE:
                _summary_cache.popitem(last=False)

            logger.info(f"Groq API call ({_MODEL_NAME}) succeeded — result cached")
            return parsed

        except Exception as e:
            logger.error(f"Failed to parse Groq JSON response: {e}")
            return {
                "error": "Invalid JSON returned from Groq",
                "raw": raw_text,
                "parse_error": str(e)
            }

    except Exception as e:
        logger.error(f"Groq API failure: {e}")
        return {
            "error": "Groq API failed",
            "details": str(e)
        }