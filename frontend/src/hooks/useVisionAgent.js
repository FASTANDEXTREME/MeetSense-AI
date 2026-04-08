import { useEffect, useRef, useState } from "react";

export default function useVisionAgent(roomId, clientId) {
  const [engagement, setEngagement] = useState(0);
  const [faceDetected, setFaceDetected] = useState(false);
  const [confidence, setConfidence] = useState(0);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const videoRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!roomId || !clientId) return;

    const wsHost = window.location.hostname || "localhost";
    wsRef.current = new WebSocket(
      `ws://${wsHost}:8000/ws/vision/${roomId}/${clientId}`
    );

    wsRef.current.onopen = () => {
      console.log("Vision WS connected");
      setConnected(true);
    };

    wsRef.current.onclose = () => {
      console.log("Vision WS disconnected");
      setConnected(false);
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "vision") {
        setEngagement(data.engagement_score);
        setFaceDetected(data.face_detected);
        setConfidence(data.confidence);
      }
    };

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [roomId, clientId]);

  const startCamera = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia is not supported or blocked by browser over HTTP.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      intervalRef.current = setInterval(() => {
        if (!videoRef.current || !wsRef.current) return;

        canvas.width = videoRef.current.videoWidth;
        canvas.height = videoRef.current.videoHeight;

        ctx.drawImage(videoRef.current, 0, 0);

        const imageData = canvas.toDataURL("image/jpeg");

        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(imageData);
        }
      }, 1000); // send frame every 1 second
    } catch (error) {
      console.error("Camera error:", error);
    }
  };

  const stopCamera = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject
        .getTracks()
        .forEach((track) => track.stop());
    }
  };

  return {
    engagement,
    faceDetected,
    confidence,
    connected,
    startCamera,
    stopCamera,
    videoRef,
  };
}