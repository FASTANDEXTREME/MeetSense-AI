import json
import os
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("GOOGLE_API_KEY")


async def generate_summary(transcript: str):

    prompt = f"""
You are an AI meeting assistant.

Here is the meeting transcript:

{transcript}

Return ONLY valid JSON in this exact format:

{{
  "speakers": {{
    "Speaker Name": {{
      "key_points": ["max 5 points"],
      "action_items": ["max 5 actions"]
    }}
  }},
  "decisions": ["decision1"],
  "sentiment": "positive | neutral | negative"
}}

Rules:
- Separate analysis per speaker.
- Maximum 5 key points per speaker.
- Maximum 5 action items per speaker.
- Do not include explanations.
- Do NOT wrap the JSON in markdown.
- Return only pure JSON.
"""

    url = f"https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key={API_KEY}"

    headers = {
        "Content-Type": "application/json"
    }

    data = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ]
    }

    try:
        response = requests.post(url, headers=headers, json=data)
        result = response.json()

        if "candidates" not in result:
            return result

        raw_text = result["candidates"][0]["content"]["parts"][0]["text"]

        # Remove markdown formatting if present
        cleaned_text = raw_text.strip()

        if cleaned_text.startswith("```"):
            cleaned_text = cleaned_text.replace("```json", "")
            cleaned_text = cleaned_text.replace("```", "")
            cleaned_text = cleaned_text.strip()

        try:
            return json.loads(cleaned_text)

        except Exception as e:
            return {
                "error": "Invalid JSON returned",
                "raw": raw_text,
                "parse_error": str(e)
            }

    except Exception as e:
        return {
            "error": "Gemini API failed",
            "details": str(e)
        }