# GPT Realtime Translate

A small push-to-talk browser translator using OpenAI Realtime API. It defaults to `gpt-realtime`; set `REALTIME_MODEL` in `.env` if your account has a different realtime translation model ID.

## Run

```bash
cd /Users/kirisame/Projects/gpt-realtime-translate
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm run dev
```

Then open `http://localhost:3000`.

The API key stays on the Node server. The browser receives a short-lived Realtime client secret and connects to OpenAI with WebRTC.

## Notes

- Press and hold the microphone button to speak. Release it and the model speaks the translation.
- Turn on auto listen to keep the microphone open. The Realtime server VAD detects the end of each sentence and translates automatically. Auto listen can continue while the Android app is backgrounded or the phone is locked. Click the center button while auto listen is active to pause; pause fully disconnects Realtime.
- Use the input/output device menus to choose microphones and speakers where the browser or Android system supports it.
- Turn on left/right ears to route English output to the right channel and Chinese output to the left channel.
- Modes: Auto, Chinese to English, English to Chinese.
- The frontend uses WebRTC with audio output and optional input transcription events for the on-screen transcript.

## Android APK

```bash
cd /Users/kirisame/Projects/gpt-realtime-translate
chmod +x android/build-apk.sh
android/build-apk.sh
```

The debug APK is written to `android/build-manual/out/realtime-translate-debug.apk`.

The Android app stores the OpenAI API key in local app preferences after you paste it into the in-app key field. The key is not embedded in the APK.
