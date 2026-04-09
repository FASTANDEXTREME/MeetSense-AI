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
    requestSummary,
    activeSpeaker,
    talkTime
  } = useTranscript(roomId, name);

  /* ── Design Tokens ── */
  const t = {
    bg: "linear-gradient(160deg, #020617 0%, #0B1120 100%)",
    surface: "#0F172A",
    glass: "rgba(255, 255, 255, 0.04)",
    glassBorder: "1px solid rgba(255, 255, 255, 0.08)",
    blur: "blur(12px)",
    textPrimary: "#E5E7EB",
    textSecondary: "#9CA3AF",
    accent: "#3B82F6",
    accentHover: "#2563EB",
    success: "#22C55E",
    danger: "#E11D48",
    dangerHover: "#BE123C",
    radius: "12px",
    radiusSm: "8px",
    font: "'Inter', sans-serif",
    transition: "all 200ms ease",
  };

  /* ── Shared Styles ── */
  const glassCard = {
    background: t.glass,
    backdropFilter: t.blur,
    WebkitBackdropFilter: t.blur,
    border: t.glassBorder,
    borderRadius: t.radius,
  };

  return (
    <div style={{
      display: "flex",
      height: "100vh",
      background: t.bg,
      fontFamily: t.font,
      color: t.textPrimary
    }}>

      {/* LEFT SIDE */}
      <div style={{ flex: 3, padding: "24px", overflowY: "auto" }}>

        <h2 style={{
          fontSize: "18px",
          fontWeight: 600,
          marginBottom: "20px",
          letterSpacing: "-0.3px",
          color: t.textPrimary
        }}>
          Room: <span style={{ color: t.accent }}>{roomId}</span>
        </h2>

        {/* VIDEO GRID */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, 250px)",
          gap: "16px",
          marginBottom: "24px"
        }}>

          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            style={{
              width: "250px",
              borderRadius: "14px",
              border:
                activeSpeaker === name
                  ? `2px solid ${t.success}`
                  : "1px solid rgba(255, 255, 255, 0.08)",
              boxShadow: "none",
              background: "#111827",
              transition: t.transition
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
                borderRadius: "14px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                background: "#111827",
                transition: t.transition
              }}
            />
          ))}
        </div>

        {/* MIC BUTTONS */}
        <div style={{ marginBottom: "24px", display: "flex", gap: "10px" }}>
          <button onClick={startMic}
            style={{
              padding: "10px 20px",
              background: t.accent,
              border: "none",
              borderRadius: t.radiusSm,
              color: "white",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition
            }}
            onMouseEnter={(e) => { e.target.style.background = t.accentHover; }}
            onMouseLeave={(e) => { e.target.style.background = t.accent; }}
          >
            🎤 Start Speaking
          </button>

          <button onClick={stopMic}
            style={{
              padding: "10px 20px",
              background: t.danger,
              border: "none",
              borderRadius: t.radiusSm,
              color: "white",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition
            }}
            onMouseEnter={(e) => { e.target.style.background = t.dangerHover; }}
            onMouseLeave={(e) => { e.target.style.background = t.danger; }}
          >
            ⛔ Stop
          </button>

          <button onClick={requestSummary}
            style={{
              padding: "10px 20px",
              background: "rgba(59, 130, 246, 0.12)",
              border: "1px solid rgba(59, 130, 246, 0.25)",
              borderRadius: t.radiusSm,
              color: "#60A5FA",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition
            }}
            onMouseEnter={(e) => {
              e.target.style.background = "rgba(59, 130, 246, 0.2)";
              e.target.style.borderColor = "rgba(59, 130, 246, 0.4)";
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "rgba(59, 130, 246, 0.12)";
              e.target.style.borderColor = "rgba(59, 130, 246, 0.25)";
            }}
          >
            📊 Generate Summary
          </button>
        </div>

        {/* TRANSCRIPT */}
        <div style={{
          ...glassCard,
          padding: "20px",
          height: "220px",
          overflowY: "auto"
        }}>
          <h3 style={{
            fontSize: "13px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: t.textSecondary,
            marginBottom: "14px"
          }}>Live Transcript</h3>

          {transcript.map((t2, i) => (
            <div key={i}
              style={{
                marginBottom: "8px",
                padding: "10px 12px",
                background: "rgba(255, 255, 255, 0.03)",
                borderRadius: "8px",
                fontSize: "13px",
                lineHeight: "1.5"
              }}>
              <strong style={{ color: t.textPrimary, fontWeight: 600 }}>{t2.speaker}:</strong>{" "}
              <span style={{ color: t.textSecondary, fontWeight: 400 }}>{t2.text}</span>
            </div>
          ))}
        </div>

        {/* TALK TIME */}
        <div style={{
          ...glassCard,
          marginTop: "16px",
          padding: "20px"
        }}>
          <h3 style={{
            fontSize: "13px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: t.textSecondary,
            marginBottom: "14px"
          }}>Speaking Analytics</h3>

          {Object.entries(talkTime).map(([user, time]) => (
            <div key={user} style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "8px 0",
              fontSize: "13px",
              borderBottom: "1px solid rgba(255, 255, 255, 0.05)"
            }}>
              <span style={{ color: t.textPrimary, fontWeight: 500 }}>{user}</span>
              <span style={{ color: t.textSecondary }}>{(time / 60).toFixed(2)} mins</span>
            </div>
          ))}
        </div>

      </div>

      {/* RIGHT SIDE SUMMARY */}
      <div style={{
        flex: 1,
        background: t.surface,
        borderLeft: "1px solid rgba(255, 255, 255, 0.06)",
        color: t.textPrimary,
        padding: "24px",
        overflowY: "auto"
      }}>

        <h2 style={{
          color: t.textPrimary,
          fontSize: "16px",
          fontWeight: 600,
          marginBottom: "20px",
          letterSpacing: "-0.2px"
        }}>Meeting Summary</h2>

        {!summary && <p style={{
          color: t.textSecondary,
          fontSize: "13px",
          fontStyle: "italic"
        }}>No summary yet...</p>}

        {summary && !summary.error && (
          <>
            <h3 style={{
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              color: t.textSecondary,
              marginBottom: "12px"
            }}>Speakers</h3>
            {summary.speakers &&
              Object.entries(summary.speakers).map(([speakerName, data]) => (
                <div key={speakerName}
                  style={{
                    marginBottom: "12px",
                    padding: "14px",
                    background: "rgba(255, 255, 255, 0.04)",
                    border: "1px solid rgba(255, 255, 255, 0.06)",
                    borderRadius: t.radius
                  }}>
                  <strong style={{
                    color: t.textPrimary,
                    fontSize: "14px",
                    fontWeight: 600
                  }}>{speakerName}</strong>

                  <h4 style={{
                    margin: "12px 0 6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    color: t.accent
                  }}>Key Points</h4>
                  <ul style={{
                    paddingLeft: "16px",
                    margin: 0
                  }}>
                    {data.key_points?.map((point, i) => (
                      <li key={i} style={{
                        fontSize: "13px",
                        color: t.textSecondary,
                        marginBottom: "4px",
                        lineHeight: "1.5"
                      }}>{point}</li>
                    ))}
                  </ul>

                  {/* F6 fix: action_items live per-speaker, not top-level */}
                  <h4 style={{
                    margin: "12px 0 6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    color: t.accent
                  }}>Action Items</h4>
                  <ul style={{
                    paddingLeft: "16px",
                    margin: 0
                  }}>
                    {data.action_items?.map((item, i) => (
                      <li key={i} style={{
                        fontSize: "13px",
                        color: t.textSecondary,
                        marginBottom: "4px",
                        lineHeight: "1.5"
                      }}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))
            }

            <h3 style={{
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              color: t.textSecondary,
              marginTop: "20px",
              marginBottom: "10px"
            }}>Decisions</h3>
            <ul style={{
              paddingLeft: "16px",
              margin: 0
            }}>
              {summary.decisions?.map((d, i) => (
                <li key={i} style={{
                  fontSize: "13px",
                  color: t.textSecondary,
                  marginBottom: "4px",
                  lineHeight: "1.5"
                }}>{d}</li>
              ))}
            </ul>

            <h3 style={{
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              color: t.textSecondary,
              marginTop: "20px",
              marginBottom: "10px"
            }}>Sentiment</h3>
            <p style={{
              fontSize: "13px",
              color: t.textSecondary,
              lineHeight: "1.5"
            }}>{summary.sentiment}</p>
          </>
        )}

        {summary && summary.error && (
          <p style={{
            color: t.danger,
            fontSize: "13px",
            fontWeight: 500
          }}>
            Summary error: {summary.error}
          </p>
        )}
      </div>
    </div>
  );
}