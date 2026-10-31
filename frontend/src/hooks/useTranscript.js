import { useEffect, useRef, useState, useCallback } from "react";
import { buildWsUrl } from "../utils/wsUrl";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;

// Voice Activity Detection (VAD) & utterance segmentation tuning
const SPEECH_RMS_THRESHOLD = 0.005;
const UTTERANCE_SILENCE_MS = 1150;   // Wait for a natural 1.15s pause before finalizing clip
const MIN_SPEECH_DURATION_MS = 600;  // Minimum speech span before silence-triggered cut
const SOFT_MAX_SEGMENT_MS = 13000;   // After 13s of non-stop talk, split cleanly on a 350ms breath
const BREATH_PAUSE_MS = 350;
const HARD_MAX_SEGMENT_MS = 22000;   // Stay safely inside Whisper's 30s acoustic window
const IDLE_ROTATE_MS = 5000;         // Reset silent buffer every 5s so memory stays flat
const NO_VAD_FALLBACK_MS = 10000;    // Fallback window only if WebAudio waveform reads are blocked

// Transcript turn-merging windows
const TURN_MERGE_WINDOW_MS = 10000;
const INCOMPLETE_SENTENCE_MERGE_MS = 20000;

/**
 * Strip punctuation and normalize case/whitespace so "hello" and "Hello."
 * or "i am fine" and "I am fine." match cleanly.
 */
