import { useEffect, useRef, useState, useCallback } from "react";
import { buildApiUrl, buildWsUrl } from "../utils/wsUrl";

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

if (process.env.REACT_APP_TURN_URL) {
  DEFAULT_ICE_SERVERS.push({
    urls: process.env.REACT_APP_TURN_URL,
    username: process.env.REACT_APP_TURN_USERNAME || undefined,
    credential: process.env.REACT_APP_TURN_CREDENTIAL || undefined,
  });
}

const HEARTBEAT_INTERVAL_MS = 15000;
const BASE_SIGNAL_RECONNECT_MS = 700;
const MAX_SIGNAL_RECONNECT_MS = 5000;

export default function useWebRTC(roomId, clientId, name = "Participant") {
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);

  const [remotePeers, setRemotePeers] = useState([]);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaError, setMediaError] = useState("");

  const peersRef = useRef({});
  const remoteStreamsMapRef = useRef({});
  const peerNamesRef = useRef({});
  const knownPeersRef = useRef(new Set());
  const p2pConnectedRef = useRef({});
  const makingOfferRef = useRef({});
  const iceRestartTimerRef = useRef({});
  const candidateQueue = useRef({});
  const socketRef = useRef(null);
  const rtcConfigRef = useRef({ iceServers: DEFAULT_ICE_SERVERS });

  const cameraOffRef = useRef(false);
  const micMutedRef = useRef(false);

  const safeSend = useCallback((payload) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const upsertRemotePeer = useCallback((targetId, patch) => {
    if (!targetId || targetId === clientId) return;
    setRemotePeers((prev) => {
      const idx = prev.findIndex((p) => p.clientId === targetId);
      const resolvedName =
        patch.name || peerNamesRef.current[targetId] || (idx !== -1 ? prev[idx].name : "Participant");

      if (idx !== -1) {
        const current = prev[idx];
        const next = {
          ...current,
          ...patch,
          clientId: targetId,
          name: resolvedName,
        };
        const updated = [...prev];
        updated[idx] = next;
        return updated;
      }

      return [
        ...prev,
        {
          clientId: targetId,
          name: resolvedName,
          stream: null,
          trackRev: 0,
          fallbackFrame: null,
          cameraOff: false,
          micMuted: false,
          iceState: "new",
          ...patch,
        },
      ];
    });
  }, [clientId]);

  // Reset only the underlying RTCPeerConnection (keeping the UI tile intact during reconnect)
  const resetPeerConnection = useCallback((targetId) => {
    const peer = peersRef.current[targetId];
    if (peer) {
      try {
        peer.ontrack = null;
        peer.onicecandidate = null;
        peer.oniceconnectionstatechange = null;
        peer.close();
      } catch {
        // ignore close errors
      }
      delete peersRef.current[targetId];
    }
    clearTimeout(iceRestartTimerRef.current[targetId]);
    delete iceRestartTimerRef.current[targetId];
    delete remoteStreamsMapRef.current[targetId];
    delete candidateQueue.current[targetId];
    delete p2pConnectedRef.current[targetId];
    delete makingOfferRef.current[targetId];
  }, []);

  const removePeer = useCallback((targetId) => {
    resetPeerConnection(targetId);
    delete peerNamesRef.current[targetId];
    knownPeersRef.current.delete(targetId);
    setRemotePeers((prev) => prev.filter((p) => p.clientId !== targetId));
  }, [resetPeerConnection]);

  useEffect(() => {
    if (!roomId || !clientId) return;
    let unmounted = false;
    let connectTimer = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let heartbeatTimer = null;
    let fallbackRelayTimer = null;

    async function loadIceServers() {
      try {
        const res = await fetch(buildApiUrl("/api/ice-servers"));
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
            const merged = [...json.iceServers];
            if (process.env.REACT_APP_TURN_URL) {
              merged.push({
                urls: process.env.REACT_APP_TURN_URL,
                username: process.env.REACT_APP_TURN_USERNAME || undefined,
                credential: process.env.REACT_APP_TURN_CREDENTIAL || undefined,
              });
            }
            rtcConfigRef.current = { iceServers: merged };
          }
        }
      } catch {
        // Keep DEFAULT_ICE_SERVERS
      }
    }

    async function acquireLocalMedia() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMediaError(
          "Camera/Mic access requires HTTPS or localhost on mobile browsers."
        );
        cameraOffRef.current = true;
        micMutedRef.current = true;
        setCameraOff(true);
        setMicMuted(true);
        return null;
      }

      const attempts = [
        {
          constraints: {
            video: {
              facingMode: "user",
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 24, max: 30 },
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          },
          camOff: false,
          muted: false,
        },
        {
          constraints: { video: true, audio: true },
          camOff: false,
          muted: false,
        },
        {
          constraints: { video: { facingMode: "user" }, audio: false },
          camOff: false,
          muted: true,
        },
        {
          constraints: { video: false, audio: true },
          camOff: true,
          muted: false,
        },
      ];

      for (const attempt of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
          cameraOffRef.current = attempt.camOff;
          micMutedRef.current = attempt.muted;
          setCameraOff(attempt.camOff);
          setMicMuted(attempt.muted);
          if (attempt.camOff) {
            setMediaError("Camera unavailable or busy — joined with audio only.");
          } else if (attempt.muted) {
            setMediaError("Microphone unavailable — joined with video only.");
          } else {
            setMediaError("");
          }
          return stream;
        } catch {
          // try next progressive constraint fallback
        }
      }

      cameraOffRef.current = true;
      micMutedRef.current = true;
      setCameraOff(true);
      setMicMuted(true);
      setMediaError(
        "Could not access camera or microphone. You can still view remote streams, transcripts, and summaries."
      );
      return null;
    }

    async function sendOffer(peer, targetId, iceRestart = false) {
      try {
        makingOfferRef.current[targetId] = true;
        const offer = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
        if (peer.signalingState !== "stable") return;
        await peer.setLocalDescription(offer);
        safeSend({
          type: "offer",
          offer: peer.localDescription || offer,
          target: targetId,
        });
      } catch (err) {
        console.error(`Failed to create WebRTC offer for ${targetId}:`, err);
      } finally {
        makingOfferRef.current[targetId] = false;
      }
    }

    async function createPeer(targetId, initiator) {
      if (!targetId || targetId === clientId) return null;
      if (peersRef.current[targetId]) {
        return peersRef.current[targetId];
      }

      knownPeersRef.current.add(targetId);
      upsertRemotePeer(targetId, {});

      const peer = new RTCPeerConnection(rtcConfigRef.current);
      peersRef.current[targetId] = peer;

      let hasAudioTrack = false;
      let hasVideoTrack = false;

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          peer.addTrack(track, localStreamRef.current);
          if (track.kind === "audio") hasAudioTrack = true;
          if (track.kind === "video") hasVideoTrack = true;
        });
      }

      // Ensure offer always negotiates bidirectional audio/video m-lines even if
      // the offerer (e.g. a desktop PC without webcam) has no local camera track!
      if (initiator) {
        if (!hasAudioTrack) {
          peer.addTransceiver("audio", { direction: "recvonly" });
        }
        if (!hasVideoTrack) {
          peer.addTransceiver("video", { direction: "recvonly" });
        }
      }

      peer.ontrack = (event) => {
        if (peersRef.current[targetId] !== peer) return;
        let combinedStream = remoteStreamsMapRef.current[targetId];
        if (!combinedStream) {
          combinedStream = new MediaStream();
          remoteStreamsMapRef.current[targetId] = combinedStream;
        }

        if (
          event.track &&
          !combinedStream.getTracks().some((t) => t.id === event.track.id)
        ) {
          combinedStream.addTrack(event.track);
        }

        const eventStream = event.streams?.[0];
        if (eventStream) {
          eventStream.getTracks().forEach((t) => {
            if (!combinedStream.getTracks().some((existing) => existing.id === t.id)) {
              combinedStream.addTrack(t);
            }
          });
        }

        const bumpRevision = () => {
          if (peersRef.current[targetId] !== peer) return;
          setRemotePeers((prev) => {
            const idx = prev.findIndex((p) => p.clientId === targetId);
            const peerName = peerNamesRef.current[targetId] || "Participant";
            if (idx !== -1) {
              const updated = [...prev];
              updated[idx] = {
                ...updated[idx],
                name: peerName,
                stream: combinedStream,
                trackRev: (updated[idx].trackRev || 0) + 1,
              };
              return updated;
            }
            return [
              ...prev,
              {
                clientId: targetId,
                name: peerName,
                stream: combinedStream,
                trackRev: 1,
                fallbackFrame: null,
                cameraOff: false,
                micMuted: false,
                iceState: peer.iceConnectionState || "checking",
              },
            ];
          });
        };

        bumpRevision();
        if (event.track) {
          event.track.onunmute = bumpRevision;
        }
      };

      peer.onicecandidate = (event) => {
        if (peersRef.current[targetId] !== peer) return;
        if (event.candidate) {
          safeSend({
            type: "ice",
            candidate: event.candidate,
            target: targetId,
          });
        }
      };

      peer.oniceconnectionstatechange = () => {
        if (peersRef.current[targetId] !== peer) return;
        const state = peer.iceConnectionState;
        const isConnected = state === "connected" || state === "completed";
        p2pConnectedRef.current[targetId] = isConnected;
        upsertRemotePeer(targetId, {
          iceState: state,
          ...(isConnected ? { fallbackFrame: null } : {}),
        });

        clearTimeout(iceRestartTimerRef.current[targetId]);
        if ((state === "failed" || state === "disconnected") && String(clientId) > String(targetId)) {
          iceRestartTimerRef.current[targetId] = setTimeout(() => {
            if (
              !unmounted &&
              peersRef.current[targetId] === peer &&
              (peer.iceConnectionState === "failed" || peer.iceConnectionState === "disconnected")
            ) {
              sendOffer(peer, targetId, true);
            }
          }, 2000);
        }
      };

      if (initiator) {
        await sendOffer(peer, targetId, false);
      }

      return peer;
    }

    /**
     * Reconcile local tile list & mesh connections against the server's authoritative
     * room roster so mobile and desktop NEVER show different numbers of participants.
     */
    function reconcileRoster(peersMap) {
      if (!peersMap || typeof peersMap !== "object") return;

      const liveRemoteIds = new Set(
        Object.keys(peersMap).filter((cid) => cid && cid !== clientId)
      );

      // 1. Evict any local ghost tiles that are no longer in the server's live roster
      Array.from(knownPeersRef.current).forEach((cid) => {
        if (!liveRemoteIds.has(cid)) {
          removePeer(cid);
        }
      });

      // Also clean any orphan state entries not in knownPeersRef
      setRemotePeers((prev) =>
        prev.some((p) => !liveRemoteIds.has(p.clientId))
          ? prev.filter((p) => liveRemoteIds.has(p.clientId))
          : prev
      );

      // 2. Ensure every live peer has a visible tile & an active RTCPeerConnection
      liveRemoteIds.forEach((cid) => {
        const peerName = peersMap[cid] || "Participant";
        peerNamesRef.current[cid] = peerName;
        knownPeersRef.current.add(cid);
        upsertRemotePeer(cid, { name: peerName });

        // Deterministic initiator heals any missing pairwise connection after reconnects
        if (!peersRef.current[cid] && String(clientId) > String(cid)) {
          createPeer(cid, true);
        }
      });
    }

    async function flushCandidates(sender) {
      const peer = peersRef.current[sender];
      const queued = candidateQueue.current[sender];

      if (queued && peer && peer.remoteDescription) {
        candidateQueue.current[sender] = [];
        for (const candidate of queued) {
          try {
            await peer.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (err) {
            console.error("Failed to add queued ICE candidate:", err);
          }
        }
      }
    }

    function connectSignaling() {
      if (unmounted) return;
      clearTimeout(reconnectTimer);

      if (
        socketRef.current &&
        (socketRef.current.readyState === WebSocket.OPEN ||
          socketRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      const wsUrl = buildWsUrl(
        `/ws/signal/${encodeURIComponent(roomId)}/${encodeURIComponent(clientId)}?name=${encodeURIComponent(name)}`
      );
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        clearInterval(heartbeatTimer);

        safeSend({
          type: "media_state",
          target: "*",
          camera_off: cameraOffRef.current,
          mic_muted: micMutedRef.current,
        });

        // Periodic heartbeat keeps mobile NAT bindings alive and reconciles room roster
        heartbeatTimer = setInterval(() => {
          safeSend({ type: "ping" });
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onclose = () => {
        clearInterval(heartbeatTimer);
        if (unmounted) return;

        // Reset stale peer connections so re-joining cleanly re-negotiates media
        Array.from(knownPeersRef.current).forEach((cid) => {
          resetPeerConnection(cid);
        });

        const delay = Math.min(
          BASE_SIGNAL_RECONNECT_MS * Math.pow(1.8, reconnectAttempt),
          MAX_SIGNAL_RECONNECT_MS
        );
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connectSignaling, delay);
      };

      ws.onerror = () => {
        // onclose handles reconnect
      };

      ws.onmessage = async (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.type === "room_peers" && data.peers) {
          reconcileRoster(data.peers);
          return;
        }

        if (data.type === "pong" && data.peers) {
          reconcileRoster(data.peers);
          return;
        }

        if (data.type === "existing_peers" && data.peers) {
          reconcileRoster(data.peers);
          return;
        }

        if ((data.type === "new_peer" || data.type === "peer_reconnected") && data.client_id) {
          if (data.client_id === clientId) return;
          if (data.name) {
            peerNamesRef.current[data.client_id] = data.name;
          }
          knownPeersRef.current.add(data.client_id);

          // If this peer refreshed or reconnected after a network switch, tear down
          // the stale RTCPeerConnection while keeping their UI tile smoothly in place!
          if (peersRef.current[data.client_id]) {
            resetPeerConnection(data.client_id);
          }

          upsertRemotePeer(data.client_id, {
            name: data.name || "Participant",
            stream: null,
            trackRev: 0,
          });

          safeSend({
            type: "media_state",
            target: data.client_id,
            camera_off: cameraOffRef.current,
            mic_muted: micMutedRef.current,
          });

          await createPeer(data.client_id, true);
          return;
        }

        if (data.type === "peer_left" && data.client_id) {
          removePeer(data.client_id);
          return;
        }

        if (data.sender && data.sender_name) {
          peerNamesRef.current[data.sender] = data.sender_name;
        }

        if (data.type === "media_state" && data.sender) {
          if (data.sender === clientId) return;
          knownPeersRef.current.add(data.sender);
          const camOff = Boolean(data.camera_off);
          upsertRemotePeer(data.sender, {
            name: data.sender_name,
            cameraOff: camOff,
            micMuted: Boolean(data.mic_muted),
            ...(camOff ? { fallbackFrame: null } : {}),
          });
          return;
        }

        if (data.type === "video_frame" && data.sender && data.frame) {
          if (data.sender === clientId) return;
          knownPeersRef.current.add(data.sender);
          if (!p2pConnectedRef.current[data.sender]) {
            upsertRemotePeer(data.sender, {
              name: data.sender_name,
              fallbackFrame: data.frame,
              cameraOff: false,
            });
          }
          return;
        }

        if (data.offer && data.sender) {
          try {
            const peer = await createPeer(data.sender, false);
            if (!peer) return;
            const isPolite = String(clientId) < String(data.sender);
            const offerCollision =
              makingOfferRef.current[data.sender] || peer.signalingState !== "stable";

            if (offerCollision) {
              if (!isPolite) {
                return;
              }
              await Promise.all([
                peer.setLocalDescription({ type: "rollback" }),
                peer.setRemoteDescription(new RTCSessionDescription(data.offer)),
              ]);
            } else {
              await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
            }

            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);

            safeSend({
              type: "answer",
              answer: peer.localDescription || answer,
              target: data.sender,
            });

            await flushCandidates(data.sender);
          } catch (err) {
            console.error("Failed handling WebRTC offer:", err);
          }
          return;
        }

        if (data.answer && data.sender) {
          try {
            const peer = peersRef.current[data.sender];
            if (!peer || peer.signalingState !== "have-local-offer") return;

            await peer.setRemoteDescription(new RTCSessionDescription(data.answer));
            await flushCandidates(data.sender);
          } catch (err) {
            console.error("Failed handling WebRTC answer:", err);
          }
          return;
        }

        if (data.candidate && data.sender) {
          const peer = peersRef.current[data.sender];
          if (!peer || !peer.remoteDescription) {
            if (!candidateQueue.current[data.sender]) {
              candidateQueue.current[data.sender] = [];
            }
            candidateQueue.current[data.sender].push(data.candidate);
            return;
          }

          try {
            await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (err) {
            console.error("Failed adding ICE candidate:", err);
          }
        }
      };
    }

    function startFallbackVideoRelay() {
      if (typeof document === "undefined") return;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      fallbackRelayTimer = setInterval(() => {
        if (unmounted || cameraOffRef.current) return;
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 128000) {
          return;
        }

        const videoEl = localVideoRef.current;
        if (
          !videoEl ||
          videoEl.readyState < 2 ||
          videoEl.videoWidth === 0 ||
          videoEl.videoHeight === 0
        ) {
          return;
        }

        // Only send WebSocket video frames to peers whose direct WebRTC P2P ICE is not connected
        // (e.g. mobile 4G/5G Symmetric CGNAT without TURN, or while ICE is still negotiating)
        const fallbackTargets = Array.from(knownPeersRef.current).filter(
          (pid) => !p2pConnectedRef.current[pid]
        );
        if (fallbackTargets.length === 0) return;

        const srcW = videoEl.videoWidth;
        const srcH = videoEl.videoHeight;
        const maxDim = 240;
        let dstW;
        let dstH;
        if (srcW >= srcH) {
          dstW = maxDim;
          dstH = Math.max(120, Math.round((srcH / srcW) * maxDim));
        } else {
          dstH = maxDim;
          dstW = Math.max(120, Math.round((srcW / srcH) * maxDim));
        }

        if (canvas.width !== dstW || canvas.height !== dstH) {
          canvas.width = dstW;
          canvas.height = dstH;
        }

        ctx.drawImage(videoEl, 0, 0, dstW, dstH);
        const frame = canvas.toDataURL("image/jpeg", 0.52);

        safeSend({
          type: "video_frame",
          targets: fallbackTargets,
          frame,
        });
      }, 220);
    }

    const handleVisibilityOrOnline = () => {
      if (unmounted) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED) {
        reconnectAttempt = 0;
        connectSignaling();
      } else if (socketRef.current.readyState === WebSocket.OPEN) {
        safeSend({ type: "ping" });
      }
    };

    const handlePageExit = () => {
      if (socketRef.current) {
        try {
          socketRef.current.close();
        } catch {
          // ignore
        }
      }
    };

    async function init() {
      await loadIceServers();
      if (unmounted) return;

      const stream = await acquireLocalMedia();
      if (unmounted) {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        return;
      }

      if (stream) {
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.play?.().catch(() => {});
        }
      }
      setMediaReady(true);

      connectSignaling();
      startFallbackVideoRelay();

      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityOrOnline);
      }
      if (typeof window !== "undefined") {
        window.addEventListener("online", handleVisibilityOrOnline);
        window.addEventListener("pagehide", handlePageExit);
        window.addEventListener("beforeunload", handlePageExit);
      }
    }

    connectTimer = setTimeout(init, 100);

    const restartTimers = iceRestartTimerRef.current;

    return () => {
      unmounted = true;
      clearTimeout(connectTimer);
      clearTimeout(reconnectTimer);
      clearInterval(heartbeatTimer);
      clearInterval(fallbackRelayTimer);
      Object.values(restartTimers).forEach((timer) => clearTimeout(timer));

      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityOrOnline);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleVisibilityOrOnline);
        window.removeEventListener("pagehide", handlePageExit);
        window.removeEventListener("beforeunload", handlePageExit);
      }

      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }

      Object.values(peersRef.current).forEach((peer) => {
        try {
          peer.close();
        } catch {
          // ignore
        }
      });
      peersRef.current = {};
      remoteStreamsMapRef.current = {};
      peerNamesRef.current = {};
      knownPeersRef.current = new Set();
      p2pConnectedRef.current = {};
      makingOfferRef.current = {};
      candidateQueue.current = {};

      setMediaReady(false);
      setRemotePeers([]);
    };
  }, [roomId, clientId, name, safeSend, upsertRemotePeer, resetPeerConnection, removePeer]);

  const toggleAudio = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTracks = localStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0) return;

    const nextEnabled = !audioTracks[0].enabled;
    audioTracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    const nextMuted = !nextEnabled;
    micMutedRef.current = nextMuted;
    setMicMuted(nextMuted);

    safeSend({
      type: "media_state",
      target: "*",
      camera_off: cameraOffRef.current,
      mic_muted: nextMuted,
    });
  }, [safeSend]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    if (videoTracks.length === 0) return;

    const nextEnabled = !videoTracks[0].enabled;
    videoTracks.forEach((track) => {
      track.enabled = nextEnabled;
    });
    const nextCamOff = !nextEnabled;
    cameraOffRef.current = nextCamOff;
    setCameraOff(nextCamOff);

    safeSend({
      type: "media_state",
      target: "*",
      camera_off: nextCamOff,
      mic_muted: micMutedRef.current,
    });
  }, [safeSend]);

  const remoteStreams = remotePeers.map((p) => p.stream).filter(Boolean);

  return {
    localVideoRef,
    localStreamRef,
    remotePeers,
    remoteStreams,
    micMuted,
    cameraOff,
    mediaReady,
    toggleAudio,
    toggleVideo,
    mediaError,
  };
}
