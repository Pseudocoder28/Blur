# Blurr Frontend

The 1:1 video call app for Blurr, built with React 19, TypeScript and Vite, and styled with Tailwind CSS and shadcn/ui.

Before your camera video is sent to the other caller, it is routed through the [blur backend](../backend/README.md), which returns a copy with sensitive regions blurred. Only that processed video is sent on, and it is also what you see in your own preview.

## Running

You need Node.js 20.19+ or 22.12+, and the backend running on `http://localhost:8000`.

```bash
npm install
npm run dev
```

Open http://localhost:5173.

| Script | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite dev server |
| `npm run build` | Type-checks with `tsc -b`, then builds to `dist/` |
| `npm run lint` | Runs ESLint |
| `npm run preview` | Serves the production build locally |

## Configuration

* **Backend URL:** copy `.env.example` to `.env` and set `VITE_BACKEND_URL`. It defaults to `http://localhost:8000`.
* **Firebase:** call signaling uses the Firestore project configured in `src/lib/firebase.ts`. Replace that config with your own project's to use a different one. The app does not sign in, so Firestore rules must allow access to the `calls` collection.

## How a call works

1. `startWebcam` opens the camera and microphone, sends the camera video to the backend's `POST /offer` endpoint over WebRTC, and waits for the blurred track to come back. The local stream is that blurred video plus the raw microphone audio.
2. **Create:** `createCall` makes a `calls/{id}` document in Firestore containing a WebRTC offer, then waits for an answer. The document ID is the call ID you share.
3. **Join:** `joinCall` reads the offer, writes back an answer, and the two browsers connect peer-to-peer. ICE candidates are exchanged through the `offerCandidates` and `answerCandidates` subcollections.
4. **Hang up:** either side deleting the call document ends the call for both. The camera, microphone and backend connection are released.

Screen sharing replaces the outgoing camera track with the screen capture directly. It does **not** go through the blur backend.

## Structure

```
src/
  main.tsx                     Routes: /join, /join/:id, /create
  hooks/useWebRTC.ts           All call, signaling and media logic
  hooks/useReturnHomeOnCallEnd.ts
  contexts/WebRTCProvider.tsx  Shares one useWebRTC instance with every page
  pages/                       JoinPage, JoinByIdPage, CreateCallPage, CallPage
  components/                  VideoPlayer, CallControls, ErrorDisplay, ...
  components/ui/               shadcn/ui primitives
  lib/firebase.ts              Firestore setup
```