function normalizeSpeech(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function endsWithTerminalPunctuation(str) {
  return /[.?!]["')\]}]*$/.test((str || "").trim());
}

function joinTranscriptClauses(prevText, nextText) {
  const cleanPrev = (prevText || "").trim().replace(/\.{2,}$/, "").trim();
  const cleanNext = (nextText || "").trim().replace(/^\.{2,}\s*/, "").trim();
  if (!cleanPrev) return cleanNext;
  if (!cleanNext) return cleanPrev;
  return `${cleanPrev} ${cleanNext}`;
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
  const activeSegStatsRef = useRef(null);
  const noiseFloorRef = useRef(0.0025);
  const turnIdRef = useRef(0);
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
    const now = Date.now();

    setTranscript(prev => {
      let updated = prev;

      for (const entry of batch) {
        const incomingText = (entry.text || "").trim();
        const normNew = normalizeSpeech(incomingText);
        if (!normNew) continue;

        const entryIsFinal = entry.is_final !== false;
        const entryTurnId = entry.turn_id ?? null;
        const entryContinued = Boolean(entry.continued);

        // Search recent entries so simultaneous speakers update their own in-flight bubble
        // without shattering into interleaved fragments, while back-and-forth replies stay chronological.
        let targetIdx = -1;
        const minSearchIdx = Math.max(0, updated.length - 6);
        for (let i = updated.length - 1; i >= minSearchIdx; i--) {
          if (updated[i].speaker === entry.speaker) {
            targetIdx = i;
            break;
          }
        }

        if (targetIdx !== -1) {
          const target = updated[targetIdx];
          const isLatestBubble = targetIdx === updated.length - 1;
          const prevFinalized = target.finalizedText ?? (target.is_final ? target.text : "");
          const prevLastClause = target.lastClause ?? prevFinalized;
          const normLastClause = normalizeSpeech(prevLastClause);

          // 1. Speaker's bubble had an active interim preview — update or finalize in-place even during overlap
          if (target.is_final === false) {
            if (updated === prev) updated = [...prev];
            if (entryIsFinal) {
              const mergedFinal = joinTranscriptClauses(prevFinalized, incomingText);
              updated[targetIdx] = {
                speaker: entry.speaker,
                finalizedText: mergedFinal,
                interimText: "",
                lastClause: incomingText,
                text: mergedFinal,
                is_final: true,
                turnId: entryTurnId ?? target.turnId,
                updatedAt: now,
              };
            } else {
              const previewText = joinTranscriptClauses(prevFinalized, incomingText);
              updated[targetIdx] = {
                ...target,
                interimText: incomingText,
                text: previewText,
                is_final: false,
                turnId: entryTurnId ?? target.turnId,
                updatedAt: now,
              };
            }
            continue;
          }

          // 2. Deduplicate repeated/expanded emissions of the exact same clause for this speaker
          if (
            normLastClause &&
            (normNew === normLastClause ||
              normLastClause.includes(normNew) ||
              normNew.startsWith(normLastClause))
          ) {
            if (entryIsFinal && normNew.length >= normLastClause.length) {
              if (updated === prev) updated = [...prev];
              const prefixLen = Math.max(0, prevFinalized.length - prevLastClause.length);
              const baseBeforeLast = prevFinalized.slice(0, prefixLen).trim();
              const replacedFinal = joinTranscriptClauses(baseBeforeLast, incomingText);
              updated[targetIdx] = {
                ...target,
                finalizedText: replacedFinal,
                interimText: "",
                lastClause: incomingText,
                text: replacedFinal,
                is_final: true,
                updatedAt: now,
              };
            }
            continue;
          }

          // 3. Merge continuous speech (and mid-sentence overlap), while keeping back-and-forth replies ordered
          const differentExplicitTurn =
            entryTurnId !== null &&
            target.turnId !== null &&
            entryTurnId !== target.turnId;

          const sameExplicitTurn =
            entryTurnId !== null &&
            target.turnId !== null &&
            entryTurnId === target.turnId;

          const gapMs = now - (target.updatedAt || 0);
          const prevIncomplete = !endsWithTerminalPunctuation(prevFinalized);

          const shouldMerge = isLatestBubble
            ? !differentExplicitTurn &&
              (entryContinued ||
                (prevIncomplete && gapMs < INCOMPLETE_SENTENCE_MERGE_MS) ||
                (sameExplicitTurn && gapMs < TURN_MERGE_WINDOW_MS) ||
                (!entryIsFinal && gapMs < TURN_MERGE_WINDOW_MS))
            : !differentExplicitTurn &&
              (entryContinued || (prevIncomplete && gapMs < 4500));

          if (shouldMerge) {
            if (updated === prev) updated = [...prev];
            if (entryIsFinal) {
              const mergedFinal = joinTranscriptClauses(prevFinalized, incomingText);
              updated[targetIdx] = {
                speaker: entry.speaker,
                finalizedText: mergedFinal,
                interimText: "",
                lastClause: incomingText,
                text: mergedFinal,
                is_final: true,
                turnId: entryTurnId ?? target.turnId,
                updatedAt: now,
              };
            } else {
              const previewText = joinTranscriptClauses(prevFinalized, incomingText);
              updated[targetIdx] = {
                speaker: entry.speaker,
                finalizedText: prevFinalized,
                interimText: incomingText,
                lastClause: prevLastClause,
                text: previewText,
                is_final: false,
                turnId: entryTurnId ?? target.turnId,
                updatedAt: now,
              };
            }
            continue;
          }
        }

        if (updated === prev) updated = [...prev];
        updated.push({
          speaker: entry.speaker,
          finalizedText: entryIsFinal ? incomingText : "",
          interimText: entryIsFinal ? "" : incomingText,
          lastClause: entryIsFinal ? incomingText : "",
          text: incomingText,
          is_final: entryIsFinal,
          turnId: entryTurnId,
          updatedAt: now,
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

  const cleanupFallbackRecorder = useCallback((flushActive = false) => {
    usingFallbackRef.current = false;
    clearInterval(recorderTimerRef.current);
    recorderTimerRef.current = null;
    clearInterval(vadTimerRef.current);
    vadTimerRef.current = null;

    const activeRecorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;

    const releaseAudioHardware = () => {
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
    };

    if (activeRecorder && activeRecorder.state === "recording") {
      if (flushActive) {
        activeRecorder.addEventListener("stop", releaseAudioHardware, { once: true });
        try {
          activeRecorder.stop();
          return;
        } catch {
          // fall through to immediate cleanup
        }
      } else {
        try {
          activeRecorder.stop();
        } catch {
          // ignore
        }
      }
    }

    releaseAudioHardware();
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connectWebSocket();

    return () => {
      unmountedRef.current = true;
      isRecordingRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      cleanupFallbackRecorder(false);
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
   * Pause-driven voice-activity segmenter for Brave / Firefox / Safari.
   * Never cuts mid-sentence: keeps recording while the user is actively speaking
   * and only flushes once a natural pause (1.15s) occurs (or on a breath pause
   * after 13s of non-stop speech, staying safely within Whisper's 30s limit).
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
      noiseFloorRef.current = 0.0025;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        try {
          const audioCtx = audioCtxRef.current || new AudioCtx();
          if (audioCtx.state === "suspended") {
            await audioCtx.resume().catch(() => {});
          }
          audioCtxRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          const pcm = new Float32Array(analyser.fftSize);

          vadTimerRef.current = setInterval(() => {
            const stats = activeSegStatsRef.current;
            if (!stats || audioCtx.state !== "running") return;

            analyser.getFloatTimeDomainData(pcm);
            let sumSq = 0;
            for (let i = 0; i < pcm.length; i++) {
              sumSq += pcm[i] * pcm[i];
            }
            const rms = Math.sqrt(sumSq / pcm.length);
            const now = performance.now();

            // Adaptive ambient noise floor so steady fan/AC hum doesn't prevent pause detection
            const floor = noiseFloorRef.current;
            if (rms < floor) {
              noiseFloorRef.current = floor * 0.9 + rms * 0.1;
            } else if (rms < floor * 1.8) {
              noiseFloorRef.current = Math.min(0.02, floor * 0.995 + rms * 0.005);
            }

            const voiceThreshold = Math.max(
              SPEECH_RMS_THRESHOLD,
              Math.min(noiseFloorRef.current * 2.4, 0.025)
            );

            stats.samples += 1;
            stats.currentRms = rms;
            if (rms > stats.peakRms) stats.peakRms = rms;

            if (rms >= voiceThreshold) {
              stats.voicedFrames += 1;
              stats.lastVoiceAt = now;
              if (!stats.firstVoiceAt) {
                stats.firstVoiceAt = now;
              }
            }
          }, 80);
        } catch (vadErr) {
          console.warn("WebAudio VAD unavailable, relying on backend silence filter:", vadErr);
        }
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const currentTurnId = turnIdRef.current;

      const recordSegment = () => {
        if (!isRecordingRef.current || !recorderStreamRef.current) return;

        const now = performance.now();
        const segStats = {
          startedAt: now,
          firstVoiceAt: 0,
          lastVoiceAt: 0,
          voicedFrames: 0,
          peakRms: 0,
          currentRms: 0,
          samples: 0,
          continued: false,
          turnId: currentTurnId,
        };
        activeSegStatsRef.current = segStats;

        const recorder = new MediaRecorder(recorderStreamRef.current, { mimeType });
        mediaRecorderRef.current = recorder;
        const chunks = [];

        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
          if (chunks.length === 0) return;

          const vadActive = segStats.samples > 4 && segStats.peakRms > 0;
          if (vadActive && segStats.voicedFrames < 1) {
            return; // Pure silence — skip API call
          }

          const blob = new Blob(chunks, { type: mimeType });
          if (blob.size < 1000) return;

          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              safeSend({
                type: "audio_chunk",
                speaker: name,
                audio: reader.result,
                continued: segStats.continued,
                turn_id: segStats.turnId,
              });
            }
          };
          reader.readAsDataURL(blob);
        };

        recorder.start();
      };

      const cutAndRestartSegment = (isContinuation = false) => {
        if (!isRecordingRef.current || !recorderStreamRef.current) return;
        const prevStats = activeSegStatsRef.current;
        if (prevStats) {
          prevStats.continued = isContinuation;
        }
        const prevRecorder = mediaRecorderRef.current;
        // Start next segment first on the same stream so zero speech is lost across the boundary
        recordSegment();
        if (prevRecorder && prevRecorder.state === "recording") {
          try {
            prevRecorder.stop();
          } catch {
            // ignore
          }
        }
      };

      setSpeechError("");
      recordSegment();

      recorderTimerRef.current = setInterval(() => {
        if (!isRecordingRef.current) return;
        const stats = activeSegStatsRef.current;
        if (!stats) return;

        const now = performance.now();
        const elapsed = now - stats.startedAt;
        const vadActive = stats.samples > 4 && stats.peakRms > 0;

        if (vadActive) {
          if (stats.voicedFrames >= 2) {
            const silenceMs = now - stats.lastVoiceAt;
            const speechSpanMs = now - (stats.firstVoiceAt || stats.startedAt);

            // 1. Natural end-of-sentence pause (1.15s of silence after speech)
            if (speechSpanMs >= MIN_SPEECH_DURATION_MS && silenceMs >= UTTERANCE_SILENCE_MS) {
              cutAndRestartSegment(false);
              return;
            }

            // 2. Continuous long speech (>13s): split cleanly on a 350ms breath and merge seamlessly
            if (elapsed >= SOFT_MAX_SEGMENT_MS && silenceMs >= BREATH_PAUSE_MS) {
              cutAndRestartSegment(true);
              return;
            }

            // 3. Hard cap (22s) so audio never exceeds Whisper's 30s window
            if (elapsed >= HARD_MAX_SEGMENT_MS) {
              cutAndRestartSegment(true);
              return;
            }
          } else if (
            stats.voicedFrames === 0 &&
            elapsed >= IDLE_ROTATE_MS &&
            stats.currentRms < SPEECH_RMS_THRESHOLD
          ) {
            // Quiet room idle buffer reset (nothing sent to backend)
            cutAndRestartSegment(false);
          }
        } else if (elapsed >= NO_VAD_FALLBACK_MS) {
          cutAndRestartSegment(true);
        }
      }, 100);
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

    turnIdRef.current += 1;
    const currentTurnId = turnIdRef.current;

    setSpeechError("");
    isRecordingRef.current = true;
    setIsRecording(true);
    networkErrorCountRef.current = 0;

    // Pre-create/unlock AudioContext synchronously inside the user click gesture
    // so if Brave falls back to MediaRecorder + VAD asynchronously, it isn't suspended!
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !audioCtxRef.current) {
      try {
        const ctx = new AudioCtx();
        if (ctx.state === "suspended") {
          ctx.resume().catch(() => {});
        }
        audioCtxRef.current = ctx;
      } catch {
        // ignore
      }
    }

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
          turn_id: currentTurnId,
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
    cleanupFallbackRecorder(true);
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
