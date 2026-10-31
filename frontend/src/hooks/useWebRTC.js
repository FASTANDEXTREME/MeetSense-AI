import { useEffect, useRef, useState, useCallback } from "react";
import { buildWsUrl } from "../utils/wsUrl";

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

if (process.env.REACT_APP_TURN_URL) {
  iceServers.push({
    urls: process.env.REACT_APP_TURN_URL,
    username: process.env.REACT_APP_TURN_USERNAME || undefined,
    credential: process.env.REACT_APP_TURN_CREDENTIAL || undefined,
  });
}

const rtcConfig = { iceServers };

export default function useWebRTC(roomId, clientId, name = "Participant") {
  const localVideoRef = useRef(null);
  const [remotePeers, setRemotePeers] = useState([]);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [mediaError, setMediaError] = useState("");

  const peersRef = useRef({});
  const peerNamesRef = useRef({});
  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const candidateQueue = useRef({});

  const safeSend = useCallback((payload) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const removePeer = useCallback((targetId) => {
    const peer = peersRef.current[targetId];
    if (peer) {
      try {
        peer.close();
      } catch {
        // ignore close errors
      }
      delete peersRef.current[targetId];
    }
    delete candidateQueue.current[targetId];
    delete peerNamesRef.current[targetId];

    setRemotePeers((prev) => prev.filter((p) => p.clientId !== targetId));
  }, []);

  useEffect(() => {
    if (!roomId || !clientId) return;
    let unmounted = false;
    let connectTimer = null;

    async function createPeer(targetId, initiator) {
      if (peersRef.current[targetId]) {
        return peersRef.current[targetId];
      }

      const peer = new RTCPeerConnection(rtcConfig);
      peersRef.current[targetId] = peer;

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          peer.addTrack(track, localStreamRef.current);
        });
      }

      peer.ontrack = (event) => {
        const stream = event.streams?.[0];
        if (!stream) return;

        setRemotePeers((prev) => {
          const peerName = peerNamesRef.current[targetId] || "Participant";
          const existingIdx = prev.findIndex((p) => p.clientId === targetId);
          if (existingIdx !== -1) {
            const updated = [...prev];
            updated[existingIdx] = { clientId: targetId, name: peerName, stream };
            return updated;
          }
          return [...prev, { clientId: targetId, name: peerName, stream }];
        });
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          safeSend({
            type: "ice",
            candidate: event.candidate,
            target: targetId,
          });
        }
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          removePeer(targetId);
        }
      };

      if (initiator) {
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          safeSend({
            type: "offer",
            offer,
            target: targetId,
          });
        } catch (err) {
          console.error(`Failed to create WebRTC offer for ${targetId}:`, err);
        }
      }

      return peer;
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

    async function init() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMediaError(
          "Camera/Mic access is blocked by your browser over insecure HTTP. Please open via localhost or HTTPS."
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        if (unmounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        setMediaError("");
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Failed to get user media:", err);
        setMediaError("Could not access camera or microphone. Check permissions and still view live transcripts/summaries.");
      }

      if (unmounted) return;

      const wsUrl = buildWsUrl(
        `/ws/signal/${encodeURIComponent(roomId)}/${encodeURIComponent(clientId)}?name=${encodeURIComponent(name)}`
      );
      const ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onmessage = async (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (data.type === "existing_peers" && data.peers) {
          Object.entries(data.peers).forEach(([cid, peerName]) => {
            peerNamesRef.current[cid] = peerName;
          });
          return;
        }

        if (data.type === "new_peer") {
          if (data.name) {
            peerNamesRef.current[data.client_id] = data.name;
          }
          await createPeer(data.client_id, true);
          return;
        }

        if (data.type === "peer_left" && data.client_id) {
          removePeer(data.client_id);
          return;
        }

        if (data.sender && data.sender_name) {
          peerNamesRef.current[data.sender] = data.sender_name;
          setRemotePeers((prev) =>
            prev.map((p) =>
              p.clientId === data.sender && p.name !== data.sender_name
                ? { ...p, name: data.sender_name }
                : p
            )
          );
        }

        if (data.offer) {
          try {
            const peer = await createPeer(data.sender, false);
            if (peer.signalingState !== "stable") return;

            await peer.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);

            safeSend({
              type: "answer",
              answer,
              target: data.sender,
            });

            await flushCandidates(data.sender);
          } catch (err) {
            console.error("Failed handling WebRTC offer:", err);
          }
          return;
        }

        if (data.answer) {
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

        if (data.candidate) {
          const peer = peersRef.current[data.sender];
          if (!peer) {
            if (!candidateQueue.current[data.sender]) {
              candidateQueue.current[data.sender] = [];
            }
            candidateQueue.current[data.sender].push(data.candidate);
            return;
          }

          if (peer.remoteDescription) {
            try {
              await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              console.error("Failed adding ICE candidate:", err);
            }
          } else {
            if (!candidateQueue.current[data.sender]) {
              candidateQueue.current[data.sender] = [];
            }
            candidateQueue.current[data.sender].push(data.candidate);
          }
        }
      };
    }

    connectTimer = setTimeout(init, 100);

    return () => {
      unmounted = true;
      clearTimeout(connectTimer);

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
      peerNamesRef.current = {};
      candidateQueue.current = {};

      setRemotePeers([]);
    };
  }, [roomId, clientId, name, safeSend, removePeer]);

  const toggleAudio = useCallback(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setMicMuted(!track.enabled);
    });
  }, []);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    localStreamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setCameraOff(!track.enabled);
    });
  }, []);

  const remoteStreams = remotePeers.map((p) => p.stream);

  return {
    localVideoRef,
    remotePeers,
    remoteStreams,
    micMuted,
    cameraOff,
    toggleAudio,
    toggleVideo,
    mediaError,
  };
}
