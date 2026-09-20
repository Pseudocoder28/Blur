import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useWebRTCContext } from "../contexts/WebRTCProvider";
import LoadingSpinner from "../components/LoadingSpinner";
import ErrorDisplay from "../components/ErrorDisplay";
import CallPage from "../pages/CallPage";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import Background from "../components/Background";
import { useReturnHomeOnCallEnd } from "../hooks/useReturnHomeOnCallEnd";

const CreateCallPage = () => {
  const { callStatus, callId, createCall, error, hangUp } = useWebRTCContext();

  useReturnHomeOnCallEnd(callStatus);

  // Use a ref to track the current status. This gives the cleanup function
  // access to the latest status value without causing the effect to re-run.
  const statusRef = useRef(callStatus);
  useEffect(() => {
    statusRef.current = callStatus;
  });

  useEffect(() => {
    // This effect should only run ONCE to initiate the call.
    createCall();

    // The cleanup function will run when the component unmounts.
    return () => {
      // Hang up if the user navigates away mid-call so the camera is released
      // and the other peer is notified. (CallPage renders inside this
      // component, so connecting does not unmount it.)
      if (statusRef.current !== "idle" && statusRef.current !== "error") {
        hangUp();
      }
    };
    // The empty dependency array ensures this effect runs only on mount and unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyToClipboard = () => {
    if (!callId) return;
    navigator.clipboard
      .writeText(callId)
      .then(() => toast.success("Call ID copied to clipboard!"));
  };

  if (callStatus === "error") {
    return <ErrorDisplay message={error} />;
  }

  if (callStatus === "connected") {
    return <CallPage />;
  }

  return (
    <Background>
      {/* Show loading for both creating and connecting states */}
      {(callStatus === "creating" || callStatus === "connecting") && (
        <LoadingSpinner text="Creating your call..." />
      )}
      {callStatus === "waiting" && (
        <Card className="w-full max-w-md mx-4 text-center">
          <CardHeader>
            <CardTitle className="text-2xl lg:text-3xl font-bold">
              Video Call
            </CardTitle>
            <CardDescription className="text-muted-foreground lg:text-base">
              Share the code below with your friend to start the call.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center gap-4">
            <div className="bg-white/5 p-3 rounded-lg w-full">
              <span className="font-mono text-lg tracking-widest">
                {callId}
              </span>
            </div>
            <Button onClick={copyToClipboard} className="w-full">
              Copy Call ID
            </Button>
          </CardContent>
        </Card>
      )}
    </Background>
  );
};

export default CreateCallPage;
