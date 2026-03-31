transcript_buffer = []

SUMMARY_THRESHOLD = 5


def add_transcript(speaker: str, text: str):
    if speaker and text:
        transcript_buffer.append(f"{speaker}: {text}")


def get_full_transcript():
    return "\n".join(transcript_buffer)


def should_summarize():
    return len(transcript_buffer) >= SUMMARY_THRESHOLD


def reset_transcript():
    global transcript_buffer
    transcript_buffer = []