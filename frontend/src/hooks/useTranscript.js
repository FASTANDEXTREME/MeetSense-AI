import { useEffect, useRef, useState, useCallback } from "react";
import { buildWsUrl } from "../utils/wsUrl";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;

// Minimum RMS microphone energy required to treat a 100ms frame as speech (filters silence/fan noise)
const SPEECH_RMS_THRESHOLD = 0.018;
const MIN_VOICED_FRAMES_PER_CHUNK = 2;

/**
 * Strip punctuation and normalize case/whitespace so "hello" and "Hello."
 * or "i am fine i am fine" and "I am fine. I am fine." match cleanly.
 */
function normalizeSpeech(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function useTranscript(roomId, name) {

  const [transcript, setTranscript] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activeSpeakers, setActiveSpeakers] = useState([]);
  const [talkTime, setTalkTime] = useState({});
  const [socketReady, setSocketReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speechError, setSpeechError] = useState("");

  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recorderStreamRef = useRef(null);
  const recorderTimerRef = useRef(null);
  const vadTimerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const usingFallbackRef = useRef(false);
  const isRecordingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const connectRef = useRef(null);
  const networkErrorCountRef = useRef(0);

  const transcriptBufferRef = useRef([]);
  const rafIdRef = useRef(null);

  const flushTranscript = useCallback(() => {
    rafIdRef.current = null;
    if (transcriptBufferRef.current.length === 0) return;

    const batch = transcriptBufferRef.current;
    transcriptBufferRef.current = [];

    setTranscript(prev => {
      let updated = prev;

      for (const entry of batch) {
        if (!normalizeSpeech(entry.text)) continue;

        const entryIsFinal = entry.is_final !== false;
        const last = updated.length > 0 ? updated[updated.length - 1] : null;

        if (last && last.speaker === entry.speaker) {
          // 1. Replace unfinished interim result in-place
          if (last.is_final === false) {
            if (updated === prev) updated = [...prev];
            updated[updated.length - 1] = {
              speaker: entry.speaker,
              text: entry.text.trim(),
              is_final: entryIsFinal,
            };
            continue;
          }

          // 2. Punctuation- & case-insensitive dedup (e.g. "hello" vs "Hello.")
          const normLast = normalizeSpeech(last.text);
          const normNew = normalizeSpeech(entry.text);

          if (
            normLast &&
            normNew &&
            (normNew.includes(normLast) || normLast.includes(normNew))
          ) {
            if (updated === prev) updated = [...prev];
            const preferNew =
              entryIsFinal || normNew.length >= normLast.length;
            updated[updated.length - 1] = {
              speaker: entry.speaker,
              text: preferNew ? entry.text.trim() : last.text,
              is_final: last.is_final || entryIsFinal,
            };
            continue;
          }
        }

        if (updated === prev) updated = [...prev];
        updated.push({
          speaker: entry.speaker,
          text: entry.text.trim(),
          is_final: entryIsFinal,
        });
      }

      return updated;
    });
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("Max transcript WS reconnect attempts reached.");
      return;
    }

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1;
      connectRef.current?.();
    }, delay);
  }, []);

  const connectDelayRef = useRef(null);

  const connectWebSocket = useCallback(() => {
    if (unmountedRef.current || !roomId) return;

    connectDelayRef.current = setTimeout(() => {
      if (unmountedRef.current) return;

      const wsUrl = buildWsUrl(`/ws/${encodeURIComponent(roomId)}`);
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setSocketReady(true);
        reconnectAttemptRef.current = 0;
      };

      ws.onclose = () => {
        setSocketReady(false);
        if (!unmountedRef.current) {
          scheduleReconnect();
        }
      };

      ws.onerror = (err) => {
        console.error("Transcript WebSocket error:", err);
      };

      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.type === "transcript") {
          transcriptBufferRef.current.push(data);
          if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(flushTranscript);
          }
          return;
        }

        if (data.type === "summary") {
          setSummary(data.data);
        }

        if (data.type === "speaking") {
          if (Array.isArray(data.active_speakers)) {
            setActiveSpeakers(data.active_speakers);
          } else if (data.speaker) {
            setActiveSpeakers(prev =>
              prev.includes(data.speaker) ? prev : [...prev, data.speaker]
            );
          }
        }

        if (data.type === "stopped_speaking") {
          if (Array.isArray(data.active_speakers)) {
            setActiveSpeakers(data.active_speakers);
          } else if (data.speaker) {
            setActiveSpeakers(prev => prev.filter(s => s !== data.speaker));
          } else {
            setActiveSpeakers([]);
          }
        }

        if (data.type === "talk_time") {
          setTalkTime(data.data);
        }
      };
    }, 100);
  }, [roomId, scheduleReconnect, flushTranscript]);

  useEffect(() => {
    connectRef.current = connectWebSocket;
  }, [connectWebSocket]);

  const cleanupFallbackRecorder = useCallback(() => {
    usingFallbackRef.current = false;
    clearInterval(recorderTimerRef.current);
    recorderTimerRef.current = null;
    clearInterval(vadTimerRef.current);
    vadTimerRef.current = null;

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;

    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {
        // ignore
      }
      audioCtxRef.current = null;
    }

    if (recorderStreamRef.current) {
      recorderStreamRef.current.getTracks().forEach(t => t.stop());
      recorderStreamRef.current = null;
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connectWebSocket();

    return () => {
      unmountedRef.current = true;
      isRecordingRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      cleanupFallbackRecorder();
      clearTimeout(connectDelayRef.current);
      clearTimeout(reconnectTimerRef.current);
      cancelAnimationFrame(rafIdRef.current);
      socketRef.current?.close();
    };
  }, [connectWebSocket, cleanupFallbackRecorder]);

  const safeSend = useCallback((payload) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  /**
   * Universal fallback for Brave / Firefox / Safari with client-side Voice Activity
   * Detection (RMS energy gate) so silent chunks are never sent to Whisper.
   */
  const startServerWhisperFallback = useCallback(async () => {
    if (usingFallbackRef.current || !isRecordingRef.current) return;
    usingFallbackRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!isRecordingRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      recorderStreamRef.current = stream;

      // Setup Web Audio RMS Voice Activity Detector to drop silent segments locally
      let voicedFramesInSegment = 0;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const audioCtx = new AudioCtx();
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const pcm = new Float32Array(analyser.fftSize);

        vadTimerRef.current = setInterval(() => {
          analyser.getFloatTimeDomainData(pcm);
          let sumSq = 0;
          for (let i = 0; i < pcm.length; i++) {
            sumSq += pcm[i] * pcm[i];
          }
          const rms = Math.sqrt(sumSq / pcm.length);
          if (rms >= SPEECH_RMS_THRESHOLD) {
            voicedFramesInSegment += 1;
          }
        }, 100);
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recordSegment = () => {
        if (!isRecordingRef.current || !recorderStreamRef.current) return;
        voicedFramesInSegment = 0;

        const recorder = new MediaRecorder(recorderStreamRef.current, { mimeType });
        mediaRecorderRef.current = recorder;
        const chunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          const hadSpeech = !audioCtxRef.current || voicedFramesInSegment >= MIN_VOICED_FRAMES_PER_CHUNK;
          if (!hadSpeech || chunks.length === 0) {
            return; // Drop silent/ambient noise segment before hitting Whisper!
          }

          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size < 1500) return;

          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              safeSend({
                type: "audio_chunk",
                speaker: name,
                audio: reader.result,
              });
            }
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
      };

      setSpeechError("");
      recordSegment();

      recorderTimerRef.current = setInterval(() => {
        if (!isRecordingRef.current) return;
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.stop();
        }
        recordSegment();
      }, 3500);
    } catch (err) {
      console.error("Audio fallback error:", err);
      isRecordingRef.current = false;
      setIsRecording(false);
      usingFallbackRef.current = false;
      setSpeechError("Could not access microphone for transcription.");
    }
  }, [name, safeSend]);

  const startMic = () => {
    if (!socketReady) {
      setSpeechError("Transcript WebSocket is still connecting. Please wait a moment.");
      return;
    }

    if (isRecordingRef.current) {
      return;
    }

    setSpeechError("");
    isRecordingRef.current = true;
    setIsRecording(true);
    networkErrorCountRef.current = 0;

    safeSend({
      type: "speaking",
      speaker: name,
    });

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      startServerWhisperFallback();
      return;
    }

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = true;

    recognitionRef.current.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        isRecordingRef.current = false;
        setIsRecording(false);
        setSpeechError("Microphone permission was denied.");
        return;
      }

      if (event.error === "network") {
        networkErrorCountRef.current += 1;
        if (networkErrorCountRef.current >= 1) {
          console.info("Browser SpeechRecognition blocked (e.g. Brave) — switching to Groq Whisper fallback.");
          try {
            recognitionRef.current?.stop();
          } catch {
            // ignore
          }
          recognitionRef.current = null;
          startServerWhisperFallback();
          return;
        }
      }

      if (event.error === "aborted") return;
      console.error("Speech Recognition Error:", event.error);
    };

    recognitionRef.current.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!normalizeSpeech(text)) continue;

        if (result.isFinal) {
          networkErrorCountRef.current = 0;
        }

        safeSend({
          speaker: name,
          text,
          is_final: Boolean(result.isFinal),
        });
      }
    };

    recognitionRef.current.onend = () => {
      if (!isRecordingRef.current || usingFallbackRef.current) return;

      const delay = networkErrorCountRef.current > 0
        ? Math.min(100 * Math.pow(2, networkErrorCountRef.current - 1), 3200)
        : 0;

      const doRestart = () => {
        if (!isRecordingRef.current || usingFallbackRef.current || !recognitionRef.current) return;
        try {
          recognitionRef.current.start();
        } catch {
          setTimeout(() => {
            if (!isRecordingRef.current || usingFallbackRef.current || !recognitionRef.current) return;
            try { recognitionRef.current.start(); } catch { /* give up */ }
          }, 50);
        }
      };

      if (delay === 0) {
        doRestart();
      } else {
        setTimeout(doRestart, delay);
      }
    };

    recognitionRef.current.start();
  };

  const stopMic = () => {
    isRecordingRef.current = false;
    setIsRecording(false);
    safeSend({
      type: "stopped_speaking",
      speaker: name,
    });
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    cleanupFallbackRecorder();
  };

  const requestSummary = () => {
    safeSend({ type: "request_summary" });
  };

  const activeSpeaker =
    activeSpeakers.length > 0 ? activeSpeakers[activeSpeakers.length - 1] : null;

  return {
    transcript,
    summary,
    startMic,
    stopMic,
    requestSummary,
    activeSpeaker,
    activeSpeakers,
    talkTime,
    socketReady,
    isRecording,
    speechError,
  };
}
