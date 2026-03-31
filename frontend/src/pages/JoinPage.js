import React, { useState } from "react";

export default function JoinPage({ onJoin }) {
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      background: "#f5f6fa"
    }}>
      <div style={{
        background: "white",
        padding: "40px",
        borderRadius: "15px",
        width: "350px",
        textAlign: "center"
      }}>
        <h2>🎥 MeetSense-AI</h2>

        <input
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          style={{ width: "100%", padding: "10px", marginBottom: "15px" }}
        />

        <input
          placeholder="Your Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: "100%", padding: "10px", marginBottom: "15px" }}
        />

        <button
          onClick={() => onJoin(roomId, name)}
          style={{
            padding: "10px 20px",
            background: "#4f46e5",
            color: "white",
            border: "none",
            borderRadius: "8px"
          }}
        >
          Join Meeting
        </button>
      </div>
    </div>
  );
}