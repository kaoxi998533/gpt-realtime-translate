const connectButton = document.querySelector("#connectButton");
const talkButton = document.querySelector("#talkButton");
const autoListenButton = document.querySelector("#autoListenButton");
const stereoButton = document.querySelector("#stereoButton");
const inputDeviceSelect = document.querySelector("#inputDeviceSelect");
const outputDeviceSelect = document.querySelector("#outputDeviceSelect");
const nativeInputTestButton = document.querySelector("#nativeInputTestButton");
const keyRow = document.querySelector("#keyRow");
const apiKeyInput = document.querySelector("#apiKeyInput");
const saveKeyButton = document.querySelector("#saveKeyButton");
const hint = document.querySelector("#hint");
const statusEl = document.querySelector("#status");
const sourceText = document.querySelector("#sourceText");
const translationText = document.querySelector("#translationText");
const eventLog = document.querySelector("#eventLog");
const micIcon = document.querySelector(".mic");
const modeButtons = [...document.querySelectorAll(".mode")];

let mode = "auto";
let pc;
let dc;
let micStream;
let micTrack;
let remoteAudio;
let audioContext;
let remoteSource;
let stereoPanner;
let mediaRecorder;
let recordedChunks = [];
let debugConnected = false;
let playbackUrl = "";
let currentTranslation = "";
let autoListening = false;
let stereoRouting = false;
let paused = false;
let pendingAutoListen = false;
let nextOutputPan = 0;
let selectedInputDeviceId = "";
let selectedOutputDeviceId = "";
let selectedInputLabel = "";
let nativeInputDeviceId = "";
let nativeInputActive = false;
let nativeInputSending = false;
const isAndroidApp = Boolean(window.AndroidBridge);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text, state = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${state}`.trim();
}

function logEvent(event) {
  const line = `[${new Date().toLocaleTimeString()}] ${event.type}`;
  eventLog.textContent = `${line}\n${eventLog.textContent}`.slice(0, 7000);
}

function logDebug(type, details = {}) {
  const event = { type, ...details };
  const serialized = JSON.stringify(event);
  eventLog.textContent = `[${new Date().toLocaleTimeString()}] ${serialized}\n${eventLog.textContent}`.slice(0, 7000);
  try {
    window.AndroidBridge?.log?.(serialized, "");
  } catch {
    // Native log forwarding is best-effort diagnostics only.
  }
}

function setMode(nextMode) {
  mode = nextMode;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  if (isConnected()) {
    disconnect();
    hint.textContent = "模式已切换，请重新连接。";
  }
}

function isDebugMode() {
  return mode === "debug";
}

function isConnected() {
  return Boolean(pc || debugConnected);
}

function shouldUseNativeInput() {
  return isAndroidApp && !isDebugMode() && Boolean(nativeInputDeviceId);
}

function inputReady() {
  return shouldUseNativeInput() ? nativeInputActive : Boolean(micTrack);
}

function cleanupMedia() {
  if (micTrack) micTrack.stop();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  micTrack = null;
  micStream = null;
}

function resetConnectedControls() {
  autoListening = false;
  talkButton.disabled = true;
  autoListenButton.disabled = true;
  autoListenButton.classList.remove("active");
  autoListenButton.setAttribute("aria-pressed", "false");
  talkButton.classList.remove("recording", "auto-listening");
  micIcon.textContent = "🎙";
}

function disconnect(options = {}) {
  const keepPaused = Boolean(options.keepPaused);
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  if (dc) dc.close();
  if (pc) pc.close();
  if (remoteSource) remoteSource.disconnect();
  if (stereoPanner) stereoPanner.disconnect();
  if (remoteAudio) remoteAudio.remove();
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  stopNativeInputStream();
  cleanupMedia();
  pc = null;
  dc = null;
  mediaRecorder = null;
  recordedChunks = [];
  debugConnected = false;
  remoteAudio = null;
  remoteSource = null;
  stereoPanner = null;
  playbackUrl = "";
  resetConnectedControls();
  connectButton.disabled = false;
  connectButton.textContent = "连接";

  if (keepPaused) {
    paused = true;
    talkButton.disabled = false;
    talkButton.classList.add("paused");
    talkButton.setAttribute("aria-label", "恢复自动监听");
    micIcon.textContent = "▶";
    setStatus("已暂停", "paused");
    translationText.textContent = "已暂停";
    hint.textContent = "已暂停并断开 Realtime。点击中间按钮恢复自动监听。";
  } else {
    paused = false;
    pendingAutoListen = false;
    talkButton.classList.remove("paused");
    talkButton.setAttribute("aria-label", "按住说话");
    setStatus("未连接");
  }
}

function selectedInputConstraint() {
  const deviceId = selectedInputDeviceId;
  const constraint = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
  logDebug("audio.input_constraint", {
    selectedInputDeviceId: deviceId || "default",
    selectedInputLabel: inputDeviceSelect.selectedOptions[0]?.textContent || "",
    constraint,
  });
  return constraint;
}

function shouldRetryConnect(error) {
  const message = String(error?.message || "");
  return !/api key|client secret|当前浏览器不支持|Missing OpenAI/i.test(message);
}

async function connect(options = {}) {
  const retries = options.retries ?? 1;
  connectButton.disabled = true;
  connectButton.textContent = "连接中";
  setStatus("连接中");
  hint.textContent = isDebugMode() ? "正在请求麦克风权限。" : "正在请求麦克风权限并创建 Realtime 会话。";

  try {
    if (isDebugMode()) {
      await connectDebug();
      return;
    }

    if (isAndroidApp) {
      const hasKey = await androidCall("hasApiKey");
      if (!hasKey) {
        throw new Error("请先保存 OpenAI API key");
      }
    }

    const tokenResponse = await fetch(`/api/session?mode=${encodeURIComponent(mode)}`);
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(tokenData.error?.message || tokenData.error || "创建 session 失败");
    }

    const ephemeralKey = tokenData.value || tokenData.client_secret?.value;
    if (!ephemeralKey) {
      throw new Error("OpenAI 响应里没有 client secret");
    }

    pc = new RTCPeerConnection();
    dc = pc.createDataChannel("oai-events");
    currentTranslation = "";
    translationText.textContent = "等待输出";
    sourceText.textContent = "等待语音输入";

    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    document.body.append(remoteAudio);
    setupAudioRouting();
    await applyOutputDevice();

    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      remoteAudio.play().catch(() => {});
    };

    dc.addEventListener("open", () => {
      paused = false;
      setStatus("已连接", "ready");
      talkButton.disabled = false;
      talkButton.classList.remove("paused");
      talkButton.setAttribute("aria-label", "按住说话");
      autoListenButton.disabled = false;
      connectButton.textContent = "断开";
      connectButton.disabled = false;
      hint.textContent = shouldUseNativeInput()
        ? "正在使用 Android 原生 DJI 输入。按住麦克风说话，或打开自动监听。"
        : "按住麦克风说话，或打开自动监听。";
      if (pendingAutoListen) {
        pendingAutoListen = false;
        setAutoListening(true);
      }
    });

    dc.addEventListener("message", (message) => {
      const event = JSON.parse(message.data);
      logEvent(event);
      handleRealtimeEvent(event);
    });

    if (isAndroidApp && !isDebugMode()) {
      const warmup = await androidCall("warmUpAudioRoute");
      logDebug("android.audio_warmup", warmup || {});
      await delay(160);
    }
    await refreshAudioDevices();
    if (shouldUseNativeInput()) {
      pc.addTransceiver("audio", { direction: "recvonly" });
      const nativeStarted = await androidCall("startInputStream", nativeInputDeviceId);
      if (!nativeStarted?.ok) {
        throw new Error(`原生 DJI 输入启动失败：${nativeStarted?.error || "未知错误"}`);
      }
      nativeInputActive = true;
      logDebug("native_input.start", nativeStarted);
    } else {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: selectedInputConstraint(),
      });
      await refreshAudioDevices();
      micTrack = micStream.getAudioTracks()[0];
      reportActiveInputDevice("realtime");
      micTrack.enabled = false;
      pc.addTrack(micTrack, micStream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
  } catch (error) {
    disconnect();
    if (retries > 0 && shouldRetryConnect(error)) {
      setStatus("重试中");
      hint.textContent = `连接失败，正在重试：${error.message}`;
      await delay(650);
      return connect({ retries: retries - 1 });
    }
    setStatus("错误", "error");
    hint.textContent = error.message;
  }
}

async function connectDebug() {
  if (!window.MediaRecorder) {
    throw new Error("当前浏览器不支持本地录音回放。");
  }

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: selectedInputConstraint(),
  });
  await refreshAudioDevices();
  micTrack = micStream.getAudioTracks()[0];
  reportActiveInputDevice("debug");
  micTrack.enabled = false;

  remoteAudio = document.createElement("audio");
  remoteAudio.autoplay = true;
  remoteAudio.addEventListener("ended", () => {
    if (!isDebugMode() || !debugConnected) return;
    translationText.textContent = "播放完成";
    hint.textContent = "按住麦克风可以再次测试。";
  });
  document.body.append(remoteAudio);
  setupAudioRouting();
  await applyOutputDevice();

  debugConnected = true;
  paused = false;
  currentTranslation = "";
  sourceText.textContent = "等待麦克风输入";
  translationText.textContent = "松开后播放录音";
  setStatus("测试模式", "ready");
  talkButton.disabled = false;
  talkButton.classList.remove("paused");
  talkButton.setAttribute("aria-label", "按住测试麦克风");
  autoListenButton.disabled = true;
  connectButton.textContent = "断开";
  connectButton.disabled = false;
  hint.textContent = "麦克风测试模式不会调用 API。按住录音，松开后播放刚才的声音。";
}

function handleRealtimeEvent(event) {
  if (event.type === "input_audio_buffer.speech_started" && autoListening) {
    currentTranslation = "";
    nextOutputPan = 0;
    applyOutputPan();
    translationText.textContent = "正在听";
    hint.textContent = "检测到语音，说完停顿一下会自动翻译。";
  }

  if (event.type === "input_audio_buffer.speech_stopped" && autoListening) {
    hint.textContent = "检测到停顿，正在翻译。";
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    sourceText.textContent = event.transcript || "未识别到文字";
    nextOutputPan = detectPanForTranscript(event.transcript || "");
  }

  if (event.type === "response.output_audio_transcript.delta") {
    currentTranslation += event.delta || "";
    nextOutputPan = detectPanForOutput(currentTranslation);
    applyOutputPan();
    translationText.textContent = currentTranslation || "正在翻译";
  }

  if (event.type === "response.output_audio_transcript.done") {
    currentTranslation = event.transcript || currentTranslation;
    translationText.textContent = currentTranslation || "翻译完成";
  }

  if (event.type === "response.created") {
    currentTranslation = "";
    translationText.textContent = "正在翻译";
    applyOutputPan();
  }

  if (event.type === "error") {
    setStatus("错误", "error");
    hint.textContent = event.error?.message || "Realtime API error";
  }
}

function detectPanForTranscript(transcript) {
  if (!stereoRouting || !transcript) return 0;
  return /[\u3400-\u9fff]/.test(transcript) ? 1 : -1;
}

function detectPanForOutput(text) {
  if (!stereoRouting || !text) return nextOutputPan;
  return /[\u3400-\u9fff]/.test(text) ? -1 : 1;
}

function setupAudioRouting() {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
  if (!remoteAudio || remoteSource) return;
  remoteSource = audioContext.createMediaElementSource(remoteAudio);
  stereoPanner = audioContext.createStereoPanner();
  remoteSource.connect(stereoPanner).connect(audioContext.destination);
  applyOutputPan();
}

function applyOutputPan() {
  if (!stereoPanner) return;
  stereoPanner.pan.value = stereoRouting ? nextOutputPan : 0;
}

function startTalking(event) {
  if (paused || !inputReady() || talkButton.disabled || autoListening) return;
  event.preventDefault();
  currentTranslation = "";
  translationText.textContent = isDebugMode() ? "正在录音" : "等待你说完";
  if (shouldUseNativeInput()) {
    nativeInputSending = true;
  } else {
    micTrack.enabled = true;
  }
  talkButton.classList.add("recording");
  hint.textContent = isDebugMode() ? "正在录音，松开后会立刻回放。" : "正在听，松开后翻译。";

  if (isDebugMode()) {
    startDebugRecording();
  }
}

function stopTalking(event) {
  if (paused || !inputReady() || talkButton.disabled || autoListening) return;
  event.preventDefault();
  if (shouldUseNativeInput()) {
    nativeInputSending = false;
  } else {
    micTrack.enabled = false;
  }
  talkButton.classList.remove("recording");
  if (isDebugMode()) {
    stopDebugRecording();
    return;
  }
  if (shouldUseNativeInput()) {
    sendRealtimeEvent({ type: "input_audio_buffer.commit" });
    sendRealtimeEvent({ type: "response.create" });
  }
  hint.textContent = "处理中。";
}

function startDebugRecording() {
  if (!micStream || mediaRecorder?.state === "recording") return;
  if (playbackUrl) {
    URL.revokeObjectURL(playbackUrl);
    playbackUrl = "";
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  });
  mediaRecorder.addEventListener("stop", () => {
    playDebugRecording();
  });
  mediaRecorder.start();
  sourceText.textContent = "正在录音";
}

function stopDebugRecording() {
  if (mediaRecorder?.state === "recording") {
    hint.textContent = "正在准备回放。";
    mediaRecorder.stop();
  } else {
    hint.textContent = "没有录到声音，请再试一次。";
  }
}

function playDebugRecording() {
  if (!recordedChunks.length || !remoteAudio) {
    sourceText.textContent = "未录到音频";
    translationText.textContent = "请检查麦克风权限或输入设备";
    hint.textContent = "没有录到声音，请确认麦克风已授权并选择了正确输入设备。";
    return;
  }

  const recording = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  playbackUrl = URL.createObjectURL(recording);
  remoteAudio.srcObject = null;
  remoteAudio.src = playbackUrl;
  remoteAudio.currentTime = 0;
  sourceText.textContent = "已录到麦克风声音";
  translationText.textContent = "正在播放录音";
  hint.textContent = "正在播放刚才的输入声音。";
  remoteAudio.play().catch((error) => {
    hint.textContent = `播放失败：${error.message}`;
  });
}

function setAutoListening(nextValue) {
  if (!inputReady() || autoListenButton.disabled) return;
  autoListening = nextValue;
  if (shouldUseNativeInput()) {
    nativeInputSending = autoListening;
  } else {
    micTrack.enabled = autoListening;
  }
  autoListenButton.classList.toggle("active", autoListening);
  autoListenButton.setAttribute("aria-pressed", String(autoListening));
  talkButton.classList.toggle("auto-listening", autoListening);
  talkButton.classList.remove("recording");
  talkButton.setAttribute("aria-label", autoListening ? "暂停自动监听" : "按住说话");
  micIcon.textContent = autoListening ? "⏸" : "🎙";

  if (autoListening) {
    currentTranslation = "";
    hint.textContent = shouldUseNativeInput()
      ? "自动监听已开启，正在从 DJI 原生输入发送音频。点击中间按钮暂停。"
      : "自动监听已开启，说完一句话后会自动翻译。点击中间按钮暂停。";
    translationText.textContent = "正在监听";
  } else {
    hint.textContent = "自动监听已关闭，可以按住麦克风说话。";
    translationText.textContent = "等待输出";
  }
}

function pauseAutoListening() {
  if (!autoListening) return;
  pendingAutoListen = true;
  disconnect({ keepPaused: true });
}

async function resumeAutoListening() {
  if (!paused) return;
  pendingAutoListen = true;
  await connect({ retries: 1 });
}

function setStereoRouting(nextValue) {
  stereoRouting = nextValue;
  stereoButton.classList.toggle("active", stereoRouting);
  stereoButton.setAttribute("aria-pressed", String(stereoRouting));
  if (!stereoRouting) nextOutputPan = 0;
  applyOutputPan();
  hint.textContent = stereoRouting
    ? "左右耳已开启：中文输入的英文翻译走右耳，英文输入的中文翻译走左耳。"
    : "左右耳已关闭，翻译会双声道播放。";
}

function deviceLabel(device, fallback) {
  return device.label || fallback;
}

function replaceOptions(select, devices, defaultLabel) {
  const currentValue = select.value;
  select.replaceChildren(new Option(defaultLabel, ""));
  devices.forEach((device, index) => {
    select.append(new Option(deviceLabel(device, `${defaultLabel} ${index + 1}`), device.deviceId));
  });
  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function restoreInputSelectionByLabel() {
  if (!selectedInputDeviceId || [...inputDeviceSelect.options].some((option) => option.value === selectedInputDeviceId)) {
    return;
  }
  const normalizedLabel = selectedInputLabel.trim().toLowerCase();
  if (!normalizedLabel) return;
  const matchedOption = [...inputDeviceSelect.options].find((option) => {
    const label = option.textContent.trim().toLowerCase();
    return label === normalizedLabel || label.includes(normalizedLabel) || normalizedLabel.includes(label);
  });
  if (!matchedOption) return;
  selectedInputDeviceId = matchedOption.value;
  inputDeviceSelect.value = selectedInputDeviceId;
  logDebug("audio.input_remapped_by_label", {
    selectedInputLabel,
    selectedInputDeviceId,
  });
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const browserInputs = devices.filter((device) => device.kind === "audioinput");
  logDebug("audio.devices", {
    inputs: browserInputs
      .map((device) => ({
        label: device.label || "(no label)",
        deviceId: device.deviceId,
        groupId: device.groupId,
      })),
  });
  if (isAndroidApp) {
    const nativeInputs = (await androidCall("listAudioDevices", "input")) || [];
    const nativeWirelessMic = nativeInputs.find((device) => /wireless mic rx|dji/i.test(device.label || ""));
    nativeInputDeviceId = nativeWirelessMic?.deviceId || "";
    logDebug("android.audio.inputs", {
      inputs: nativeInputs.map((device) => ({
        label: device.label || "(no label)",
        deviceId: device.deviceId,
      })),
    });
    if (nativeInputTestButton) {
      nativeInputTestButton.hidden = !nativeWirelessMic;
      nativeInputTestButton.dataset.deviceId = nativeWirelessMic?.deviceId || "";
      nativeInputTestButton.textContent = nativeWirelessMic
        ? `测试 ${nativeWirelessMic.label} 原生输入`
        : "测试 DJI 原生输入";
    }
    const nativeHasWirelessMic = Boolean(nativeWirelessMic);
    const browserHasWirelessMic = browserInputs.some((device) => /wireless mic rx|dji/i.test(device.label || ""));
    if (nativeHasWirelessMic && !browserHasWirelessMic) {
      hint.textContent = "Android 系统能看到 Wireless Mic Rx，但 WebView 没把它暴露为浏览器麦克风。详情见事件日志。";
    }
  }
  replaceOptions(
    inputDeviceSelect,
    browserInputs,
    isAndroidApp ? "浏览器默认输入" : "系统默认输入",
  );
  restoreInputSelectionByLabel();
  replaceOptions(
    outputDeviceSelect,
    isAndroidApp
      ? ((await androidCall("listAudioDevices", "output")) || [])
      : devices.filter((device) => device.kind === "audiooutput"),
    isAndroidApp ? "Android 默认输出" : "系统默认输出",
  );
  inputDeviceSelect.value = selectedInputDeviceId;
  outputDeviceSelect.value = selectedOutputDeviceId;
}

function reportActiveInputDevice(context) {
  if (!micTrack) return;
  const settings = micTrack.getSettings ? micTrack.getSettings() : {};
  const selectedOption = inputDeviceSelect.selectedOptions[0];
  const selectedLabel = selectedOption?.textContent || "系统默认输入";
  const actualDeviceId = settings.deviceId || "";
  const selectedDeviceId = selectedInputDeviceId || "";
  const matched =
    !selectedDeviceId ||
    !actualDeviceId ||
    actualDeviceId === selectedDeviceId;

  logDebug("audio.active_input", {
    context,
    selectedLabel,
    selectedDeviceId: selectedDeviceId || "default",
    actualDeviceId: actualDeviceId || "(not reported)",
    settings,
    matched,
  });

  if (selectedDeviceId && actualDeviceId && actualDeviceId !== selectedDeviceId) {
    hint.textContent = `浏览器没有使用所选麦克风：已选 ${selectedLabel}，实际 deviceId 不一致。详情见事件日志。`;
  } else if (selectedDeviceId) {
    hint.textContent = `正在使用 WebView 输入设备：${selectedLabel}`;
  }
}

async function applyOutputDevice() {
  if (isAndroidApp) {
    await selectAndroidAudioDevice(`output:${selectedOutputDeviceId}`);
    return;
  }
  try {
    if (audioContext?.setSinkId) {
      await audioContext.setSinkId(selectedOutputDeviceId || "");
    }
    if (remoteAudio?.setSinkId) {
      await remoteAudio.setSinkId(selectedOutputDeviceId);
    } else if (selectedOutputDeviceId && !isAndroidApp) {
      hint.textContent = "当前浏览器不支持网页内切换输出设备。";
    }
  } catch (error) {
    hint.textContent = `输出设备切换失败：${error.message}`;
  }
}

async function selectAndroidAudioDevice(value) {
  if (!isAndroidApp) return true;
  let selected = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    selected = Boolean(await androidCall("selectAudioDevice", value));
    if (selected) return true;
    await delay(180 * (attempt + 1));
  }
  hint.textContent = "音频设备切换可能未生效，请确认设备已连接后重试。";
  return false;
}

function androidCall(method, value = "") {
  return new Promise((resolve, reject) => {
    if (!window.AndroidBridge?.[method]) {
      resolve(null);
      return;
    }
    const callbackName = `androidCallback_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    window[callbackName] = (result) => {
      delete window[callbackName];
      try {
        resolve(JSON.parse(result));
      } catch {
        resolve(result);
      }
    };
    try {
      window.AndroidBridge[method](String(value), callbackName);
    } catch (error) {
      delete window[callbackName];
      reject(error);
    }
  });
}

