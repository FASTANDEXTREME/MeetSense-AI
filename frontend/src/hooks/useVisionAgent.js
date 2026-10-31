import { useEffect, useRef, useState, useCallback } from "react";
import { buildWsUrl } from "../utils/wsUrl";

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_RECONNECT_DELAY_MS = 1000;
const CAPTURE_INTERVAL_MS = 2000;

export default function useVisionAgent(roomId, clientId, externalVideoRef = null) {
  const [engagement, setEngagement] = useState(0);
  const [faceDetected, setFaceDetected] = useState(false);
  const [lookingForward, setLookingForward] = useState(false);
  const [confidence, setConfidence] = useState(0);
  const [connected, setConnected] = useState(false);
  const [visionEnabled, setVisionEnabled] = useState(true);

  const wsRef = useRef(null);
  const internalVideoRef = useRef(null);
  const activeVideoRef = externalVideoRef || internalVideoRef;

  const unmountedRef = useRef(false);
  const connectDelayRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const connectRef = useRef(null);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
      return;
    }
    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current += 1;
      connectRef.current?.();
    }, delay);
  }, []);

  const connectWebSocket = useCallback(() => {
    if (!roomId || !clientId || unmountedRef.current) return;

    connectDelayRef.current = setTimeout(() => {
      if (unmountedRef.current) return;

      const url = buildWsUrl(
        `/ws/vision/${encodeURIComponent(roomId)}/${encodeURIComponent(clientId)}`
      );
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectAttemptRef.current = 0;
      };

      ws.onclose = () => {
        setConnected(false);
        if (!unmountedRef.current) {
          scheduleReconnect();
        }
      };

      ws.onerror = (err) => {
        console.error("Vision WebSocket error:", err);
      };

      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.type === "vision") {
          setEngagement(data.engagement_score ?? 0);
          setFaceDetected(Boolean(data.face_detected));
          setLookingForward(Boolean(data.looking_forward));
          setConfidence(data.confidence ?? 0);
        }
      };
    }, 100);
  }, [roomId, clientId, scheduleReconnect]);

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
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWebSocket]);

  // Periodically sample frames from the shared WebRTC video element
  useEffect(() => {
    if (!visionEnabled || !connected) return;
    if (typeof document === "undefined") return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const intervalId = setInterval(() => {
      const videoEl = activeVideoRef.current;
      const ws = wsRef.current;

      if (
        !videoEl ||
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        videoEl.readyState < 2 ||
        videoEl.videoWidth === 0 ||
        videoEl.videoHeight === 0
      ) {
        return;
      }

      const isPortrait = videoEl.videoHeight > videoEl.videoWidth;
      const targetW = isPortrait ? 240 : 320;
      const targetH = isPortrait ? 320 : 240;
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.drawImage(videoEl, 0, 0, targetW, targetH);
      const imageData = canvas.toDataURL("image/jpeg", 0.7);
      ws.send(imageData);
    }, CAPTURE_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [visionEnabled, connected, activeVideoRef]);

  const toggleVision = useCallback(() => {
    setVisionEnabled((prev) => !prev);
  }, []);

  return {
    engagement,
    faceDetected,
    lookingForward,
    confidence,
    connected,
    visionEnabled,
    toggleVision,
    videoRef: activeVideoRef,
  };
}
