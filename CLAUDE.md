# Development Notes

This project is a small OpenAI Realtime speech translation app with one shared web frontend and an Android WebView wrapper.

## Architecture

- Web entry point: `public/index.html`
- Frontend logic: `public/app.js`
- Frontend styles: `public/styles.css`
- Web server and Realtime session creation: `server.js`
- Android wrapper: `android/app/src/main/java/com/example/realtimetranslate/MainActivity.java`
- Manual Android build script: `android/build-apk.sh`

The Android app serves the same `public` files from a local HTTP server inside `MainActivity.LocalServer`. The manual APK build passes `-A "$ROOT_DIR/public"` to `aapt2`, so edits to `public/*` are picked up by Android builds without copying files.

## Realtime Flow

1. The browser asks `/api/session?mode=...` for a short-lived Realtime client secret.
2. `server.js` creates the client secret with `POST /v1/realtime/client_secrets`.
3. The frontend creates an `RTCPeerConnection`, data channel, microphone track, and remote audio element.
4. The frontend sends the local SDP offer to `POST https://api.openai.com/v1/realtime/calls`.
5. Realtime events from the data channel update transcript, translation text, status, and audio panning.

Android uses the same flow, but `/api/session` is served by `MainActivity.LocalServer` and the API key is stored in Android `SharedPreferences`.

## Controls And State

- `connectButton` connects or disconnects the active WebRTC session.
- `talkButton` is push-to-talk in manual mode.
- `autoListenButton` enables continuous microphone input with server VAD.
- While auto listening is active, clicking the center `talkButton` pauses by fully disconnecting Realtime, closing the data channel, peer connection, remote audio, and microphone tracks.
- In paused state, clicking the center button reconnects and resumes auto listening.
- `stereoButton` toggles left/right panning. Chinese input routes English output right; English input routes Chinese output left.

Important state variables in `public/app.js`:

- `pc`, `dc`, `micStream`, `micTrack`, `remoteAudio`: active WebRTC/media resources.
- `autoListening`: whether microphone input is currently open for server VAD.
- `paused`: UI pause state after disconnecting from auto listening.
- `pendingAutoListen`: reconnect helper that turns auto listening back on once the data channel opens.
- `selectedInputDeviceId`, `selectedOutputDeviceId`: selected device IDs from the menus.

## Resource Lifecycle

Realtime sessions are intentionally allowed to continue while the Android app is backgrounded or the phone is locked, because the expected use case includes putting the phone in a pocket during auto listen.

The app releases Realtime/media resources when:

- The user taps Disconnect.
- The user taps the center button while auto listen is active, entering pause mode.
- The user changes translation mode.
- The user changes input device while connected, which requires reconnecting the microphone track.
- The web page unloads or the Android activity is destroyed after the app is cleared.

Pause mode fully disconnects Realtime instead of only muting the microphone. Do not add background, page-hidden, idle, or hard session timers without confirming the product behavior again.

## Audio Devices

The web frontend uses:

- `navigator.mediaDevices.enumerateDevices()` for input/output menus.
- `getUserMedia({ audio: { deviceId } })` for browser input selection.
- `HTMLMediaElement.setSinkId()` and `AudioContext.setSinkId()` when available for browser output selection.

Android additionally exposes `AndroidBridge.listAudioDevices(kind)` and `AndroidBridge.selectAudioDevice(value)`:

- `kind` is `input` or `output`.
- `value` is `input:<id>` or `output:<id>`.
- On Android 12+ it uses `AudioManager.setCommunicationDevice`.
- On older Android versions, the menu is still shown but final routing depends on WebView/system behavior.

## Local Development

Run the web app:

```bash
npm run dev
```

The default server URL is `http://127.0.0.1:3000`.

Required environment:

```bash
OPENAI_API_KEY=...
```

Optional:

```bash
PORT=3000
HOST=127.0.0.1
REALTIME_MODEL=gpt-realtime
```

Build the debug APK:

```bash
android/build-apk.sh
```

The APK is written to `android/build-manual/out/realtime-translate-debug.apk`.

## Testing Checklist

- Web: connect, hold-to-talk, release, hear translated audio.
- Web: enable auto listen, click center button to pause, confirm status is paused and Realtime is disconnected.
- Web: click center button again, confirm auto listen resumes after reconnect.
- Web: change input device while connected, confirm reconnect happens.
- Web: change output device and confirm playback route when the browser supports sink selection.
- Android: save API key, connect, use auto listen, pause/resume with center button.
- Android: verify input/output menus are populated and route devices where the OS supports it.
- Android: background the app and confirm the Realtime session disconnects.
