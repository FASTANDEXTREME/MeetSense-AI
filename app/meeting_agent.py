import json
import hashlib
import logging
from collections import OrderedDict

import httpx
from app.config import OPENAI_API_KEY

logger = logging.getLogger("meetsense")

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
    """Generate a meeting summary via OpenAI, with caching and incremental context."""

    if not OPENAI_API_KEY:
        return {"error": "OPENAI_API_KEY is not configured."}

    if not transcript or not transcript.strip():
        return {"error": "Empty transcript."}

    # ── Cache lookup ────────────────────────────────────────────────
    cache_key = _cache_key(transcript)
    if cache_key in _summary_cache:
        _summary_cache.move_to_end(cache_key)
        logger.info("Summary cache HIT — skipping API call")
        return _summary_cache[cache_key]

    # ── Build context-aware prompt ──────────────────────────────────
    context = ""
    if previous_summary and isinstance(previous_summary, dict) and "error" not in previous_summary:
        context = f"Previous summary (update/merge, don't repeat):\n{json.dumps(previous_summary)}\n\n"

    user_prompt = f"{context}New transcript:\n{transcript}"

    # ── API call — OpenAI gpt-4o-mini (fast + cheap) ────────────────
    url = "https://api.openai.com/v1/chat/completions"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}",
    }

    data = {
        "model": "gpt-4o-mini",
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": _SYSTEM_INSTRUCTION},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": 1024,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, headers=headers, json=data)
            result = response.json()

        if "error" in result:
            error_msg = result["error"].get("message", str(result["error"]))
            logger.error(f"OpenAI API error: {error_msg}")
            return {"error": f"OpenAI API error: {error_msg}"}

        if "choices" not in result or not result["choices"]:
            logger.warning(f"No choices in OpenAI response: {result}")
            return {"error": "No choices in OpenAI response"}

        raw_text = result["choices"][0]["message"]["content"]

        # With response_format=json_object, output should be clean JSON
        cleaned_text = raw_text.strip()
        if cleaned_text.startswith("```"):
            cleaned_text = cleaned_text.replace("```json", "")
            cleaned_text = cleaned_text.replace("```", "")
            cleaned_text = cleaned_text.strip()

        try:
            parsed = json.loads(cleaned_text)

            # ── Store in cache ──────────────────────────────────────
            _summary_cache[cache_key] = parsed
            if len(_summary_cache) > _CACHE_MAX_SIZE:
                _summary_cache.popitem(last=False)

            logger.info("OpenAI API call succeeded — result cached")
            return parsed

        except Exception as e:
            return {
                "error": "Invalid JSON returned",
                "raw": raw_text,
                "parse_error": str(e)
            }

    except httpx.TimeoutException:
        return {"error": "OpenAI API request timed out"}

    except Exception as e:
        return {
            "error": "OpenAI API failed",
            "details": str(e)
        }