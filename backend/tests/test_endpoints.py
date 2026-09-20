from fractions import Fraction

import numpy as np
import pytest
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from av import VideoFrame
from fastapi.testclient import TestClient

import main
from main import app, VideoProcessingTrack

client = TestClient(app)


# Dummy video track for testing (sends blank frames)
class DummyVideoTrack(MediaStreamTrack):
    kind = "video"

    async def recv(self):
        # Create a simple black frame (480x640)
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        frame = VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts = 0
        frame.time_base = Fraction(1, 30)
        return frame


def make_noise_image():
    rng = np.random.default_rng(0)
    return rng.integers(0, 256, size=(480, 640, 3), dtype=np.uint8)


@pytest.fixture
def processing_track(monkeypatch):
    # Skip loading YOLO; these tests drive the cached detections directly
    monkeypatch.setattr(main, "ENABLE_OBJECT_DETECTION", False)
    track = VideoProcessingTrack(DummyVideoTrack(), blur_strength=41)
    yield track
    track.cleanup()


@pytest.mark.asyncio
async def test_offer_with_real_pc():
    pc = RTCPeerConnection()
    pc.addTrack(DummyVideoTrack())

    try:
        # Create offer
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        # Send offer to backend
        response = client.post("/offer", json={
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        })
        assert response.status_code == 200

        # Parse backend answer
        answer = response.json()
        remote_desc = RTCSessionDescription(sdp=answer["sdp"], type=answer["type"])
        await pc.setRemoteDescription(remote_desc)

        # Assert that remote description was accepted
        assert pc.remoteDescription is not None
        assert pc.remoteDescription.type == "answer"
    finally:
        await pc.close()


def test_offer_rejects_missing_fields():
    response = client.post("/offer", json={"type": "offer"})
    assert response.status_code == 422


def test_offer_rejects_wrong_type():
    response = client.post("/offer", json={"sdp": "v=0", "type": "answer"})
    assert response.status_code == 422


def test_offer_rejects_invalid_sdp():
    response = client.post("/offer", json={"sdp": "not an sdp", "type": "offer"})
    assert response.status_code == 400


def test_process_frame_blurs_only_text_regions(processing_track):
    image = make_noise_image()
    processing_track.cached_text_boxes = [(100, 100, 200, 40)]

    result = processing_track.process_frame(image)

    assert result.shape == image.shape
    # Inside the box the noise is smoothed out
    assert result[100:140, 100:300].std() < image[100:140, 100:300].std() / 2
    # Far away from the box the frame is untouched
    assert np.array_equal(result[300:, :], image[300:, :])


def test_process_frame_without_detections_is_passthrough(processing_track):
    image = make_noise_image()
    result = processing_track.process_frame(image)
    assert np.array_equal(result, image)


def test_process_frame_fails_closed(processing_track):
    image = make_noise_image()
    # A malformed box makes processing raise; the frame must not leak through
    processing_track.cached_text_boxes = [("bad",)]

    result = processing_track.process_frame(image)

    assert result.shape == image.shape
    assert result.std() < image.std() / 2