function sendRealtimeEvent(event) {
  if (dc?.readyState !== "open") return false;
  dc.send(JSON.stringify(event));
  return true;
}

function stopNativeInputStream() {
  nativeInputSending = false;
  nativeInputActive = false;
  if (isAndroidApp) {
    androidCall("stopInputStream").catch(() => {});
  }
}

window.__androidNativeAudioChunk = (audio) => {
  if (!nativeInputSending || dc?.readyState !== "open") return;
  sendRealtimeEvent({
    type: "input_audio_buffer.append",
    audio,
  });
};

window.__androidNativeAudioStatus = (payload) => {
  try {
    logDebug("android.native_input_status", JSON.parse(payload));
  } catch {
    logDebug("android.native_input_status", { payload });
  }
};

async function initAndroidKeyControls() {
  if (!isAndroidApp) return;
  keyRow.hidden = false;
  const hasKey = await androidCall("hasApiKey");
  apiKeyInput.placeholder = hasKey ? "API key 已保存，输入新 key 可覆盖" : "粘贴 OpenAI API key";
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

connectButton.addEventListener("click", () => {
  if (isConnected()) {
    disconnect();
    hint.textContent = "已断开。";
    return;
  }
  connect({ retries: 1 });
});

autoListenButton.addEventListener("click", () => {
  setAutoListening(!autoListening);
});

stereoButton.addEventListener("click", () => {
  setStereoRouting(!stereoRouting);
});

inputDeviceSelect.addEventListener("change", async () => {
  selectedInputDeviceId = inputDeviceSelect.value;
  selectedInputLabel = inputDeviceSelect.selectedOptions[0]?.textContent || "";
  if (isConnected()) {
    const resumeAuto = autoListening;
    disconnect();
    pendingAutoListen = resumeAuto;
    connect({ retries: 1 });
  } else {
    hint.textContent = isAndroidApp
      ? "输入设备已选择，下次连接时由 WebView 麦克风约束生效。"
      : "输入设备已选择，下次连接生效。";
  }
});

outputDeviceSelect.addEventListener("change", async () => {
  selectedOutputDeviceId = outputDeviceSelect.value;
  await applyOutputDevice();
  hint.textContent = "输出设备已切换。";
});

nativeInputTestButton?.addEventListener("click", async () => {
  const deviceId = nativeInputTestButton.dataset.deviceId;
  if (!deviceId) return;
  nativeInputTestButton.disabled = true;
  hint.textContent = "正在用 Android 原生录音测试 DJI，请对着 DJI 说话。";
  try {
    const result = await androidCall("testInputDevice", deviceId);
    logDebug("android.input_test", result || {});
    if (!result?.ok) {
      hint.textContent = `原生输入测试失败：${result?.error || "未知错误"}`;
    } else if (result.routed?.deviceId !== result.requested?.deviceId) {
      hint.textContent = `原生录音没有路由到 DJI，实际路由：${result.routed?.label || "未知"}`;
    } else if (Number(result.peak || 0) < 0.01) {
      hint.textContent = "原生录音已路由到 DJI，但电平很低，请确认 DJI 发射端未静音。";
    } else {
      hint.textContent = `原生录音已路由到 DJI，peak=${Number(result.peak).toFixed(3)}。`;
    }
  } catch (error) {
    hint.textContent = `原生输入测试异常：${error.message}`;
  } finally {
    nativeInputTestButton.disabled = false;
  }
});

saveKeyButton.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    hint.textContent = "请输入 API key。";
    return;
  }
  await androidCall("saveApiKey", key);
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "API key 已保存，输入新 key 可覆盖";
  hint.textContent = "API key 已保存到手机本地。";
});

talkButton.addEventListener("click", () => {
  if (paused) {
    resumeAutoListening();
  } else if (autoListening) {
    pauseAutoListening();
  }
});
talkButton.addEventListener("pointerdown", startTalking);
talkButton.addEventListener("pointerup", stopTalking);
talkButton.addEventListener("pointercancel", stopTalking);
talkButton.addEventListener("pointerleave", (event) => {
  if (talkButton.classList.contains("recording")) stopTalking(event);
});

navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioDevices);
window.addEventListener("beforeunload", () => disconnect());
window.realtimeTranslateDisconnect = () => {
  disconnect();
  hint.textContent = "应用已进入后台，Realtime 已断开。";
};
initAndroidKeyControls();
refreshAudioDevices();
