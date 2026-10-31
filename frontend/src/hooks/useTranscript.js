import { useEffect, useRef, useState, useCallback } from "react";
import { buildWsUrl } from "../utils/wsUrl";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;

// Voice Activity Detection (VAD) & utterance segmentation tuning
const SPEECH_RMS_THRESHOLD = 0.006;
const SPEAKING_ONSET_FRAMES = 2;     // ~160ms of voice before lighting green border (ignores clicks)
const SPEAKING_HOLD_MS = 650;        // Turn off green border 650ms after user stops speaking
const UTTERANCE_SILENCE_MS = 1150;   // Wait for a natural 1.15s pause before finalizing Whisper clip
const MIN_SPEECH_DURATION_MS = 600;
const SOFT_MAX_SEGMENT_MS = 13000;   // After 13s of non-stop talk, split cleanly on a 350ms breath
const BREATH_PAUSE_MS = 350;
const HARD_MAX_SEGMENT_MS = 22000;   // Stay safely inside Whisper's 30s acoustic window
const IDLE_ROTATE_MS = 5000;         // Reset silent buffer every 5s so memory stays flat
const NO_VAD_FALLBACK_MS = 10000;

// Transcript turn-merging windows
const TURN_MERGE_WINDOW_MS = 8000;
const INCOMPLETE_SENTENCE_MERGE_MS = 18000;

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

