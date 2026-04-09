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
      background: "linear-gradient(160deg, #020617 0%, #0B1120 100%)",
      fontFamily: "'Inter', sans-serif"
    }}>
      <div style={{
        background: "rgba(255, 255, 255, 0.04)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        padding: "48px 40px",
        borderRadius: "16px",
        width: "380px",
        textAlign: "center"
      }}>
        <h2 style={{
          color: "#E5E7EB",
          fontSize: "22px",
          fontWeight: 700,
          marginBottom: "8px",
          letterSpacing: "-0.3px"
        }}>MeetSense AI</h2>
        <p style={{
          color: "#9CA3AF",
          fontSize: "14px",
          fontWeight: 400,
          marginBottom: "32px"
        }}>Smart meeting assistant</p>

        <input
          id="room-id-input"
          placeholder="Room ID"
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            padding: "12px 14px",
            marginBottom: "14px",
            boxSizing: "border-box",
            background: "#0F172A",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: "10px",
            color: "#E5E7EB",
            fontSize: "14px",
            fontFamily: "'Inter', sans-serif",
            outline: "none",
            transition: "border-color 200ms ease"
          }}
          onFocus={(e) => { e.target.style.borderColor = "rgba(59, 130, 246, 0.6)"; }}
          onBlur={(e) => { e.target.style.borderColor = "rgba(255, 255, 255, 0.1)"; }}
        />

        <input
          id="name-input"
          placeholder="Your Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            padding: "12px 14px",
            marginBottom: "14px",
            boxSizing: "border-box",
            background: "#0F172A",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: "10px",
            color: "#E5E7EB",
            fontSize: "14px",
            fontFamily: "'Inter', sans-serif",
            outline: "none",
            transition: "border-color 200ms ease"
          }}
          onFocus={(e) => { e.target.style.borderColor = "rgba(59, 130, 246, 0.6)"; }}
          onBlur={(e) => { e.target.style.borderColor = "rgba(255, 255, 255, 0.1)"; }}
        />

        {error && (
          <p style={{
            color: "#E11D48",
            margin: "0 0 12px",
            fontSize: "13px",
            fontWeight: 500
          }}>
            {error}
          </p>
        )}

        <button
          id="join-button"
          onClick={handleJoin}
          style={{
            width: "100%",
            padding: "12px 20px",
            marginTop: "8px",
            background: "#3B82F6",
            color: "white",
            border: "none",
            borderRadius: "10px",
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "14px",
            fontFamily: "'Inter', sans-serif",
            transition: "background 200ms ease"
          }}
          onMouseEnter={(e) => { e.target.style.background = "#2563EB"; }}
          onMouseLeave={(e) => { e.target.style.background = "#3B82F6"; }}
        >
          Join Meeting
        </button>
      </div>
    </div>
  );
}