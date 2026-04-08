import { useEffect, useRef, useState } from "react";

export default function useTranscript(roomId, name) {

  const [transcript, setTranscript] = useState([]);
  const [summary, setSummary] = useState(null);
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [talkTime, setTalkTime] = useState({});
  const [socketReady, setSocketReady] = useState(false);

  const socketRef = useRef(null);
  const recognitionRef = useRef(null);

  useEffect(() => {
    const wsHost = window.location.hostname || "localhost";
    socketRef.current = new WebSocket(
      `ws://${wsHost}:8000/ws/${roomId}`
    );

    socketRef.current.onopen = () => {
      console.log("WebSocket Connected");
      setSocketReady(true);
    };

    socketRef.current.onclose = () => {
      setSocketReady(false);
    };

    socketRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

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

    return () => {
      socketRef.current?.close();
    };

  }, [roomId]);


  // 🔥 SAFE SEND FUNCTION
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

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    recognitionRef.current = new SpeechRecognition();
    recognitionRef.current.continuous = true;
    recognitionRef.current.interimResults = false;

    recognitionRef.current.onstart = () => {
      safeSend({
        type: "speaking",
        speaker: name
      });
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
      safeSend({
        type: "stopped_speaking",
        speaker: name
      });
    };

    recognitionRef.current.start();
  };


  const stopMic = () => {
    recognitionRef.current?.stop();
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