import React, { useState } from "react";

export default function JoinPage({ onJoin }) {
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleJoin = () => {
    const trimmedRoom = roomId.trim();
    const trimmedName = name.trim();

    if (!trimmedRoom) {
      setError("Please enter a Room ID.");
      return;
    }
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }

    setError("");
    onJoin(trimmedRoom, trimmedName);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      handleJoin();
    }
  };

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
        textAlign: "center",
        boxShadow: "0 10px 30px rgba(0,0,0,0.1)"
      }}>
        <h2>🎥 MeetSense-AI</h2>

        <input
          id="room-id-input"
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ width: "100%", padding: "10px", marginBottom: "15px", boxSizing: "border-box" }}
        />

        <input
          id="name-input"
          placeholder="Your Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{ width: "100%", padding: "10px", marginBottom: "15px", boxSizing: "border-box" }}
        />

        {error && (
          <p style={{ color: "#ef4444", margin: "0 0 10px", fontSize: "14px" }}>
            {error}
          </p>
        )}

        <button
          id="join-button"
          onClick={handleJoin}
          style={{
            padding: "10px 20px",
            background: "#4f46e5",
            color: "white",
            border: "none",
            borderRadius: "8px",
            cursor: "pointer",
            fontWeight: "bold"
          }}
        >
          Join Meeting
        </button>
      </div>
    </div>
  );
}