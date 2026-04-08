import { useEffect, useRef, useState } from "react";

const config = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

export default function useWebRTC(roomId, clientId) {
  const localVideoRef = useRef();
  const [remoteStreams, setRemoteStreams] = useState([]);
  const peersRef = useRef({});
  const socketRef = useRef();
  const localStreamRef = useRef();
  const candidateQueue = useRef({});

  const safeSend = (payload) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
    }
  };

  useEffect(() => {
    let unmounted = false;

    async function init() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error("Browser blocked getUserMedia over HTTP. You must use HTTPS or localhost.");
        alert("Camera/Mic access is blocked by your browser. Please access via localhost or HTTPS.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });

        if (unmounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("Failed to get user media:", err);
        return;
      }

      const wsHost = window.location.hostname || "localhost";
      socketRef.current = new WebSocket(
        `ws://${wsHost}:8000/ws/signal/${roomId}/${clientId}`
      );

      socketRef.current.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "new_peer") {
          createPeer(data.client_id, true);
        }

        if (data.offer) {
          const peer = createPeer(data.sender, false);

          if (peer.signalingState !== "stable") return;

          await peer.setRemoteDescription(
            new RTCSessionDescription(data.offer)
          );

          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);

          safeSend({
            answer,
            target: data.sender
          });

          flushCandidates(data.sender);
        }

        if (data.answer) {
          const peer = peersRef.current[data.sender];
          if (!peer) return;

          if (peer.signalingState !== "have-local-offer") return;

          await peer.setRemoteDescription(
            new RTCSessionDescription(data.answer)
          );

          flushCandidates(data.sender);
        }

        if (data.candidate) {
          const peer = peersRef.current[data.sender];
          if (!peer) return;

          if (peer.remoteDescription) {
            await peer.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } else {
            if (!candidateQueue.current[data.sender]) {
              candidateQueue.current[data.sender] = [];
            }
            candidateQueue.current[data.sender].push(data.candidate);
          }
        }
      };
    }

    init();

    return () => {
      unmounted = true;

      // Close signaling socket
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }

      // Stop all local media tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      // Close all peer connections
      Object.values(peersRef.current).forEach(peer => {
        try { peer.close(); } catch (e) { /* ignore */ }
      });
      peersRef.current = {};

      // Clear candidate queue
      candidateQueue.current = {};

      setRemoteStreams([]);
    };
  }, [roomId, clientId]);

  function createPeer(targetId, initiator) {
    if (peersRef.current[targetId]) {
      return peersRef.current[targetId];
    }

    const peer = new RTCPeerConnection(config);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        peer.addTrack(track, localStreamRef.current);
      });
    }

    peer.ontrack = (event) => {
      setRemoteStreams(prev => {
        if (prev.find(s => s.id === event.streams[0].id)) return prev;
        return [...prev, event.streams[0]];
      });
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        safeSend({
          candidate: event.candidate,
          target: targetId
        });
      }
    };

    if (initiator) {
      peer.createOffer().then(offer => {
        peer.setLocalDescription(offer);
        safeSend({
          offer,
          target: targetId
        });
      });
    }

    peersRef.current[targetId] = peer;
    return peer;
  }

  async function flushCandidates(sender) {
    const peer = peersRef.current[sender];
    const queued = candidateQueue.current[sender];

    if (queued && peer.remoteDescription) {
      for (let candidate of queued) {
        await peer.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      }
      candidateQueue.current[sender] = [];
    }
  }

  return { localVideoRef, remoteStreams };
}