export default function useTranscript(
  roomId,
  name,
  sharedStreamRef = null,
  micActive = false
) {
  const [transcript, setTranscript] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activeSpeakers, setActiveSpeakers] = useState([]);
  const [talkTime, setTalkTime] = useState({});
  const [socketReady, setSocketReady] = useState(false);
  const [speechError, setSpeechError] = useState("");

  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recorderStreamRef = useRef(null);
  const recorderTimerRef = useRef(null);
  const vadTimerRef = useRef(null);
  const vadStreamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const activeSegStatsRef = useRef(null);
  const noiseFloorRef = useRef(0.0025);
  const vadHasSignalRef = useRef(false);
  const isVoiceActiveRef = useRef(false);
  const fallbackSpeakHoldTimerRef = useRef(null);
  const turnIdRef = useRef(0);
  const usingFallbackRef = useRef(false);
  const isListeningRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const connectRef = useRef(null);
  const networkErrorCountRef = useRef(0);

  const transcriptBufferRef = useRef([]);
  const rafIdRef = useRef(null);

  const safeSend = useCallback((payload) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const setSpeakingState = useCallback(
    (speakingNow) => {
      if (speakingNow && !isVoiceActiveRef.current) {
        isVoiceActiveRef.current = true;
        safeSend({
          type: "speaking",
          speaker: name,
        });
      } else if (!speakingNow && isVoiceActiveRef.current) {
        isVoiceActiveRef.current = false;
        safeSend({
          type: "stopped_speaking",
          speaker: name,
        });
      }
    },
    [name, safeSend]
  );

  // Used only when WebAudio waveform samples are blocked by strict browser privacy shields
  const pulseFallbackSpeaking = useCallback(() => {
    if (vadHasSignalRef.current || !isListeningRef.current) return;
    setSpeakingState(true);
    clearTimeout(fallbackSpeakHoldTimerRef.current);
    fallbackSpeakHoldTimerRef.current = setTimeout(() => {
      setSpeakingState(false);
    }, 1200);
  }, [setSpeakingState]);

  const flushTranscript = useCallback(() => {
    rafIdRef.current = null;
    if (transcriptBufferRef.current.length === 0) return;

    const batch = transcriptBufferRef.current;
    transcriptBufferRef.current = [];
    const now = Date.now();

    setTranscript((prev) => {
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

          // 1. Speaker's bubble had an active interim preview — update or finalize in-place
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

          // 2. Deduplicate repeated/expanded emissions of the exact same clause
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
        isVoiceActiveRef.current = false;
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
            setActiveSpeakers((prev) =>
              prev.includes(data.speaker) ? prev : [...prev, data.speaker]
            );
          }
        }

        if (data.type === "stopped_speaking") {
          if (Array.isArray(data.active_speakers)) {
            setActiveSpeakers(data.active_speakers);
          } else if (data.speaker) {
            setActiveSpeakers((prev) => prev.filter((s) => s !== data.speaker));
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

  const stopVoiceActivityMonitor = useCallback(() => {
    clearInterval(vadTimerRef.current);
    vadTimerRef.current = null;
    clearTimeout(fallbackSpeakHoldTimerRef.current);
    fallbackSpeakHoldTimerRef.current = null;
    vadHasSignalRef.current = false;

    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {
        // ignore
      }
      audioCtxRef.current = null;
    }

    if (vadStreamRef.current) {
      vadStreamRef.current.getTracks().forEach((t) => t.stop());
      vadStreamRef.current = null;
    }
  }, []);

  const cleanupFallbackRecorder = useCallback((flushActive = false) => {
    usingFallbackRef.current = false;
    clearInterval(recorderTimerRef.current);
    recorderTimerRef.current = null;

    const activeRecorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;

    const releaseRecorderStream = () => {
      if (recorderStreamRef.current) {
        recorderStreamRef.current.getTracks().forEach((t) => t.stop());
        recorderStreamRef.current = null;
      }
    };

    if (activeRecorder && activeRecorder.state === "recording") {
      if (flushActive) {
        activeRecorder.addEventListener("stop", releaseRecorderStream, { once: true });
        try {
          activeRecorder.stop();
          return;
        } catch {
          // fall through
        }
      } else {
        try {
          activeRecorder.stop();
        } catch {
          // ignore
        }
      }
    }

    releaseRecorderStream();
  }, []);

  /**
   * Real-time WebAudio Voice Activity Monitor:
   * - Lights up the participant's green tile border ONLY while they are actually speaking
   * - Turns the green border OFF ~650ms after they stop talking (even while Mic remains On!)
   * - Feeds RMS speech stats to the Whisper fallback segmenter when active
   */
  const startVoiceActivityMonitor = useCallback(async () => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || vadTimerRef.current) return;

    try {
      let stream = null;
      const liveTrack = sharedStreamRef?.current
        ?.getAudioTracks?.()
        .find((t) => t.readyState === "live");

      if (liveTrack && typeof liveTrack.clone === "function") {
        const cloned = liveTrack.clone();
        cloned.enabled = true;
        stream = new MediaStream([cloned]);
      } else if (navigator.mediaDevices?.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      if (!stream || !isListeningRef.current) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }

      vadStreamRef.current = stream;
      noiseFloorRef.current = 0.0025;
      vadHasSignalRef.current = false;

      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
        const unlock = () => {
          if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
            audioCtxRef.current.resume().catch(() => {});
          }
        };
        document.addEventListener("pointerdown", unlock, { once: true });
        document.addEventListener("touchstart", unlock, { once: true });
        document.addEventListener("keydown", unlock, { once: true });
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const pcm = new Float32Array(analyser.fftSize);

      let consecutiveVoiced = 0;
      let lastVoiceAt = 0;

      vadTimerRef.current = setInterval(() => {
        if (!isListeningRef.current || audioCtx.state !== "running") return;

        analyser.getFloatTimeDomainData(pcm);
        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) {
          sumSq += pcm[i] * pcm[i];
        }
        const rms = Math.sqrt(sumSq / pcm.length);
        const now = performance.now();

        if (rms > 0) {
          vadHasSignalRef.current = true;
        }

        // Adaptive ambient noise floor so steady fan/AC hum never keeps the tile green!
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

        const isVoiced = rms >= voiceThreshold;

        // 1. Update live green-border speaking indicator + talk-time analytics
        if (isVoiced) {
          consecutiveVoiced += 1;
          lastVoiceAt = now;
          if (consecutiveVoiced >= SPEAKING_ONSET_FRAMES) {
            setSpeakingState(true);
          }
        } else {
          consecutiveVoiced = 0;
          if (isVoiceActiveRef.current && now - lastVoiceAt >= SPEAKING_HOLD_MS) {
            setSpeakingState(false);
          }
        }

        // 2. Feed segment stats if Whisper MediaRecorder fallback is active
        const segStats = activeSegStatsRef.current;
        if (segStats) {
          segStats.samples += 1;
          segStats.currentRms = rms;
          if (rms > segStats.peakRms) segStats.peakRms = rms;
          if (isVoiced) {
            segStats.voicedFrames += 1;
            segStats.lastVoiceAt = now;
            if (!segStats.firstVoiceAt) {
              segStats.firstVoiceAt = now;
            }
          }
        }
      }, 80);
    } catch (err) {
      console.warn("WebAudio VAD monitor unavailable:", err);
    }
  }, [sharedStreamRef, setSpeakingState]);

  /**
   * Pause-driven English Whisper segmenter for Brave / Firefox / Safari / iOS.
   */
  const startServerWhisperFallback = useCallback(async () => {
    if (usingFallbackRef.current || !isListeningRef.current) return;
    usingFallbackRef.current = true;

    try {
      let stream = null;
      const existingAudioTrack = sharedStreamRef?.current
        ?.getAudioTracks?.()
        .find((t) => t.readyState === "live");

      if (existingAudioTrack && typeof existingAudioTrack.clone === "function") {
        const clonedTrack = existingAudioTrack.clone();
        clonedTrack.enabled = true;
        stream = new MediaStream([clonedTrack]);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      }

      if (!isListeningRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      recorderStreamRef.current = stream;

      const candidateMimeTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const mimeType =
        (typeof MediaRecorder !== "undefined" &&
          typeof MediaRecorder.isTypeSupported === "function" &&
          candidateMimeTypes.find((t) => MediaRecorder.isTypeSupported(t))) ||
        "";

      const recordSegment = () => {
        if (!isListeningRef.current || !recorderStreamRef.current) return;

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
          turnId: turnIdRef.current,
        };
        activeSegStatsRef.current = segStats;

        const recorder = mimeType
          ? new MediaRecorder(recorderStreamRef.current, { mimeType })
          : new MediaRecorder(recorderStreamRef.current);
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

          const resolvedType = mimeType || recorder.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: resolvedType });
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
        if (!isListeningRef.current || !recorderStreamRef.current) return;
        const prevStats = activeSegStatsRef.current;
        if (prevStats) {
          prevStats.continued = isContinuation;
        }
        const prevRecorder = mediaRecorderRef.current;
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
        if (!isListeningRef.current) return;
        const stats = activeSegStatsRef.current;
        if (!stats) return;

        const now = performance.now();
        const elapsed = now - stats.startedAt;
        const vadActive = stats.samples > 4 && stats.peakRms > 0;

        if (vadActive) {
          if (stats.voicedFrames >= 2) {
            const silenceMs = now - stats.lastVoiceAt;
            const speechSpanMs = now - (stats.firstVoiceAt || stats.startedAt);

            if (speechSpanMs >= MIN_SPEECH_DURATION_MS && silenceMs >= UTTERANCE_SILENCE_MS) {
              cutAndRestartSegment(false);
              return;
            }

            if (elapsed >= SOFT_MAX_SEGMENT_MS && silenceMs >= BREATH_PAUSE_MS) {
              cutAndRestartSegment(true);
              return;
            }

            if (elapsed >= HARD_MAX_SEGMENT_MS) {
              cutAndRestartSegment(true);
              return;
            }
          } else if (
            stats.voicedFrames === 0 &&
            elapsed >= IDLE_ROTATE_MS &&
            stats.currentRms < SPEECH_RMS_THRESHOLD
          ) {
            cutAndRestartSegment(false);
          }
        } else if (elapsed >= NO_VAD_FALLBACK_MS) {
          cutAndRestartSegment(true);
        }
      }, 100);
    } catch (err) {
      console.error("Audio fallback error:", err);
      usingFallbackRef.current = false;
      setSpeechError("Could not access microphone for transcription.");
    }
  }, [name, safeSend, sharedStreamRef]);

  // Automatically start/stop English transcription & voice-activity detection with Mic On/Off
  useEffect(() => {
    if (!socketReady || !micActive) {
      isListeningRef.current = false;
      setSpeakingState(false);
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      cleanupFallbackRecorder(true);
      stopVoiceActivityMonitor();
      return;
    }

    isListeningRef.current = true;
    turnIdRef.current += 1;
    const currentTurnId = turnIdRef.current;
    networkErrorCountRef.current = 0;
    setSpeechError("");

    startVoiceActivityMonitor();

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(
      navigator.userAgent || ""
    );

    // Mobile browsers contend with WebRTC audio or play OS chimes on SpeechRecognition;
    // cloning the live WebRTC track into Groq Whisper avoids both issues cleanly.
    if (!SpeechRecognition || isMobileBrowser) {
      startServerWhisperFallback();
      return () => {
        isListeningRef.current = false;
        setSpeakingState(false);
        cleanupFallbackRecorder(true);
        stopVoiceActivityMonitor();
      };
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setSpeechError("Microphone permission was denied.");
        return;
      }

      if (event.error === "network" || event.error === "audio-capture") {
        networkErrorCountRef.current += 1;
        if (networkErrorCountRef.current >= 1) {
          console.info(
            `Browser SpeechRecognition unavailable (${event.error}) — switching to Groq Whisper fallback.`
          );
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

      if (event.error === "aborted" || event.error === "no-speech") return;
      console.error("Speech Recognition Error:", event.error);
    };

    recognition.onresult = (event) => {
      pulseFallbackSpeaking();
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

    recognition.onend = () => {
      if (!isListeningRef.current || usingFallbackRef.current) return;

      const delay =
        networkErrorCountRef.current > 0
          ? Math.min(100 * Math.pow(2, networkErrorCountRef.current - 1), 3200)
          : 0;

      const doRestart = () => {
        if (!isListeningRef.current || usingFallbackRef.current || !recognitionRef.current) return;
        try {
          recognitionRef.current.start();
        } catch {
          setTimeout(() => {
            if (!isListeningRef.current || usingFallbackRef.current || !recognitionRef.current) return;
            try {
              recognitionRef.current.start();
            } catch {
              // ignore
            }
          }, 80);
        }
      };

      if (delay === 0) {
        doRestart();
      } else {
        setTimeout(doRestart, delay);
      }
    };

    try {
      recognition.start();
    } catch {
      startServerWhisperFallback();
    }

    return () => {
      isListeningRef.current = false;
      setSpeakingState(false);
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      cleanupFallbackRecorder(true);
      stopVoiceActivityMonitor();
    };
  }, [
    socketReady,
    micActive,
    name,
    safeSend,
    setSpeakingState,
    pulseFallbackSpeaking,
    startVoiceActivityMonitor,
    stopVoiceActivityMonitor,
    startServerWhisperFallback,
    cleanupFallbackRecorder,
  ]);

  useEffect(() => {
    unmountedRef.current = false;
    connectWebSocket();

    return () => {
      unmountedRef.current = true;
      isListeningRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      cleanupFallbackRecorder(false);
      stopVoiceActivityMonitor();
      clearTimeout(connectDelayRef.current);
      clearTimeout(reconnectTimerRef.current);
      cancelAnimationFrame(rafIdRef.current);
      socketRef.current?.close();
    };
  }, [connectWebSocket, cleanupFallbackRecorder, stopVoiceActivityMonitor]);

  const requestSummary = useCallback(() => {
    safeSend({ type: "request_summary" });
  }, [safeSend]);

  const activeSpeaker =
    activeSpeakers.length > 0 ? activeSpeakers[activeSpeakers.length - 1] : null;

  return {
    transcript,
    summary,
    requestSummary,
    activeSpeaker,
    activeSpeakers,
    talkTime,
    socketReady,
    speechError,
  };
}
