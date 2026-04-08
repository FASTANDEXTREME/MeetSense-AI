import React, { useMemo } from "react";
import useWebRTC from "../hooks/useWebRTC";
import useTranscript from "../hooks/useTranscript";

export default function MeetingRoom({ roomId, name }) {

  // F1 fix: stable clientId across re-renders
  const clientId = useMemo(
    () => Math.random().toString(36).substring(2),
    []
  );

  const { localVideoRef, remoteStreams } =
    useWebRTC(roomId, clientId);

  const {
    transcript,
    summary,
    startMic,
    stopMic,
    activeSpeaker,
    talkTime
  } = useTranscript(roomId, name);

  return (
    <div style={{
      display: "flex",
      height: "100vh",
      background: "linear-gradient(135deg, #667eea, #764ba2)",
      fontFamily: "sans-serif",
      color: "white"
    }}>

      {/* LEFT SIDE */}
      <div style={{ flex: 3, padding: "20px", overflowY: "auto" }}>

        <h2>🎥 MeetSense AI Room: {roomId}</h2>

        {/* VIDEO GRID */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, 250px)",
          gap: "15px",
          marginBottom: "20px"
        }}>

          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{
              width: "250px",
              borderRadius: "15px",
              border:
                activeSpeaker === name
                  ? "4px solid #00ff88"
                  : "3px solid white",
              boxShadow:
                activeSpeaker === name
                  ? "0 0 20px #00ff88"
                  : "none"
            }}
          />

          {remoteStreams.map((stream, i) => (
            <video
              key={stream.id || i}
              autoPlay
              playsInline
              ref={(video) => {
                if (video && video.srcObject !== stream) {
                  video.srcObject = stream;
                }
              }}
              style={{
                width: "250px",
                borderRadius: "15px",
                border: "3px solid white"
              }}
            />
          ))}
        </div>

        {/* MIC BUTTONS */}
        <div style={{ marginBottom: "15px" }}>
          <button onClick={startMic}
            style={{
              padding: "10px 20px",
              marginRight: "10px",
              background: "#00c9a7",
              border: "none",
              borderRadius: "8px",
              color: "white",
              fontWeight: "bold",
              cursor: "pointer"
            }}>
            🎤 Start Speaking
          </button>

          <button onClick={stopMic}
            style={{
              padding: "10px 20px",
              background: "#ff6b6b",
              border: "none",
              borderRadius: "8px",
              color: "white",
              fontWeight: "bold",
              cursor: "pointer"
            }}>
            ⛔ Stop
          </button>
        </div>

        {/* TRANSCRIPT */}
        <div style={{
          background: "rgba(255,255,255,0.1)",
          padding: "15px",
          borderRadius: "10px",
          height: "200px",
          overflowY: "auto"
        }}>
          <h3>📝 Live Transcript</h3>

          {transcript.map((t, i) => (
            <div key={i}
              style={{
                marginBottom: "5px",
                padding: "5px",
                background: "rgba(255,255,255,0.1)",
                borderRadius: "6px"
              }}>
              <strong>{t.speaker}:</strong> {t.text}
            </div>
          ))}
        </div>

        {/* TALK TIME */}
        <div style={{
          marginTop: "15px",
          background: "rgba(255,255,255,0.1)",
          padding: "10px",
          borderRadius: "10px"
        }}>
          <h3>📊 Speaking Analytics</h3>

          {Object.entries(talkTime).map(([user, time]) => (
            <div key={user}>
              {user}: {(time / 60).toFixed(2)} mins
            </div>
          ))}
        </div>

      </div>

      {/* RIGHT SIDE SUMMARY */}
      <div style={{
        flex: 1,
        background: "white",
        color: "#333",
        padding: "20px",
        overflowY: "auto"
      }}>

        <h2 style={{ color: "#4f46e5" }}>📊 Meeting Summary</h2>

        {!summary && <p>No summary yet...</p>}

        {summary && !summary.error && (
          <>
            <h3>👥 Speakers</h3>
            {summary.speakers &&
              Object.entries(summary.speakers).map(([speakerName, data]) => (
                <div key={speakerName}
                  style={{
                    marginBottom: "10px",
                    padding: "10px",
                    background: "#f3f4f6",
                    borderRadius: "8px"
                  }}>
                  <strong>{speakerName}</strong>

                  <h4 style={{ margin: "8px 0 4px", fontSize: "14px" }}>Key Points</h4>
                  <ul>
                    {data.key_points?.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>

                  {/* F6 fix: action_items live per-speaker, not top-level */}
                  <h4 style={{ margin: "8px 0 4px", fontSize: "14px" }}>Action Items</h4>
                  <ul>
                    {data.action_items?.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))
            }

            <h3>📌 Decisions</h3>
            <ul>
              {summary.decisions?.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>

            <h3>😊 Sentiment</h3>
            <p>{summary.sentiment}</p>
          </>
        )}

        {summary && summary.error && (
          <p style={{ color: "#ef4444" }}>
            Summary error: {summary.error}
          </p>
        )}
      </div>
    </div>
  );
}