import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useWebRTC from "../hooks/useWebRTC";
import useTranscript from "../hooks/useTranscript";
import useVisionAgent from "../hooks/useVisionAgent";

function getInitial(label) {
  const trimmed = (label || "P").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "P";
}

function RemoteVideoTile({ peer, isSpeaking, tokens }) {
  const videoRef = useRef(null);
  const [hasLiveVideo, setHasLiveVideo] = useState(false);
  const [autoplayMuted, setAutoplayMuted] = useState(false);

  const tryPlay = useCallback(async (el) => {
    if (!el) return;
    try {
      await el.play();
    } catch {
      // Mobile browsers block unmuted autoplay outside a direct gesture;
      // mute temporarily so the video stream renders immediately, then unlock on tap.
      try {
        el.muted = true;
        setAutoplayMuted(true);
        await el.play();
      } catch {
        // ignore if element unmounted
      }
    }
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !peer.stream) {
      setHasLiveVideo(false);
      return;
    }

    if (el.srcObject !== peer.stream) {
      el.srcObject = peer.stream;
    }

    const checkVideoReady = () => {
      const hasVideoTrack = peer.stream
        .getVideoTracks()
        .some((tr) => tr.readyState === "live" && tr.enabled);
      setHasLiveVideo(Boolean(hasVideoTrack && el.videoWidth > 0));
    };

    tryPlay(el).then(checkVideoReady);

    el.addEventListener("loadeddata", checkVideoReady);
    el.addEventListener("playing", checkVideoReady);
    el.addEventListener("resize", checkVideoReady);

    const pollId = setInterval(checkVideoReady, 750);

    return () => {
      clearInterval(pollId);
      el.removeEventListener("loadeddata", checkVideoReady);
      el.removeEventListener("playing", checkVideoReady);
      el.removeEventListener("resize", checkVideoReady);
    };
  }, [peer.stream, peer.trackRev, tryPlay]);

  useEffect(() => {
    if (!autoplayMuted) return;
    const unlockAudio = () => {
      const el = videoRef.current;
      if (el) {
        el.muted = false;
        el.play?.().catch(() => {});
      }
      setAutoplayMuted(false);
    };
    document.addEventListener("pointerdown", unlockAudio, { once: true });
    document.addEventListener("touchstart", unlockAudio, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlockAudio);
      document.removeEventListener("touchstart", unlockAudio);
    };
  }, [autoplayMuted]);

  const showNativeVideo = !peer.cameraOff && hasLiveVideo;
  const showFallbackImage = !peer.cameraOff && !hasLiveVideo && Boolean(peer.fallbackFrame);
  const showPlaceholder = peer.cameraOff || (!showNativeVideo && !showFallbackImage);

  return (
    <div
      className="ms-video-tile"
      style={{
        border: isSpeaking
          ? `2px solid ${tokens.success}`
          : "1px solid rgba(255, 255, 255, 0.08)",
        transition: tokens.transition,
      }}
    >
      {/* Keep <video> mounted at all times so WebRTC audio plays even if camera is off */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
          opacity: showNativeVideo ? 1 : 0,
          position: showNativeVideo ? "relative" : "absolute",
          inset: 0,
          pointerEvents: showNativeVideo ? "auto" : "none",
        }}
      />

      {showFallbackImage && (
        <img
          src={peer.fallbackFrame}
          alt={peer.name}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}

      {showPlaceholder && (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            background: "radial-gradient(circle at center, #1E293B 0%, #0F172A 100%)",
          }}
        >
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "50%",
              background: "rgba(59, 130, 246, 0.18)",
              border: "1px solid rgba(59, 130, 246, 0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "18px",
              fontWeight: 700,
              color: tokens.textPrimary,
            }}
          >
            {getInitial(peer.name)}
          </div>
          <span style={{ fontSize: "11px", color: tokens.textSecondary }}>
            {peer.cameraOff ? "Camera off" : "Connecting stream..."}
          </span>
        </div>
      )}

      {autoplayMuted && (
        <button
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.muted = false;
              videoRef.current.play?.().catch(() => {});
            }
            setAutoplayMuted(false);
          }}
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            padding: "4px 8px",
            borderRadius: "6px",
            background: "rgba(245, 158, 11, 0.9)",
            border: "none",
            color: "#020617",
            fontSize: "11px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Tap for audio
        </button>
      )}

      <span
        style={{
          position: "absolute",
          bottom: "8px",
          left: "8px",
          maxWidth: "calc(100% - 16px)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          padding: "3px 8px",
          borderRadius: "6px",
          background: "rgba(2, 6, 23, 0.72)",
          fontSize: "11px",
          fontWeight: 500,
          color: tokens.textPrimary,
        }}
      >
        {peer.name}{peer.micMuted ? " · Muted" : ""}
      </span>
    </div>
  );
}

