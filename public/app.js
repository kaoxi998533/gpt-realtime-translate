const connectButton = document.querySelector("#connectButton");
const talkButton = document.querySelector("#talkButton");
const autoListenButton = document.querySelector("#autoListenButton");
const stereoButton = document.querySelector("#stereoButton");
const inputDeviceSelect = document.querySelector("#inputDeviceSelect");
const outputDeviceSelect = document.querySelector("#outputDeviceSelect");
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

const MAX_SESSION_MS = 9 * 60 * 1000;
const AUTO_IDLE_MS = 2 * 60 * 1000;
const CONNECTED_IDLE_MS = 5 * 60 * 1000;
const HIDDEN_DISCONNECT_MS = 30 * 1000;

let mode = "auto";
let pc;
let dc;
let micStream;
let micTrack;
let remoteAudio;
let audioContext;
let remoteSource;
let stereoPanner;
let currentTranslation = "";
let autoListening = false;
let stereoRouting = false;
let paused = false;
let pendingAutoListen = false;
let nextOutputPan = 0;
let sessionTimer;
let idleTimer;
let hiddenTimer;
let selectedInputDeviceId = "";
let selectedOutputDeviceId = "";
const isAndroidApp = Boolean(window.AndroidBridge);

function setStatus(text, state = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${state}`.trim();
}

function logEvent(event) {
  const line = `[${new Date().toLocaleTimeString()}] ${event.type}`;
  eventLog.textContent = `${line}\n${eventLog.textContent}`.slice(0, 7000);
}

function resetTimers() {
  clearTimeout(sessionTimer);
  clearTimeout(idleTimer);
  clearTimeout(hiddenTimer);
}

function refreshIdleTimer() {
  clearTimeout(idleTimer);
  if (!pc) return;
  const timeout = autoListening ? AUTO_IDLE_MS : CONNECTED_IDLE_MS;
  idleTimer = setTimeout(() => {
    const wasAutoListening = autoListening;
    disconnect();
    hint.textContent = wasAutoListening
      ? "自动监听空闲超过 2 分钟，已自动断开以避免继续占用 token。"
      : "连接空闲超过 5 分钟，已自动断开。";
  }, timeout);
}

function setMode(nextMode) {
  mode = nextMode;
  modeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  if (pc) {
    disconnect();
    hint.textContent = "模式已切换，请重新连接。";
  }
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
  resetTimers();
  if (dc) dc.close();
  if (pc) pc.close();
  if (remoteSource) remoteSource.disconnect();
  if (stereoPanner) stereoPanner.disconnect();
  if (remoteAudio) remoteAudio.remove();
  cleanupMedia();
  pc = null;
  dc = null;
  remoteAudio = null;
  remoteSource = null;
  stereoPanner = null;
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
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId && !isAndroidApp ? { deviceId: { exact: deviceId } } : {}),
  };
}

async function connect() {
  connectButton.disabled = true;
  connectButton.textContent = "连接中";
  setStatus("连接中");
  hint.textContent = "正在请求麦克风权限并创建 Realtime 会话。";

  try {
    if (isAndroidApp) {
      const hasKey = await androidCall("hasApiKey");
      if (!hasKey) {
        throw new Error("请先保存 OpenAI API key");
      }
      if (selectedInputDeviceId) await androidCall("selectAudioDevice", `input:${selectedInputDeviceId}`);
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
      hint.textContent = "按住麦克风说话，或打开自动监听。";
      sessionTimer = setTimeout(() => {
        disconnect();
        hint.textContent = "本次 Realtime 会话已达到 9 分钟上限，已自动断开。";
      }, MAX_SESSION_MS);
      refreshIdleTimer();
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

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: selectedInputConstraint(),
    });

    await refreshAudioDevices();
    micTrack = micStream.getAudioTracks()[0];
    micTrack.enabled = false;
    pc.addTrack(micTrack, micStream);

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
    setStatus("错误", "error");
    hint.textContent = error.message;
  }
}

function handleRealtimeEvent(event) {
  if (event.type === "input_audio_buffer.speech_started" && autoListening) {
    currentTranslation = "";
    nextOutputPan = 0;
    applyOutputPan();
    translationText.textContent = "正在听";
    hint.textContent = "检测到语音，说完停顿一下会自动翻译。";
    refreshIdleTimer();
  }

  if (event.type === "input_audio_buffer.speech_stopped" && autoListening) {
    hint.textContent = "检测到停顿，正在翻译。";
    refreshIdleTimer();
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    sourceText.textContent = event.transcript || "未识别到文字";
    nextOutputPan = detectPanForTranscript(event.transcript || "");
    refreshIdleTimer();
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
    refreshIdleTimer();
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
  if (paused || !micTrack || talkButton.disabled || autoListening) return;
  event.preventDefault();
  currentTranslation = "";
  translationText.textContent = "等待你说完";
  micTrack.enabled = true;
  talkButton.classList.add("recording");
  hint.textContent = "正在听，松开后翻译。";
  refreshIdleTimer();
}

function stopTalking(event) {
  if (paused || !micTrack || talkButton.disabled || autoListening) return;
  event.preventDefault();
  micTrack.enabled = false;
  talkButton.classList.remove("recording");
  hint.textContent = "处理中。";
  refreshIdleTimer();
}

function setAutoListening(nextValue) {
  if (!micTrack || autoListenButton.disabled) return;
  autoListening = nextValue;
  micTrack.enabled = autoListening;
  autoListenButton.classList.toggle("active", autoListening);
  autoListenButton.setAttribute("aria-pressed", String(autoListening));
  talkButton.classList.toggle("auto-listening", autoListening);
  talkButton.classList.remove("recording");
  talkButton.setAttribute("aria-label", autoListening ? "暂停自动监听" : "按住说话");
  micIcon.textContent = autoListening ? "⏸" : "🎙";

  if (autoListening) {
    currentTranslation = "";
    hint.textContent = "自动监听已开启，说完一句话后会自动翻译。点击中间按钮暂停。";
    translationText.textContent = "正在监听";
  } else {
    hint.textContent = "自动监听已关闭，可以按住麦克风说话。";
    translationText.textContent = "等待输出";
  }
  refreshIdleTimer();
}

function pauseAutoListening() {
  if (!autoListening) return;
  pendingAutoListen = true;
  disconnect({ keepPaused: true });
}

async function resumeAutoListening() {
  if (!paused) return;
  pendingAutoListen = true;
  await connect();
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

async function refreshAudioDevices() {
  if (isAndroidApp) {
    const inputDevices = (await androidCall("listAudioDevices", "input")) || [];
    const outputDevices = (await androidCall("listAudioDevices", "output")) || [];
    replaceOptions(inputDeviceSelect, inputDevices, "系统默认输入");
    replaceOptions(outputDeviceSelect, outputDevices, "系统默认输出");
    inputDeviceSelect.value = selectedInputDeviceId;
    outputDeviceSelect.value = selectedOutputDeviceId;
    return;
  }

  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  replaceOptions(
    inputDeviceSelect,
    devices.filter((device) => device.kind === "audioinput"),
    "系统默认输入",
  );
  replaceOptions(
    outputDeviceSelect,
    devices.filter((device) => device.kind === "audiooutput"),
    "系统默认输出",
  );
  inputDeviceSelect.value = selectedInputDeviceId;
  outputDeviceSelect.value = selectedOutputDeviceId;
}

async function applyOutputDevice() {
  if (isAndroidApp) {
    await androidCall("selectAudioDevice", `output:${selectedOutputDeviceId}`);
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
  if (pc) {
    disconnect();
    hint.textContent = "已断开。";
    return;
  }
  connect();
});

autoListenButton.addEventListener("click", () => {
  setAutoListening(!autoListening);
});

stereoButton.addEventListener("click", () => {
  setStereoRouting(!stereoRouting);
});

inputDeviceSelect.addEventListener("change", async () => {
  selectedInputDeviceId = inputDeviceSelect.value;
  if (isAndroidApp) await androidCall("selectAudioDevice", `input:${selectedInputDeviceId}`);
  if (pc) {
    const resumeAuto = autoListening;
    disconnect();
    pendingAutoListen = resumeAuto;
    connect();
  } else {
    hint.textContent = "输入设备已选择，下次连接生效。";
  }
});

outputDeviceSelect.addEventListener("change", async () => {
  selectedOutputDeviceId = outputDeviceSelect.value;
  await applyOutputDevice();
  hint.textContent = "输出设备已切换。";
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
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  if (document.hidden && pc) {
    hiddenTimer = setTimeout(() => {
      disconnect();
      hint.textContent = "应用进入后台超过 30 秒，已自动断开。";
    }, HIDDEN_DISCONNECT_MS);
  }
});

window.addEventListener("beforeunload", () => disconnect());
window.realtimeTranslateDisconnect = () => {
  disconnect();
  hint.textContent = "应用已进入后台，Realtime 已断开。";
};
initAndroidKeyControls();
refreshAudioDevices();
