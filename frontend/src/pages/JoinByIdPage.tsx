import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { useWebRTCContext } from "../contexts/WebRTCProvider";
import LoadingSpinner from "../components/LoadingSpinner";
import ErrorDisplay from "../components/ErrorDisplay";
import CallPage from "./CallPage";
import Background from "../components/Background";
import { useReturnHomeOnCallEnd } from "../hooks/useReturnHomeOnCallEnd";

const JoinByIdPage = () => {
  const { id } = useParams<{ id: string }>();
  const { callStatus, error, joinCall, hangUp } = useWebRTCContext();

  useReturnHomeOnCallEnd(callStatus);

  const statusRef = useRef(callStatus);
  useEffect(() => {
    statusRef.current = callStatus;
  });

  useEffect(() => {
    if (id) {
      joinCall(id);
    }
  }, [joinCall, id]);

  useEffect(() => {
    // Hang up if the user navigates away mid-call.
    return () => {
      if (statusRef.current !== "idle" && statusRef.current !== "error") {
        hangUp();
      }
    };
  }, [hangUp]);

  if (callStatus === "error") {
    return <ErrorDisplay message={error} />;
  }

  if (callStatus === "connected") {
    return <CallPage />;
  }

  return (
    <Background>
      <LoadingSpinner text="Joining call..." />
    </Background>
  );
};

export default JoinByIdPage;
