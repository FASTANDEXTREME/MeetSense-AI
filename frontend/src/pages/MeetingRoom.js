import React, { useMemo } from "react";
import useWebRTC from "../hooks/useWebRTC";
import useTranscript from "../hooks/useTranscript";
import useVisionAgent from "../hooks/useVisionAgent";

export default function MeetingRoom({ roomId, name, onLeave }) {

  // F1 fix: stable clientId across re-renders
  const clientId = useMemo(
    () => Math.random().toString(36).substring(2),
    []
  );

  const {
    localVideoRef,
    remotePeers,
    micMuted,
    cameraOff,
    toggleAudio,
    toggleVideo,
    mediaError,
  } = useWebRTC(roomId, clientId, name);

  const {
    transcript,
    summary,
    startMic,
    stopMic,
    requestSummary,
    activeSpeakers,
    talkTime,
    socketReady,
    isRecording,
    speechError,
  } = useTranscript(roomId, name);

  const {
    engagement,
    faceDetected,
    lookingForward,
    confidence,
    connected: visionConnected,
    visionEnabled,
    toggleVision,
  } = useVisionAgent(roomId, clientId, localVideoRef);

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
    warning: "#F59E0B",
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

  const isLocalSpeaking = activeSpeakers.includes(name);

  const attentionLabel = !visionEnabled
    ? "Paused"
    : !visionConnected
    ? "Connecting..."
    : !faceDetected
    ? "No Face Detected"
    : lookingForward
    ? "Attentive"
    : "Looking Away";

  const attentionColor = !visionEnabled || !visionConnected
    ? t.textSecondary
    : !faceDetected
    ? t.danger
    : lookingForward
    ? t.success
    : t.warning;

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

        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px"
        }}>
          <h2 style={{
            fontSize: "18px",
            fontWeight: 600,
            letterSpacing: "-0.3px",
            color: t.textPrimary
          }}>
            Room: <span style={{ color: t.accent }}>{roomId}</span>
          </h2>

          {onLeave && (
            <button
              onClick={() => {
                if (isRecording) stopMic();
                onLeave();
              }}
              style={{
                padding: "8px 16px",
                background: "rgba(225, 29, 72, 0.14)",
                border: "1px solid rgba(225, 29, 72, 0.35)",
                borderRadius: t.radiusSm,
                color: "#FB7185",
                fontWeight: 600,
                fontSize: "12px",
                fontFamily: t.font,
                cursor: "pointer",
                transition: t.transition
              }}
            >
              Leave Room
            </button>
          )}
        </div>

        {(mediaError || speechError) && (
          <div style={{
            marginBottom: "16px",
            padding: "10px 14px",
            background: "rgba(225, 29, 72, 0.12)",
            border: "1px solid rgba(225, 29, 72, 0.3)",
            borderRadius: t.radiusSm,
            color: "#FDA4AF",
            fontSize: "13px"
          }}>
            {mediaError || speechError}
          </div>
        )}

        {/* VIDEO GRID */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, 250px)",
          gap: "16px",
          marginBottom: "24px"
        }}>

          {/* LOCAL VIDEO TILE */}
          <div style={{ position: "relative", width: "250px" }}>
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              style={{
                width: "250px",
                height: "188px",
                objectFit: "cover",
                borderRadius: "14px",
                border: isLocalSpeaking
                  ? `2px solid ${t.success}`
                  : "1px solid rgba(255, 255, 255, 0.08)",
                background: "#111827",
                display: "block",
                transition: t.transition
              }}
            />
            <span style={{
              position: "absolute",
              bottom: "8px",
              left: "8px",
              padding: "3px 8px",
              borderRadius: "6px",
              background: "rgba(2, 6, 23, 0.72)",
              fontSize: "11px",
              fontWeight: 500,
              color: t.textPrimary
            }}>
              {name} (You){micMuted ? " · Muted" : ""}
            </span>
          </div>

          {/* REMOTE VIDEO TILES */}
          {remotePeers.map((peer) => {
            const isPeerSpeaking = activeSpeakers.includes(peer.name);
            return (
              <div key={peer.clientId} style={{ position: "relative", width: "250px" }}>
                <video
                  autoPlay
                  playsInline
                  ref={(video) => {
                    if (video && video.srcObject !== peer.stream) {
                      video.srcObject = peer.stream;
                    }
                  }}
                  style={{
                    width: "250px",
                    height: "188px",
                    objectFit: "cover",
                    borderRadius: "14px",
                    border: isPeerSpeaking
                      ? `2px solid ${t.success}`
                      : "1px solid rgba(255, 255, 255, 0.08)",
                    background: "#111827",
                    display: "block",
                    transition: t.transition
                  }}
                />
                <span style={{
                  position: "absolute",
                  bottom: "8px",
                  left: "8px",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  background: "rgba(2, 6, 23, 0.72)",
                  fontSize: "11px",
                  fontWeight: 500,
                  color: t.textPrimary
                }}>
                  {peer.name}
                </span>
              </div>
            );
          })}
        </div>

        {/* CONTROLS */}
        <div style={{ marginBottom: "24px", display: "flex", flexWrap: "wrap", gap: "10px" }}>
          <button
            onClick={startMic}
            disabled={!socketReady || isRecording}
            style={{
              padding: "10px 20px",
              background: isRecording ? t.success : t.accent,
              opacity: !socketReady ? 0.55 : 1,
              border: "none",
              borderRadius: t.radiusSm,
              color: "white",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: !socketReady || isRecording ? "default" : "pointer",
              transition: t.transition
            }}
          >
            {isRecording ? "🎙️ Transcribing..." : "🎤 Start Speaking"}
          </button>

          <button
            onClick={stopMic}
            disabled={!isRecording}
            style={{
              padding: "10px 20px",
              background: t.danger,
              opacity: !isRecording ? 0.5 : 1,
              border: "none",
              borderRadius: t.radiusSm,
              color: "white",
              fontWeight: 600,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: !isRecording ? "default" : "pointer",
              transition: t.transition
            }}
          >
            ⛔ Stop
          </button>

          <button
            onClick={toggleAudio}
            style={{
              padding: "10px 16px",
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: t.radiusSm,
              color: t.textPrimary,
              fontWeight: 500,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition
            }}
          >
            {micMuted ? "🔇 Unmute Audio" : "🔊 Mute Audio"}
          </button>

          <button
            onClick={toggleVideo}
            style={{
              padding: "10px 16px",
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: t.radiusSm,
              color: t.textPrimary,
              fontWeight: 500,
              fontSize: "13px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition
            }}
          >
            {cameraOff ? "📷 Turn Camera On" : "📹 Turn Camera Off"}
          </button>

          <button
            onClick={requestSummary}
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

          {transcript.length === 0 && (
            <p style={{ color: t.textSecondary, fontSize: "13px", fontStyle: "italic" }}>
              Click "Start Speaking" to stream live captions to the room...
            </p>
          )}

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

          {Object.keys(talkTime).length === 0 && (
            <p style={{ color: t.textSecondary, fontSize: "13px", fontStyle: "italic" }}>
              Speaking time updates when a speaker finishes a turn.
            </p>
          )}

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

      {/* RIGHT SIDEBAR: ENGAGEMENT + SUMMARY */}
      <div style={{
        flex: 1,
        background: t.surface,
        borderLeft: "1px solid rgba(255, 255, 255, 0.06)",
        color: t.textPrimary,
        padding: "24px",
        overflowY: "auto"
      }}>

        {/* ENGAGEMENT CARD */}
        <div style={{
          marginBottom: "24px",
          padding: "16px",
          background: "rgba(255, 255, 255, 0.04)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: t.radius
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px"
          }}>
            <h2 style={{
              fontSize: "14px",
              fontWeight: 600,
              color: t.textPrimary
            }}>Engagement Analytics</h2>
            <button
              onClick={toggleVision}
              style={{
                padding: "4px 10px",
                background: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.12)",
                borderRadius: "6px",
                color: t.textSecondary,
                fontSize: "11px",
                cursor: "pointer"
              }}
            >
              {visionEnabled ? "Pause" : "Resume"}
            </button>
          </div>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: "8px"
          }}>
            <span style={{ fontSize: "24px", fontWeight: 700, color: t.textPrimary }}>
              {engagement}%
            </span>
            <span style={{ fontSize: "12px", fontWeight: 600, color: attentionColor }}>
              ● {attentionLabel}
            </span>
          </div>

          <div style={{
            width: "100%",
            height: "6px",
            borderRadius: "3px",
            background: "rgba(255, 255, 255, 0.08)",
            overflow: "hidden",
            marginBottom: "8px"
          }}>
            <div style={{
              width: `${Math.min(Math.max(engagement, 0), 100)}%`,
              height: "100%",
              background: t.accent,
              transition: "width 300ms ease"
            }} />
          </div>

          <p style={{ fontSize: "11px", color: t.textSecondary }}>
            Detection confidence: {(confidence * 100).toFixed(0)}%
          </p>
        </div>

        {/* MEETING SUMMARY */}
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
