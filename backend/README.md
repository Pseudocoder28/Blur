# WebRTC Blur Demo Backend

This backend is a FastAPI server that receives a WebRTC video stream, detects sensitive regions in each frame (text, documents, ID-card-shaped objects and secondary people) and returns the video with those regions blurred.

## Features

- Accepts WebRTC video streams via `/offer` endpoint.
- Detects text with OpenCV (or optionally PaddleOCR) and objects with YOLOv8, in a background thread so the stream stays real time.
- Applies a Gaussian blur only to the detected regions. If processing a frame fails, the whole frame is blurred rather than sent unprocessed.
- Returns the blurred video stream to the client in real time.
- CORS enabled for all origins (for development/testing).
- Works with the React frontend in `../frontend` and the standalone test page (`sample_endpoint.html`).

## Endpoints

- `POST /offer`: Accepts a WebRTC offer (SDP), negotiates a connection, and returns an answer (SDP). The returned stream is the redacted version of the input video. Malformed requests get a `422`, offers that cannot be negotiated a `400`.

## Requirements

- Python 3.10+ (tested on 3.13)
- See `requirements.txt` for dependencies:
  - fastapi
  - uvicorn
  - aiortc
  - opencv-python, numpy
  - av
  - ultralytics (YOLOv8)
  - pytest, pytest-asyncio, httpx (for testing)
  - paddlepaddle, paddleocr (optional, only for `TEXT_DETECTION_METHOD = "paddle"`)

## Running the Backend

1. **Install dependencies:**
   ```
   pip install -r requirements.txt
   ```

2. **Start the FastAPI server:**
   ```
   uvicorn main:app --port 8000
   ```
   This listens on `localhost` only. Add `--host 0.0.0.0` to accept connections from other machines.

3. **Test the endpoint:**
   - Open new terminal to create a beta test server
   - Open sample_endpoint.html (testing server) using:

     ```
     cd backend
     python -m http.server 3000
     ```
   - Go to http://localhost:3000/sample_endpoint.html
   - Click "Start Camera" to begin streaming and see the blurred video returned from the backend.

## Testing

- The tests run in-process, no running server is needed:
  ```
  pytest
  ```

## Notes

- The backend currently allows all CORS origins for easy local development.
- Only video streams are processed; audio is ignored. The React frontend sends audio directly to the other caller, not through this server.
- Frames are processed in memory and never written to disk.
- Detection settings (`TEXT_DETECTION_METHOD`, `ENABLE_OBJECT_DETECTION`, `DEBUG_MODE`) live at the top of `main.py`.
- The YOLO model is loaded once, on the first connection, and shared by all connections. Detection runs on every second frame and the latest results are reused in between.
