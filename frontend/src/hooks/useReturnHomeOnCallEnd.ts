import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { CallStatus } from "./useWebRTC";

// Once a call has been started from a page, send the user back to the join
// screen when it ends (either side hung up) instead of leaving a blank page.
export const useReturnHomeOnCallEnd = (callStatus: CallStatus) => {
  const navigate = useNavigate();
  const wasActive = useRef(false);

  useEffect(() => {
    if (callStatus !== "idle") {
      wasActive.current = true;
    } else if (wasActive.current) {
      navigate("/join", { replace: true });
    }
  }, [callStatus, navigate]);
};
