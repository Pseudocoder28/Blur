import { useState, useRef, useCallback, useEffect } from "react";
import {
  doc,
  collection,
  addDoc,
  setDoc,
  getDoc,
  deleteDoc,
  onSnapshot,
  updateDoc,
  deleteField,
  query,
  DocumentReference,
  DocumentSnapshot,
  QuerySnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "../lib/firebase";
import { toast } from "sonner";

const servers = {
  iceServers: [
    {
      urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Base URL of the blur backend. Override with VITE_BACKEND_URL in a .env file.
const BACKEND_URL = (
  import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8000"
).replace(/\/$/, "");

// How long to wait for the backend to send back the processed video track.
const PROCESSED_STREAM_TIMEOUT_MS = 15000;

export type CallStatus =
  | "idle"
  | "creating"
  | "waiting"
  | "connecting"
  | "connected"
  | "error";

interface EndCallOptions {
  // Delete the call document so the other peer is notified the call ended.
  deleteCallDoc?: boolean;
  // When set, the hook ends up in the "error" state with this message.
  errorMessage?: string | null;
}

const getErrorMessage = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export const useWebRTC = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const pc = useRef<RTCPeerConnection | null>(null);
  // Connection to the blur backend and the raw (unblurred) camera/mic stream.
  const backendPc = useRef<RTCPeerConnection | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);
  const signalingUnsubscribers = useRef<Unsubscribe[]>([]);
  const callIdRef = useRef<string | null>(null);
  // ICE candidates that arrived before the remote description was set.
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const startingWebcam = useRef<Promise<MediaStream | null> | null>(null);
  const endCallRef = useRef<(options?: EndCallOptions) => Promise<void>>(
    async () => {}
  );

  const addRemoteCandidate = useCallback(
    async (candidate: RTCIceCandidateInit) => {
      if (!pc.current) return;
      if (!pc.current.remoteDescription) {
        pendingCandidates.current.push(candidate);
        return;
      }
      try {
        await pc.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("Error adding ICE candidate:", err);
      }
    },
    []
  );

  const flushPendingCandidates = useCallback(async () => {
    const candidates = pendingCandidates.current;
    pendingCandidates.current = [];
    for (const candidate of candidates) {
      await addRemoteCandidate(candidate);
    }
  }, [addRemoteCandidate]);

  const listenForCandidates = useCallback(
    (candidatesCol: ReturnType<typeof collection>) => {
      const unsubscribe = onSnapshot(
        query(candidatesCol),
        (snapshot: QuerySnapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
              addRemoteCandidate(change.doc.data() as RTCIceCandidateInit);
            }
          });
        }
      );
      signalingUnsubscribers.current.push(unsubscribe);
    },
    [addRemoteCandidate]
  );

  const setupSignalingListeners = useCallback(
    (callDocRef: DocumentReference, isOfferer: boolean) => {
      let docSeen = false;

      const mainUnsubscriber = onSnapshot(
        callDocRef,
        async (snapshot: DocumentSnapshot) => {
          if (!snapshot.exists()) {
            // The document disappearing means the other peer hung up.
            if (docSeen) {
              toast.info("The call has ended.");
              await endCallRef.current({ deleteCallDoc: false });
            }
            return;
          }
          docSeen = true;

          const data = snapshot.data();
          if (!pc.current) return;

          try {
            if (
              data?.answer &&
              pc.current.signalingState === "have-local-offer"
            ) {
              const answerDescription = new RTCSessionDescription(data.answer);
              await pc.current.setRemoteDescription(answerDescription);
              await flushPendingCandidates();
            }

            if (data?.offer) {
              if (isOfferer && pc.current.connectionState !== "connected")
                return;
              if (pc.current.currentRemoteDescription?.sdp === data.offer.sdp)
                return;

              const offerDescription = new RTCSessionDescription(data.offer);
              await pc.current.setRemoteDescription(offerDescription);
              await flushPendingCandidates();
              const answer = await pc.current.createAnswer();
              await pc.current.setLocalDescription(answer);

              if (pc.current.localDescription) {
                await updateDoc(callDocRef, {
                  answer: pc.current.localDescription.toJSON(),
                  offer: deleteField(),
                });
              }
            }
          } catch (err) {
            console.error("Error handling signaling update:", err);
          }
        }
      );
      signalingUnsubscribers.current.push(mainUnsubscriber);
    },
    [flushPendingCandidates]
  );

  const initializePeerConnection = useCallback(
    (currentCallId: string, isOfferer: boolean) => {
      const newPc = new RTCPeerConnection(servers);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          const sender = newPc.addTrack(track, localStreamRef.current!);
          if (track.kind === "video") {
            videoSenderRef.current = sender;
          }
        });
      }

      newPc.ontrack = (event) => {
        setRemoteStream((prevStream) => {
          const newStream = prevStream
            ? new MediaStream(prevStream.getTracks())
            : new MediaStream();
          if (!newStream.getTrackById(event.track.id)) {
            newStream.addTrack(event.track);
          }
          return newStream;
        });
      };

      newPc.onconnectionstatechange = () => {
        if (pc.current !== newPc) return;
        if (newPc.connectionState === "connected") {
          setCallStatus("connected");
        } else if (newPc.connectionState === "failed") {
          endCallRef.current({
            errorMessage: "The connection to the other participant was lost.",
          });
        }
      };

      newPc.onnegotiationneeded = async () => {
        if (!isOfferer && newPc.connectionState !== "connected") return;
        if (newPc.signalingState !== "stable" || !currentCallId) return;

        try {
          const offer = await newPc.createOffer();
          await newPc.setLocalDescription(offer);
          if (newPc.localDescription) {
            const callDocRef = doc(db, "calls", currentCallId);
            await updateDoc(callDocRef, {
              offer: newPc.localDescription.toJSON(),
            });
          }
        } catch (err) {
          console.error("Error during negotiation:", err);
        }
      };

      pendingCandidates.current = [];
      pc.current = newPc;
    },
    []
  );

  const stopLocalMedia = useCallback(() => {
    backendPc.current?.close();
    backendPc.current = null;

    // Stopping the raw stream is what actually releases the camera and mic.
    rawStreamRef.current?.getTracks().forEach((track) => track.stop());
    rawStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;

    if (screenTrackRef.current) {
      screenTrackRef.current.onended = null;
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }
  }, []);

  const acquireProcessedStream = useCallback(async () => {
    let rawStream: MediaStream | null = null;
    let pcToBackend: RTCPeerConnection | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      // 1. Get the user's camera and microphone. Fall back to video only if
      //    no microphone is available.
      const video = { width: { ideal: 640 }, height: { ideal: 480 } };
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          video,
          audio: true,
        });
      } catch (err) {
        console.warn("Could not get audio, falling back to video only:", err);
        rawStream = await navigator.mediaDevices.getUserMedia({
          video,
          audio: false,
        });
      }

      // 2. Create a new RTCPeerConnection to the backend
      pcToBackend = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const backendConnection = pcToBackend;

      // 3. Only the video goes through the backend; audio is sent directly
      //    to the other peer.
      const stream = rawStream;
      stream.getVideoTracks().forEach((track) => {
        backendConnection.addTrack(track, stream);
      });

      // 4. Wait for the processed (blurred) video track from the backend
      const processedTrackPromise = new Promise<MediaStreamTrack>(
        (resolve, reject) => {
          backendConnection.ontrack = (event) => {
            if (event.track.kind === "video") resolve(event.track);
          };
          backendConnection.onconnectionstatechange = () => {
            if (
              ["failed", "closed"].includes(backendConnection.connectionState)
            ) {
              reject(new Error("Connection to backend failed"));
            }
          };
          timeoutId = setTimeout(
            () => reject(new Error("Timed out waiting for processed video")),
            PROCESSED_STREAM_TIMEOUT_MS
          );
        }
      );
      // Avoid an unhandled rejection if we bail out before awaiting it.
      processedTrackPromise.catch(() => {});

      // 5. Create and send offer to FastAPI backend
      const offer = await backendConnection.createOffer();
      await backendConnection.setLocalDescription(offer);
      const response = await fetch(`${BACKEND_URL}/offer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp, type: offer.type }),
      });
      if (!response.ok) {
        throw new Error(`Backend responded with ${response.status}`);
      }
      const answer = await response.json();
      await backendConnection.setRemoteDescription(
        new RTCSessionDescription(answer)
      );

      // 6. Wait for the processed track
      const processedTrack = await processedTrackPromise;

      // 7. The local stream is the blurred video plus the raw microphone
      //    audio. The raw video is never sent to the other peer.
      const processedStream = new MediaStream([
        processedTrack,
        ...rawStream.getAudioTracks(),
      ]);
      rawStreamRef.current = rawStream;
      backendPc.current = backendConnection;
      localStreamRef.current = processedStream;
      setLocalStream(processedStream);
      return processedStream;
    } catch (err) {
      console.error("Error accessing or processing camera:", err);
      toast.error(
        "Could not access or process webcam. Please check permissions and backend."
      );
      pcToBackend?.close();
      rawStream?.getTracks().forEach((track) => track.stop());
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  const startWebcam = useCallback(() => {
    if (localStreamRef.current) return Promise.resolve(localStreamRef.current);
    // Share a single in-flight request so double clicks don't open the
    // camera twice.
    if (!startingWebcam.current) {
      startingWebcam.current = acquireProcessedStream().finally(() => {
        startingWebcam.current = null;
      });
    }
    return startingWebcam.current;
  }, [acquireProcessedStream]);

  const endCall = useCallback(
    async ({
      deleteCallDoc = true,
      errorMessage = null,
    }: EndCallOptions = {}) => {
      // Stop listening first so our own delete isn't seen as a remote hang-up.
      signalingUnsubscribers.current.forEach((unsub) => unsub());
      signalingUnsubscribers.current = [];

      const endedCallId = callIdRef.current;
      callIdRef.current = null;

      if (pc.current) {
        pc.current.onconnectionstatechange = null;
        pc.current.onnegotiationneeded = null;
        pc.current.onicecandidate = null;
        pc.current.ontrack = null;
        pc.current.close();
        pc.current = null;
      }
      videoSenderRef.current = null;
      pendingCandidates.current = [];

      stopLocalMedia();

      setLocalStream(null);
      setRemoteStream(null);
      setCallId(null);
      setCallStatus(errorMessage ? "error" : "idle");
      setError(errorMessage);
      setIsMuted(false);
      setIsVideoOff(false);
      setIsSharingScreen(false);

      if (deleteCallDoc && endedCallId) {
        try {
          await deleteDoc(doc(db, "calls", endedCallId));
        } catch (err) {
          console.error("Error deleting call document:", err);
        }
      }
    },
    [stopLocalMedia]
  );

  useEffect(() => {
    endCallRef.current = endCall;
  }, [endCall]);

  const hangUp = useCallback(() => endCall(), [endCall]);

  const createCall = useCallback(async () => {
    setError(null);
    setCallStatus("creating");

    const stream = await startWebcam();
    if (!stream) {
      await endCall({
        errorMessage:
          "Could not start your camera. Check permissions and that the backend is running.",
      });
      return;
    }

    try {
      const callDocRef = doc(collection(db, "calls"));
      const newCallId = callDocRef.id;

      initializePeerConnection(newCallId, true);
      if (!pc.current) throw new Error("Peer connection not created");

      const offerCandidatesCol = collection(callDocRef, "offerCandidates");
      const answerCandidatesCol = collection(callDocRef, "answerCandidates");

      pc.current.onicecandidate = (event) => {
        if (event.candidate)
          addDoc(offerCandidatesCol, event.candidate.toJSON());
      };

      callIdRef.current = newCallId;
      setupSignalingListeners(callDocRef, true);
      listenForCandidates(answerCandidatesCol);

      const offerDescription = await pc.current.createOffer();
      await pc.current.setLocalDescription(offerDescription);
      const offer = { sdp: offerDescription.sdp, type: offerDescription.type };
      await setDoc(callDocRef, { offer });

      setCallId(newCallId);
      setCallStatus("waiting");
    } catch (err) {
      console.error(err);
      await endCall({
        errorMessage: getErrorMessage(err, "Failed to create call."),
      });
    }
  }, [
    startWebcam,
    endCall,
    initializePeerConnection,
    setupSignalingListeners,
    listenForCandidates,
  ]);

  const joinCall = useCallback(
    async (joiningCallId: string) => {
      setError(null);
      setCallStatus("connecting");

      const stream = await startWebcam();
      if (!stream) {
        await endCall({
          deleteCallDoc: false,
          errorMessage:
            "Could not start your camera. Check permissions and that the backend is running.",
        });
        return;
      }

      // Only delete the call document on failure once we are part of the
      // call; a failed join must not tear down someone else's call.
      let joined = false;
      try {
        const callDocRef = doc(db, "calls", joiningCallId);
        const callDocSnap = await getDoc(callDocRef);
        if (!callDocSnap.exists()) {
          throw new Error("Call ID not found.");
        }
        const offerDescription = callDocSnap.data().offer;
        if (!offerDescription) {
          throw new Error("This call is already in progress.");
        }

        initializePeerConnection(joiningCallId, false);
        if (!pc.current) throw new Error("Peer connection not created");

        const offerCandidatesCol = collection(callDocRef, "offerCandidates");
        const answerCandidatesCol = collection(callDocRef, "answerCandidates");

        pc.current.onicecandidate = (event) => {
          if (event.candidate)
            addDoc(answerCandidatesCol, event.candidate.toJSON());
        };

        await pc.current.setRemoteDescription(
          new RTCSessionDescription(offerDescription)
        );
        const answerDescription = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answerDescription);
        const answer = {
          type: answerDescription.type,
          sdp: answerDescription.sdp,
        };
        await updateDoc(callDocRef, { answer, offer: deleteField() });
        joined = true;

        callIdRef.current = joiningCallId;
        setCallId(joiningCallId);
        setupSignalingListeners(callDocRef, false);
        listenForCandidates(offerCandidatesCol);
      } catch (err) {
        console.error(err);
        await endCall({
          deleteCallDoc: joined,
          errorMessage: getErrorMessage(err, "Failed to join call."),
        });
      }
    },
    [
      startWebcam,
      endCall,
      initializePeerConnection,
      setupSignalingListeners,
      listenForCandidates,
    ]
  );

  const toggleMic = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted((prev) => !prev);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const enabled = isVideoOff;
      // Disable the raw camera track too so no video reaches the backend.
      [
        ...localStreamRef.current.getVideoTracks(),
        ...(rawStreamRef.current?.getVideoTracks() ?? []),
      ].forEach((track) => {
        track.enabled = enabled;
      });
      setIsVideoOff(!enabled);
    }
  }, [isVideoOff]);

  const stopScreenShare = useCallback(async () => {
    if (screenTrackRef.current) {
      screenTrackRef.current.onended = null;
      screenTrackRef.current.stop();
      screenTrackRef.current = null;
    }
    if (videoSenderRef.current && localStreamRef.current) {
      const cameraTrack = localStreamRef.current.getVideoTracks()[0];
      await videoSenderRef.current.replaceTrack(cameraTrack);
      setLocalStream(localStreamRef.current);
    }
    setIsSharingScreen(false);
  }, []);

  // Note: the shared screen is sent directly to the other peer and does not
  // pass through the blur backend.
  const toggleScreenShare = useCallback(async () => {
    if (!pc.current || !videoSenderRef.current) return;

    if (isSharingScreen) {
      await stopScreenShare();
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      await videoSenderRef.current.replaceTrack(screenTrack);
      screenTrackRef.current = screenTrack;

      const audioTrack = localStreamRef.current?.getAudioTracks()[0];
      const newLocalStream = new MediaStream([
        screenTrack,
        ...(audioTrack ? [audioTrack] : []),
      ]);
      setLocalStream(newLocalStream);
      setIsSharingScreen(true);

      // Fired when the user stops sharing from the browser's own UI.
      screenTrack.onended = () => {
        stopScreenShare();
      };
    } catch (err) {
      console.error("Error starting screen share:", err);
      setIsSharingScreen(false);
    }
  }, [isSharingScreen, stopScreenShare]);

  useEffect(() => {
    return () => {
      if (pc.current || localStreamRef.current) {
        hangUp();
      }
    };
  }, [hangUp]);

  return {
    localStream,
    remoteStream,
    callId,
    callStatus,
    error,
    isMuted,
    isVideoOff,
    isSharingScreen,
    startWebcam,
    createCall,
    joinCall,
    hangUp,
    toggleMic,
    toggleVideo,
    toggleScreenShare,
  };
};