export default function MeetingRoom({ roomId, name, onLeave }) {
  // Stable per-tab clientId so mobile pull-to-refresh or network handoff replaces
  // the tab's previous connection instead of spawning duplicate ghost tiles.
  const clientId = useMemo(() => {
    try {
      const storageKey = `meetsense_cid_${roomId}`;
      const existing = window.sessionStorage.getItem(storageKey);
      if (existing) return existing;
      const generated = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
      window.sessionStorage.setItem(storageKey, generated);
      return generated;
    } catch {
      return Math.random().toString(36).substring(2);
    }
  }, [roomId]);

  const {
    localVideoRef,
    localStreamRef,
    remotePeers,
    micMuted,
    cameraOff,
    mediaReady,
    toggleAudio,
    toggleVideo,
    mediaError,
  } = useWebRTC(roomId, clientId, name);

  const {
    transcript,
    summary,
    requestSummary,
    activeSpeakers,
    talkTime,
    socketReady,
    speechError,
  } = useTranscript(roomId, name, localStreamRef, mediaReady && !micMuted);

  const {
    engagement,
    faceDetected,
    lookingForward,
    confidence,
    connected: visionConnected,
    visionEnabled,
    toggleVision,
  } = useVisionAgent(roomId, clientId, localVideoRef);

  const transcriptBoxRef = useRef(null);

  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript]);

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
  const isSingleParticipant = remotePeers.length === 0;

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
    <div
      className="ms-room-layout"
      style={{
        background: t.bg,
        fontFamily: t.font,
        color: t.textPrimary,
      }}
    >
      {/* MAIN PANEL */}
      <div className="ms-main-panel">
        <div className="ms-room-header">
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            <h2 style={{
              fontSize: "18px",
              fontWeight: 600,
              letterSpacing: "-0.3px",
              color: t.textPrimary,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              Room: <span style={{ color: t.accent }}>{roomId}</span>
            </h2>
            <span style={{
              padding: "3px 9px",
              borderRadius: "999px",
              background: "rgba(34, 197, 94, 0.14)",
              border: "1px solid rgba(34, 197, 94, 0.32)",
              color: "#86EFAC",
              fontSize: "11px",
              fontWeight: 600,
              flexShrink: 0,
            }}>
              ● {1 + remotePeers.length} online
            </span>
          </div>

          {onLeave && (
            <button
              onClick={() => {
                try {
                  window.sessionStorage.removeItem(`meetsense_cid_${roomId}`);
                } catch {
                  // ignore
                }
                onLeave();
              }}
              style={{
                padding: "8px 14px",
                background: "rgba(225, 29, 72, 0.14)",
                border: "1px solid rgba(225, 29, 72, 0.35)",
                borderRadius: t.radiusSm,
                color: "#FB7185",
                fontWeight: 600,
                fontSize: "12px",
                fontFamily: t.font,
                cursor: "pointer",
                flexShrink: 0,
                transition: t.transition,
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
            fontSize: "13px",
          }}>
            {mediaError || speechError}
          </div>
        )}

        {/* VIDEO GRID */}
        <div
          className="ms-video-grid"
          data-single={isSingleParticipant ? "true" : "false"}
        >
          {/* LOCAL VIDEO TILE */}
          <div
            className="ms-video-tile"
            style={{
              border: isLocalSpeaking
                ? `2px solid ${t.success}`
                : "1px solid rgba(255, 255, 255, 0.08)",
              transition: t.transition,
            }}
          >
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: cameraOff ? "none" : "block",
                transform: "scaleX(-1)",
              }}
            />

            {cameraOff && (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  background: "radial-gradient(circle at center, #1E293B 0%, #0F172A 100%)",
                }}
              >
                <div
                  style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    background: "rgba(59, 130, 246, 0.18)",
                    border: "1px solid rgba(59, 130, 246, 0.4)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "18px",
                    fontWeight: 700,
                    color: t.textPrimary,
                  }}
                >
                  {getInitial(name)}
                </div>
                <span style={{ fontSize: "11px", color: t.textSecondary }}>
                  Camera off
                </span>
              </div>
            )}

            <span style={{
              position: "absolute",
              bottom: "8px",
              left: "8px",
              maxWidth: "calc(100% - 16px)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              padding: "3px 8px",
              borderRadius: "6px",
              background: "rgba(2, 6, 23, 0.72)",
              fontSize: "11px",
              fontWeight: 500,
              color: t.textPrimary,
            }}>
              {name} (You){micMuted ? " · Muted" : ""}
            </span>
          </div>

          {/* REMOTE VIDEO TILES */}
          {remotePeers.map((peer) => (
            <RemoteVideoTile
              key={peer.clientId}
              peer={peer}
              isSpeaking={activeSpeakers.includes(peer.name)}
              tokens={t}
            />
          ))}
        </div>

        {/* CONTROLS */}
        <div className="ms-controls">
          <button
            className="ms-control-btn"
            onClick={toggleAudio}
            style={{
              padding: "10px 18px",
              background: micMuted
                ? "rgba(225, 29, 72, 0.16)"
                : "rgba(34, 197, 94, 0.16)",
              border: micMuted
                ? "1px solid rgba(225, 29, 72, 0.4)"
                : "1px solid rgba(34, 197, 94, 0.4)",
              borderRadius: t.radiusSm,
              color: micMuted ? "#FDA4AF" : "#86EFAC",
              fontWeight: 600,
              fontSize: "14px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition,
            }}
          >
            {micMuted ? "Mic Off" : "Mic On"}
          </button>

          <button
            className="ms-control-btn"
            onClick={toggleVideo}
            style={{
              padding: "10px 18px",
              background: cameraOff
                ? "rgba(225, 29, 72, 0.16)"
                : "rgba(34, 197, 94, 0.16)",
              border: cameraOff
                ? "1px solid rgba(225, 29, 72, 0.4)"
                : "1px solid rgba(34, 197, 94, 0.4)",
              borderRadius: t.radiusSm,
              color: cameraOff ? "#FDA4AF" : "#86EFAC",
              fontWeight: 600,
              fontSize: "14px",
              fontFamily: t.font,
              cursor: "pointer",
              transition: t.transition,
            }}
          >
            {cameraOff ? "Camera Off" : "Camera On"}
          </button>

          <button
            className="ms-control-btn ms-control-btn-wide"
            onClick={requestSummary}
            disabled={!socketReady}
            style={{
              padding: "10px 20px",
              background: "rgba(59, 130, 246, 0.14)",
              opacity: !socketReady ? 0.55 : 1,
              border: "1px solid rgba(59, 130, 246, 0.35)",
              borderRadius: t.radiusSm,
              color: "#93C5FD",
              fontWeight: 600,
              fontSize: "14px",
              fontFamily: t.font,
              cursor: !socketReady ? "default" : "pointer",
              transition: t.transition,
            }}
          >
            Generate Summary
          </button>
        </div>

        {/* TRANSCRIPT */}
        <div
          ref={transcriptBoxRef}
          className="ms-transcript-box"
          style={{
            ...glassCard,
            padding: "20px",
          }}
        >
          <h3 style={{
            fontSize: "13px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: t.textSecondary,
            marginBottom: "14px",
          }}>Live Transcript</h3>

          {transcript.length === 0 && (
            <p style={{ color: t.textSecondary, fontSize: "13px", fontStyle: "italic" }}>
              Start talking with Mic On — live captions appear automatically...
            </p>
          )}

          {transcript.map((t2, i) => (
            <div
              key={i}
              style={{
                marginBottom: "8px",
                padding: "10px 12px",
                background: "rgba(255, 255, 255, 0.03)",
                borderRadius: "8px",
                fontSize: "13px",
                lineHeight: "1.5",
                wordBreak: "break-word",
              }}
            >
              <strong style={{ color: t.textPrimary, fontWeight: 600 }}>{t2.speaker}:</strong>{" "}
              <span style={{ color: t.textSecondary, fontWeight: 400 }}>{t2.text}</span>
            </div>
          ))}
        </div>

        {/* TALK TIME */}
        <div style={{
          ...glassCard,
          marginTop: "16px",
          padding: "20px",
        }}>
          <h3 style={{
            fontSize: "13px",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: t.textSecondary,
            marginBottom: "14px",
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
              borderBottom: "1px solid rgba(255, 255, 255, 0.05)",
            }}>
              <span style={{ color: t.textPrimary, fontWeight: 500 }}>{user}</span>
              <span style={{ color: t.textSecondary }}>{(time / 60).toFixed(2)} mins</span>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT / BOTTOM SIDEBAR: ENGAGEMENT + SUMMARY */}
      <div
        className="ms-side-panel"
        style={{
          background: t.surface,
          color: t.textPrimary,
        }}
      >
        {/* ENGAGEMENT CARD */}
        <div style={{
          marginBottom: "24px",
          padding: "16px",
          background: "rgba(255, 255, 255, 0.04)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: t.radius,
        }}>
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "10px",
          }}>
            <h2 style={{
              fontSize: "14px",
              fontWeight: 600,
              color: t.textPrimary,
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
                cursor: "pointer",
              }}
            >
              {visionEnabled ? "Pause" : "Resume"}
            </button>
          </div>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: "8px",
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
            marginBottom: "8px",
          }}>
            <div style={{
              width: `${Math.min(Math.max(engagement, 0), 100)}%`,
              height: "100%",
              background: t.accent,
              transition: "width 300ms ease",
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
          letterSpacing: "-0.2px",
        }}>Meeting Summary</h2>

        {!summary && (
          <p style={{
            color: t.textSecondary,
            fontSize: "13px",
            fontStyle: "italic",
          }}>No summary yet...</p>
        )}

        {summary && !summary.error && (
          <>
            <h3 style={{
              fontSize: "12px",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              color: t.textSecondary,
              marginBottom: "12px",
            }}>Speakers</h3>
            {summary.speakers &&
              Object.entries(summary.speakers).map(([speakerName, data]) => (
                <div
                  key={speakerName}
                  style={{
                    marginBottom: "12px",
                    padding: "14px",
                    background: "rgba(255, 255, 255, 0.04)",
                    border: "1px solid rgba(255, 255, 255, 0.06)",
                    borderRadius: t.radius,
                  }}
                >
                  <strong style={{
                    color: t.textPrimary,
                    fontSize: "14px",
                    fontWeight: 600,
                  }}>{speakerName}</strong>

                  <h4 style={{
                    margin: "12px 0 6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    color: t.accent,
                  }}>Key Points</h4>
                  <ul style={{ paddingLeft: "16px", margin: 0 }}>
                    {data.key_points?.map((point, i) => (
                      <li key={i} style={{
                        fontSize: "13px",
                        color: t.textSecondary,
                        marginBottom: "4px",
                        lineHeight: "1.5",
                      }}>{point}</li>
                    ))}
                  </ul>

                  <h4 style={{
                    margin: "12px 0 6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    color: t.accent,
                  }}>Action Items</h4>
                  <ul style={{ paddingLeft: "16px", margin: 0 }}>
                    {data.action_items?.map((item, i) => (
                      <li key={i} style={{
                        fontSize: "13px",
                        color: t.textSecondary,
                        marginBottom: "4px",
                        lineHeight: "1.5",
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
              marginBottom: "10px",
            }}>Decisions</h3>
            <ul style={{ paddingLeft: "16px", margin: 0 }}>
              {summary.decisions?.map((d, i) => (
                <li key={i} style={{
                  fontSize: "13px",
                  color: t.textSecondary,
                  marginBottom: "4px",
                  lineHeight: "1.5",
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
              marginBottom: "10px",
            }}>Sentiment</h3>
            <p style={{
              fontSize: "13px",
              color: t.textSecondary,
              lineHeight: "1.5",
            }}>{summary.sentiment}</p>
          </>
        )}

        {summary && summary.error && (
          <p style={{
            color: t.danger,
            fontSize: "13px",
            fontWeight: 500,
          }}>
            Summary error: {summary.error}
          </p>
        )}
      </div>
    </div>
  );
}
