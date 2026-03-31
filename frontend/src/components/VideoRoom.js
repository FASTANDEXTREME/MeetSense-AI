import React from "react";
import useVisionAgent from "../hooks/useVisionAgent";

function VideoRoom() {
  const roomId = "12345";
  const clientId = "user1";

  const {
    engagement,
    faceDetected,
    confidence,
    connected,
    startCamera,
    stopCamera,
    videoRef,
  } = useVisionAgent(roomId, clientId);

  return (
    <div style={{ textAlign: "center", padding: "20px" }}>
      <h1>MeetSense AI - Vision Agent</h1>

      <video
        ref={videoRef}
        width="400"
        style={{ borderRadius: "12px", marginBottom: "10px" }}
      />

      <div>
        <button onClick={startCamera}>Start Vision</button>
        <button onClick={stopCamera} style={{ marginLeft: "10px" }}>
          Stop Vision
        </button>
      </div>

      <h2>WebSocket: {connected ? "Connected" : "Disconnected"}</h2>
      <h2>Engagement: {engagement}%</h2>
      <h3>{faceDetected ? "Face Detected" : "No Face Detected"}</h3>
      <h4>Confidence: {confidence}</h4>
    </div>
  );
}

export default VideoRoom;