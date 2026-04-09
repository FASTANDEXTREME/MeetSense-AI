import { useEffect, useRef, useState, useCallback } from "react";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1000;

export default function useTranscript(roomId, name) {

  const [transcript, setTranscript] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [talkTime, setTalkTime] = useState({});
  const [socketReady, setSocketReady] = useState(false);

  const socketRef = useRef(null);
  const recognitionRef = useRef(null);
  const isRecordingRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const connectRef = useRef(null);
  const networkErrorCountRef = useRef(0);
  const MAX_NETWORK_ERRORS = 5;

  // ── FIX #3: rAF-batched transcript buffer ─────────────────────────
  // Instead of calling setTranscript() on every single WebSocket echo,
  // we buffer incoming transcript messages and flush them in a single
  // state update per animation frame (~16ms). This prevents React from
  // re-rendering 20+ times per second when interim results are rapid.
  const transcriptBufferRef = useRef([]);
  const rafIdRef = useRef(null);

  const flushTranscript = useCallback(() => {
    rafIdRef.current = null;
    if (transcriptBufferRef.current.length === 0) return;

    const batch = transcriptBufferRef.current;
    transcriptBufferRef.current = [];

    setTranscript(prev => {
      // We use a copy-on-write pattern: `updated` stays === `prev`
      // until we actually need to modify, avoiding unnecessary copies.
      let updated = prev;

      for (const entry of batch) {
        const last = updated.length > 0 ? updated[updated.length - 1] : null;

        // Client-side dedup: mirrors backend's is_near_duplicate logic.
        // If the last entry is from the same speaker and one text is a
        // substring of the other, replace in-place instead of appending.
        if (last && last.speaker === entry.speaker) {
          const lastText = last.text.trim();
          const newText = entry.text.trim();

          if (newText.includes(lastText) || lastText.includes(newText)) {
            if (updated === prev) updated = [...prev];
            updated[updated.length - 1] = {
              ...last,
              text: newText.length >= lastText.length ? newText : lastText,
            };
            continue;
          }
        }

        // Genuinely new content or different speaker → append
        if (updated === prev) updated = [...prev];
        updated.push(entry);
      }

      return updated;
    });
  }, []);

  // Store connect function in ref to break circular dependency
  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("Max transcript WS reconnect attempts reached.");
      return;
    }

    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptRef.current);
    console.log(`Reconnecting transcript WS in ${delay}ms (attempt ${reconnectAttemptRef.current + 1})...`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1;
      connectRef.current?.();
    }, delay);
  }, []);

  const connectDelayRef = useRef(null);

  const connectWebSocket = useCallback(() => {
    if (unmountedRef.current) return;

    // Delay connection slightly so React Strict Mode's immediate
    // unmount can cancel the timer before the socket is ever created.
    connectDelayRef.current = setTimeout(() => {
      if (unmountedRef.current) return;

      const wsHost = window.location.hostname || "localhost";
      const ws = new WebSocket(`ws://${wsHost}:8000/ws/${roomId}`);
      socketRef.current = ws;

      ws.onopen = () => {
        console.log("Transcript WebSocket connected");
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

        // FIX #3: Buffer transcript messages, flush once per frame
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
          setActiveSpeaker(data.speaker);
        }

        if (data.type === "stopped_speaking") {
          setActiveSpeaker(null);
        }

        if (data.type === "talk_time") {
          setTalkTime(data.data);
        }
      };
    }, 100);
  }, [roomId, scheduleReconnect, flushTranscript]);

  // Keep connectRef in sync
  useEffect(() => {
    connectRef.current = connectWebSocket;
  }, [connectWebSocket]);

  useEffect(() => {
    unmountedRef.current = false;
    connectWebSocket();

    return () => {
      unmountedRef.current = true;
      clearTimeout(connectDelayRef.current);
      clearTimeout(reconnectTimerRef.current);
      cancelAnimationFrame(rafIdRef.current);
      socketRef.current?.close();
    };
  }, [connectWebSocket]);


  // Safe send — stable ref, no deps (reads socketRef.current at call time)
  const safeSend = useCallback((payload) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);


  const startMic = () => {

    if (!socketReady) {
      alert("WebSocket not connected yet. Please wait.");
      return;
    }

    if (isRecordingRef.current) {
      return; // Already recording
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert("Speech Recognition is not supported by your browser.");
      return;
    }

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = true; // FIX #1: real-time word-by-word

    isRecordingRef.current = true;
    networkErrorCountRef.current = 0;

    // ── Error handler ───────────────────────────────────────────────
    recognitionRef.current.onerror = (event) => {
      // Fatal: user denied mic permission
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.error("Speech Recognition Error:", event.error);
        isRecordingRef.current = false;
        return;
      }

      // Transient: network hiccup — count toward MAX_NETWORK_ERRORS
      if (event.error === 'network') {
        networkErrorCountRef.current += 1;
        if (networkErrorCountRef.current >= MAX_NETWORK_ERRORS) {
          console.warn(`Speech recognition stopped after ${MAX_NETWORK_ERRORS} consecutive network errors.`);
          isRecordingRef.current = false;
          alert("Speech recognition lost connection. Please check your internet and try again.");
          return;
        }
        console.warn(`Network error (${networkErrorCountRef.current}/${MAX_NETWORK_ERRORS})`);
        return;
      }

      // Fast restarts can cause 'aborted' — harmless, ignore it
      if (event.error === 'aborted') return;

      console.error("Speech Recognition Error:", event.error);
    };

    // ── Result handler ──────────────────────────────────────────────
    // FIX #1: Process BOTH interim and final results. The backend's
    // is_near_duplicate() handles the rapid overlapping updates, so
    // it's safe to send every interim. This makes transcription feel
    // instant instead of waiting for full-sentence finalization.
    recognitionRef.current.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;

        if (result.isFinal) {
          // Successful final → healthy connection, reset error count
          networkErrorCountRef.current = 0;
        }

        // Send both interim and final — payload stays { speaker, text }
        safeSend({ speaker: name, text });
      }
    };

    // ── End handler (auto-restart) ──────────────────────────────────
    // FIX #2: The "deaf gap". The browser fires onend after pauses,
    // silence timeouts, or transient errors. We restart IMMEDIATELY
    // (0ms) when healthy, keeping the mic hot at all times. Backoff
    // only kicks in when there are actual consecutive network errors.
    recognitionRef.current.onend = () => {
      if (!isRecordingRef.current) return;

      // Healthy: 0ms. Network errors: 100ms → 200ms → 400ms → … → 3200ms cap
      const delay = networkErrorCountRef.current > 0
        ? Math.min(100 * Math.pow(2, networkErrorCountRef.current - 1), 3200)
        : 0;

      const doRestart = () => {
        if (!isRecordingRef.current) return;
        try {
          recognitionRef.current?.start();
        } catch (e) {
          // "already started" race — wait one tick and retry once
          setTimeout(() => {
            if (!isRecordingRef.current) return;
            try { recognitionRef.current?.start(); } catch { /* give up */ }
          }, 50);
        }
      };

      if (delay === 0) {
        doRestart();
      } else {
        setTimeout(doRestart, delay);
      }
    };

    safeSend({
      type: "speaking",
      speaker: name
    });

    recognitionRef.current.start();
  };


  const stopMic = () => {
    isRecordingRef.current = false;
    safeSend({
      type: "stopped_speaking",
      speaker: name
    });
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  };

  const requestSummary = () => {
    safeSend({ type: "request_summary" });
  };

  return {
    transcript,
    summary,
    startMic,
    stopMic,
    requestSummary,
    activeSpeaker,
    talkTime,
    socketReady
  };
}