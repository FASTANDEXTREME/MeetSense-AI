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

  const connectWebSocket = useCallback(() => {
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

    recognitionRef.current.onerror = (event) => {
      console.error("Speech Recognition Error:", event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        isRecordingRef.current = false;
      }
    };

    recognitionRef.current.onresult = (event) => {
      const result = event.results[event.results.length - 1];

      if (result.isFinal) {
        safeSend({
          speaker: name,
          text: result[0].transcript
        });
      }
    };

    recognitionRef.current.onend = () => {
      if (isRecordingRef.current) {
        setTimeout(() => {
          try {
            recognitionRef.current?.start();
          } catch (error) {
            console.log("Could not auto-restart mic:", error);
          }
        }, 200);
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

  return {
    transcript,
    summary,
    startMic,
    stopMic,
    activeSpeaker,
    talkTime,
    socketReady
  };
}