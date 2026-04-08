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

  useEffect(() => {
    async function init() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.error("Browser blocked getUserMedia over HTTP. You must use HTTPS or localhost.");
        alert("Camera/Mic access is blocked by your browser. Please access via localhost or HTTPS.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
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

          socketRef.current.send(JSON.stringify({
            answer,
            target: data.sender
          }));

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
  }, [roomId, clientId]);

  function createPeer(targetId, initiator) {
    if (peersRef.current[targetId]) {
      return peersRef.current[targetId];
    }

    const peer = new RTCPeerConnection(config);

    localStreamRef.current.getTracks().forEach(track => {
      peer.addTrack(track, localStreamRef.current);
    });

    peer.ontrack = (event) => {
      setRemoteStreams(prev => {
        if (prev.find(s => s.id === event.streams[0].id)) return prev;
        return [...prev, event.streams[0]];
      });
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.send(JSON.stringify({
          candidate: event.candidate,
          target: targetId
        }));
      }
    };

    if (initiator) {
      peer.createOffer().then(offer => {
        peer.setLocalDescription(offer);
        socketRef.current.send(JSON.stringify({
          offer,
          target: targetId
        }));
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