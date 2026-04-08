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

        if (data.type === "transcript") {
          setTranscript(prev => [...prev, data]);
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
  }, [roomId, scheduleReconnect]);

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
      socketRef.current?.close();
    };
  }, [connectWebSocket]);


  // Safe send function
  const safeSend = (payload) => {
    if (
      socketRef.current &&
      socketRef.current.readyState === WebSocket.OPEN
    ) {
      socketRef.current.send(JSON.stringify(payload));
    }
  };


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
    recognitionRef.current.interimResults = false;

    isRecordingRef.current = true;
    networkErrorCountRef.current = 0;

    recognitionRef.current.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.error("Speech Recognition Error:", event.error);
        isRecordingRef.current = false;
        return;
      }

      if (event.error === 'network') {
        networkErrorCountRef.current += 1;
        if (networkErrorCountRef.current >= MAX_NETWORK_ERRORS) {
          console.warn(`Speech recognition stopped after ${MAX_NETWORK_ERRORS} consecutive network errors. Check your internet connection.`);
          isRecordingRef.current = false;
          alert("Speech recognition lost connection to the server. Please check your internet and try again.");
          return;
        }
        console.warn(`Speech recognition network error (${networkErrorCountRef.current}/${MAX_NETWORK_ERRORS})`);
        return;
      }

      console.error("Speech Recognition Error:", event.error);
    };

    recognitionRef.current.onresult = (event) => {
      const result = event.results[event.results.length - 1];

      if (result.isFinal) {
        // Reset network error count on successful recognition
        networkErrorCountRef.current = 0;
        safeSend({
          speaker: name,
          text: result[0].transcript
        });
      }
    };

    recognitionRef.current.onend = () => {
      if (isRecordingRef.current) {
        // Exponential backoff: 200ms, 400ms, 800ms, 1600ms, 3200ms
        const delay = 200 * Math.pow(2, networkErrorCountRef.current);
        setTimeout(() => {
          try {
            recognitionRef.current?.start();
          } catch (error) {
            console.log("Could not auto-restart mic:", error);
          }
        }, delay);
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