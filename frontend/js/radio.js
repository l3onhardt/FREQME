// ---- State ----
let ws = null;
let uid = null;
let isPlaying = false;
const ttsCache = {};
let retryTimer = null;
let onboardingSettings = null;
let onboardingStepIndex = 0;
let particlesCreated = false;
let introPending = false;
let introPlaying = false;
let pendingTrackAfterIntro = null;
let introFallbackTimer = null;
let userVolume = 0.8;
let isDucked = false;
let mainVolumeFadeTimer = null;
let breathTimer = null;
let breathPhase = 0;
let breathLevel = 0;
let audioContext = null;
let analyserNode = null;
let sourceNode = null;
let analyserData = null;
let analyserActive = false;
const DUCKING_RATIO = 0.25;
const DUCK_FADE_MS = 700;
const RESTORE_FADE_MS = 1000;
const VOLUME_RETARGET_FADE_MS = 300;
const VOLUME_FADE_STEP_MS = 50;
const LOCAL_DJ_GREETING = '晚上好，这里是今晚的私人电台。我先把第一首歌轻轻放进来，你不用急，跟着这一点光慢慢听。';

const onboardingSteps = ['voice', 'notes', 'mode'];

const audioMain = document.getElementById('audio-main');
const audioTTS = document.getElementById('audio-tts');
const volumeSlider = document.getElementById('volume-slider');
const requestForm = document.getElementById('request-form');
const requestInput = document.getElementById('request-input');
const onboardingPrevBtn = document.getElementById('onboarding-prev-btn');
const onboardingNextBtn = document.getElementById('onboarding-next-btn');
const stepDots = Array.from(document.querySelectorAll('#step-indicator .step-dot'));

audioMain.volume = userVolume;
audioTTS.volume = 0.9;

// ---- Background Particles ----
function createParticles() {
  if (particlesCreated) return;
  const bg = document.getElementById('player-bg');
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 6 + 's';
    p.style.animationDuration = (4 + Math.random() * 8) + 's';
    p.style.opacity = (0.06 + Math.random() * 0.16);
    bg.appendChild(p);
  }
  particlesCreated = true;
}


async function connectAudioAnalyser() {
  const runtimeWindow = typeof window !== 'undefined' ? window : null;
  const AC = runtimeWindow?.AudioContext || runtimeWindow?.webkitAudioContext;
  if (!AC) return false;
  try {
    if (!audioContext) {
      audioContext = new AC();
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      analyserData = new Uint8Array(analyserNode.frequencyBinCount);
    }
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    if (!sourceNode) {
      sourceNode = audioContext.createMediaElementSource(audioMain);
      sourceNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
    }
    analyserActive = true;
    return true;
  } catch {
    analyserActive = false;
    return false;
  }
}

function setAmbientState(level, phase = 'night') {
  const clamped = Math.max(0, Math.min(1, level));
  const root = document.documentElement;
  if (!root?.style?.setProperty) return;
  const presets = {
    morning: { hue: 6, warmth: 0.08, halo: 'rgba(255, 196, 145, 0.12)', halo2: 'rgba(255, 230, 193, 0.06)' },
    afternoon: { hue: 14, warmth: 0.1, halo: 'rgba(242, 157, 109, 0.11)', halo2: 'rgba(232, 184, 127, 0.07)' },
    evening: { hue: 22, warmth: 0.16, halo: 'rgba(218, 121, 98, 0.12)', halo2: 'rgba(242, 157, 109, 0.08)' },
    night: { hue: 28, warmth: 0.2, halo: 'rgba(163, 98, 118, 0.12)', halo2: 'rgba(242, 157, 109, 0.08)' },
    late: { hue: 34, warmth: 0.24, halo: 'rgba(128, 89, 132, 0.12)', halo2: 'rgba(242, 157, 109, 0.06)' },
  };
  const preset = presets[phase] || presets.night;
  root.style.setProperty('--ambient-alpha', String(0.08 + (clamped * 0.12)));
  root.style.setProperty('--bg-hue', `${preset.hue + (clamped * 4)}deg`);
  root.style.setProperty('--bg-warmth', String(preset.warmth + (clamped * 0.1)));
  root.style.setProperty('--pulse-alpha', String(0.08 + (clamped * 0.12)));
  root.style.setProperty('--breath-glow', String(0.12 + (clamped * 0.12)));
  root.style.setProperty('--breath-scale', String(1 + (clamped * 0.008)));
  root.style.setProperty('--time-halo', preset.halo);
  root.style.setProperty('--time-halo-2', preset.halo2);
}

function setBreathLevel(level) {
  breathLevel = Math.max(0, Math.min(1, level));
  setAmbientState(breathLevel, currentDayPhase());
}

function currentDayPhase() {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  if (hour >= 21 && hour < 24) return 'night';
  return 'late';
}

function startBreathLoop() {
  if (breathTimer) return;
  const runtimeWindow = typeof window !== 'undefined' ? window : null;
  if (!runtimeWindow?.requestAnimationFrame) {
    setAmbientState(breathLevel || 0.18, currentDayPhase());
    return;
  }
  const tick = () => {
    breathPhase += 1;

    if (analyserActive && analyserNode && analyserData) {
      analyserNode.getByteTimeDomainData(analyserData);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < analyserData.length; i += 1) {
        const n = (analyserData[i] - 128) / 128;
        sum += n * n;
        peak = Math.max(peak, Math.abs(n));
      }
      const rms = Math.sqrt(sum / analyserData.length);
      const energy = Math.min(1, (rms * 2.1) + (peak * 0.35));
      breathLevel = breathLevel + ((energy - breathLevel) * 0.08);
      setAmbientState(breathLevel, currentDayPhase());
    } else {
      const ambient = 0.18 + (Math.sin(breathPhase / 90) * 0.03);
      breathLevel = breathLevel + ((ambient - breathLevel) * 0.05);
      setAmbientState(breathLevel, currentDayPhase());
    }

    breathTimer = runtimeWindow.requestAnimationFrame(tick);
  };
  breathTimer = runtimeWindow.requestAnimationFrame(tick);
}

function stopBreathLoop() {
  if (breathTimer) {
    const runtimeWindow = typeof window !== 'undefined' ? window : null;
    if (runtimeWindow?.cancelAnimationFrame) {
      runtimeWindow.cancelAnimationFrame(breathTimer);
    }
    breathTimer = null;
  }
}

// ---- TTS Helper ----
function clampVolume(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function targetMainVolume() {
  return clampVolume(isDucked ? userVolume * DUCKING_RATIO : userVolume);
}

function cancelMainVolumeFade() {
  if (mainVolumeFadeTimer) {
    clearTimeout(mainVolumeFadeTimer);
    mainVolumeFadeTimer = null;
  }
}

function setMainVolume(value) {
  audioMain.volume = clampVolume(value);
}

function fadeMainVolumeTo(target, durationMs) {
  const safeTarget = clampVolume(target);
  const start = clampVolume(audioMain.volume);

  cancelMainVolumeFade();

  if (durationMs <= 0 || Math.abs(start - safeTarget) < 0.001) {
    setMainVolume(safeTarget);
    return;
  }

  const totalSteps = Math.max(1, Math.round(durationMs / VOLUME_FADE_STEP_MS));
  let currentStep = 0;

  const tick = () => {
    currentStep += 1;
    const progress = Math.min(1, currentStep / totalSteps);
    setMainVolume(start + ((safeTarget - start) * progress));

    if (progress < 1) {
      mainVolumeFadeTimer = setTimeout(tick, VOLUME_FADE_STEP_MS);
    } else {
      mainVolumeFadeTimer = null;
    }
  };

  mainVolumeFadeTimer = setTimeout(tick, VOLUME_FADE_STEP_MS);
}

function applyMainVolume({ immediate = false, durationMs = RESTORE_FADE_MS } = {}) {
  const target = targetMainVolume();
  if (immediate) {
    cancelMainVolumeFade();
    setMainVolume(target);
    return;
  }
  fadeMainVolumeTo(target, durationMs);
}

function duckMainForDJ() {
  isDucked = true;
  applyMainVolume({ durationMs: DUCK_FADE_MS });
}

function restoreMainAfterDJ() {
  isDucked = false;
  applyMainVolume({ durationMs: RESTORE_FADE_MS });
}

async function playTTS(hash, text, onEnd) {
  if (text) {
    document.getElementById('dj-text').textContent = text;
  }
  if (!hash) {
    if (onEnd) onEnd();
    return;
  }
  const url = await getTTSBlob(hash);
  if (!url) {
    if (onEnd) onEnd();
    return;
  }
  audioTTS.src = url;
  startBreathLoop();
  setAmbientState(0.42);
  updateBreathState('speaking', true);
  duckMainForDJ();
  audioTTS.onended = () => {
    audioTTS.onended = null;
    restoreMainAfterDJ();
    updateBreathState('idle', true);
    if (onEnd) onEnd();
  };
  audioTTS.play().catch(() => {
    restoreMainAfterDJ();
    updateBreathState('idle', true);
    if (onEnd) onEnd();
  });
}

async function playTrack(track, url) {
  document.getElementById('track-name').textContent = track.name || '--';
  document.getElementById('track-artist').textContent = track.artist || '--';
  audioMain.src = url;
  applyMainVolume({ immediate: true });
  await connectAudioAnalyser();
  setAmbientState(0.54);
  startBreathLoop();
  audioMain.play().catch(() => {});
  isPlaying = true;
  document.getElementById('btn-play').textContent = '⏸';
}

function clearIntroFallbackTimer() {
  if (introFallbackTimer) {
    clearTimeout(introFallbackTimer);
    introFallbackTimer = null;
  }
}

function finishIntroPlayback() {
  const pending = pendingTrackAfterIntro;
  pendingTrackAfterIntro = null;
  introPending = false;
  introPlaying = false;
  audioTTS._hasIntro = false;
  clearIntroFallbackTimer();
  if (pending) {
    playTrack(pending.track, pending.url);
  }
}

function beginIntroWait() {
  introPending = true;
  introPlaying = false;
  pendingTrackAfterIntro = null;
  audioTTS._hasIntro = false;
  clearIntroFallbackTimer();
  introFallbackTimer = setTimeout(finishIntroPlayback, 25000);
}

function playIntroTTS(hash, text) {
  introPending = false;
  introPlaying = true;
  audioTTS._hasIntro = true;
  clearIntroFallbackTimer();
  playTTS(hash, text, finishIntroPlayback);
}

function showTextIntro(text) {
  if (text) {
    document.getElementById('dj-text').textContent = text;
  }
  introPending = false;
  introPlaying = false;
  audioTTS._hasIntro = false;
  clearIntroFallbackTimer();
  if (pendingTrackAfterIntro) {
    introFallbackTimer = setTimeout(finishIntroPlayback, 3500);
  }
}

function resetIntroGate() {
  pendingTrackAfterIntro = null;
  introPending = false;
  introPlaying = false;
  audioTTS._hasIntro = false;
  clearIntroFallbackTimer();
  restoreMainAfterDJ();
  stopBreathLoop();
  setBreathLevel(0.15);
}

function updateBreathState(kind, active) {
  const map = {
    idle: 0.15,
    speaking: 0.62,
    playing: 0.86,
    loading: 0.38,
  };
  if (active) {
    setBreathLevel(map[kind] ?? 0.15);
  }
}

// ---- QR Login ----
async function initLogin() {
  try {
    const keyResp = await fetch('/api/auth/qr/key');
    const keyData = await keyResp.json();
    const unikey = keyData.data?.unikey || keyData.unikey;

    if (!unikey) {
      document.getElementById('qr-status').textContent = '正在唤醒网易云服务...';
      setTimeout(initLogin, 3000);
      return;
    }

    document.getElementById('qr-status').textContent = '正在生成二维码...';

    const qrResp = await fetch(`/api/auth/qr/create?key=${unikey}`);
    const qrData = await qrResp.json();
    const qrimg = qrData.data?.qrimg || qrData.qrimg;
    document.getElementById('qr-img').src = qrimg;
    document.getElementById('qr-status').textContent = '请用网易云音乐APP扫描二维码';

    const pollInterval = setInterval(async () => {
      try {
        const checkResp = await fetch(`/api/auth/qr/check?key=${unikey}`);
        const checkData = await checkResp.json();
        const code = checkData.data?.code || checkData.code;

        if (code === 803) {
          clearInterval(pollInterval);
          document.getElementById('qr-status').textContent = '登录成功！';

          const statusResp = await fetch('/api/auth/status');
          const statusData = await statusResp.json();
          const profile = statusData.data?.profile || statusData.profile;
          if (profile) {
            uid = profile.userId;
            document.getElementById('qr-status').textContent =
              `已登录: ${profile.nickname}`;
            await showOnboardingOrStart(profile);
          }
        } else if (code === 800) {
          document.getElementById('qr-status').textContent =
            '二维码已过期，刷新页面重试';
          clearInterval(pollInterval);
        } else if (code === 802) {
          document.getElementById('qr-status').textContent =
            '已扫描，请在手机上确认登录';
        }
      } catch (e) {
        // polling, ignore transient errors
      }
    }, 2000);
  } catch (e) {
    if (e.message && e.message.includes('not valid JSON')) {
      document.getElementById('qr-status').textContent = '服务加载中，请稍候...';
      setTimeout(initLogin, 3000);
    } else {
      document.getElementById('qr-status').textContent =
        '连接失败，请确认后端已启动: ' + (e.message || '');
    }
  }
}

async function fetchOnboarding(uidValue) {
  const resp = await fetch(`/api/radio/onboarding/${uidValue}`);
  if (!resp.ok) {
    throw new Error('读取调频设置失败');
  }
  return resp.json();
}

async function showOnboardingOrStart(profile) {
  document.getElementById('start-radio-btn').style.display = 'none';

  let data;
  try {
    data = await fetchOnboarding(profile.userId);
  } catch {
    data = {
      profile_ready: false,
      profile: {},
      settings: null,
      onboarded: false,
      fallback: true,
    };
  }
  if (data.onboarded && data.settings) {
    onboardingSettings = data.settings;
    document.getElementById('start-radio-btn').style.display = 'block';
    return;
  }

  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('onboarding-screen').classList.add('active');
  if (data.fallback) {
    document.getElementById('onboarding-status').textContent =
      '暂时没读到你的调频记录，先用默认问题把电台调起来。';
  } else {
    document.getElementById('onboarding-status').textContent = data.profile_ready
    ? '歌单已经准备好，选好频率就能开播。'
    : '还在整理你的听歌资料，先选一个喜欢的电台频率。';
  }
  resetOnboardingSteps();
}

async function bootAuth() {
  setAmbientState(0.22, currentDayPhase());
  document.getElementById('qr-status').textContent = '正在检查登录状态...';
  try {
    let statusData = await fetchAuthStatus();
    let profile = statusData.data?.profile || statusData.profile;
    if (!profile?.userId) {
      await fetch('/api/auth/refresh', { method: 'POST' });
      statusData = await fetchAuthStatus();
      profile = statusData.data?.profile || statusData.profile;
    }
    if (profile?.userId) {
      uid = profile.userId;
      document.getElementById('qr-status').textContent = `已登录: ${profile.nickname}`;
      await showOnboardingOrStart(profile);
      return;
    }
  } catch {
    // Fall through to QR login.
  }
  initLogin();
}

async function fetchAuthStatus() {
  const statusResp = await fetch('/api/auth/status');
  return statusResp.json();
}

function showPlayerAndConnect() {
  const startButton = document.getElementById('start-radio-btn');
  startButton.disabled = true;
  startButton.style.display = 'none';
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('onboarding-screen').classList.remove('active');
  document.getElementById('player-screen').classList.add('active');
  createParticles();
  startBreathLoop();
  connectWebSocket();
}

// ---- Onboarding ----
function resetOnboardingSteps() {
  onboardingStepIndex = 0;
  updateOnboardingStep();
}

function updateOnboardingStep() {
  document.querySelectorAll('.onboarding-step').forEach((step) => {
    step.classList.toggle(
      'active',
      step.dataset.step === onboardingSteps[onboardingStepIndex],
    );
  });
  stepDots.forEach((dot, index) => {
    dot.classList.toggle('active', index === onboardingStepIndex);
  });
  onboardingPrevBtn.disabled = onboardingStepIndex === 0;
  onboardingPrevBtn.style.visibility = onboardingStepIndex === 0 ? 'hidden' : 'visible';
  onboardingNextBtn.textContent =
    onboardingStepIndex === onboardingSteps.length - 1 ? '开始收听' : '继续';
}

function selectChoice(containerId, attrName, value) {
  document.querySelectorAll(`#${containerId} .choice-card`).forEach((button) => {
    button.classList.toggle('selected', button.dataset[attrName] === value);
  });
}

document.getElementById('voice-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-voice]');
  if (!button) return;
  selectChoice('voice-options', 'voice', button.dataset.voice);
});

document.getElementById('mode-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  selectChoice('mode-options', 'mode', button.dataset.mode);
});

onboardingPrevBtn.addEventListener('click', () => {
  if (onboardingStepIndex > 0) {
    onboardingStepIndex -= 1;
    updateOnboardingStep();
  }
});

document.getElementById('onboarding-next-btn').addEventListener('click', async () => {
  if (onboardingStepIndex < onboardingSteps.length - 1) {
    onboardingStepIndex += 1;
    updateOnboardingStep();
    return;
  }

  const selectedVoice = document.querySelector('#voice-options .choice-card.selected');
  const selectedMode = document.querySelector('#mode-options .choice-card.selected');
  const payload = {
    voice_preset: selectedVoice?.dataset.voice || 'silver_female',
    display_name: document.getElementById('display-name-input').value,
    music_notes: document.getElementById('music-notes-input').value,
    current_mode: selectedMode?.dataset.mode || '陪伴',
  };

  const nextButton = document.getElementById('onboarding-next-btn');
  nextButton.disabled = true;
  onboardingPrevBtn.disabled = true;
  document.getElementById('onboarding-status').textContent = '正在保存你的电台频率...';
  try {
    const resp = await fetch(`/api/radio/onboarding/${uid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error('保存失败');
    }
    const data = await resp.json();
    onboardingSettings = data.settings;
    showPlayerAndConnect();
  } catch (e) {
    document.getElementById('onboarding-status').textContent =
      '保存失败，请稍后再试。' + (e.message ? ` ${e.message}` : '');
    nextButton.disabled = false;
    onboardingPrevBtn.disabled = onboardingStepIndex === 0;
  }
});

// ---- Start Radio ----
document.getElementById('start-radio-btn').addEventListener('click', async () => {
  if (!onboardingSettings && uid) {
    try {
      const data = await fetchOnboarding(uid);
      onboardingSettings = data.settings || null;
    } catch {
      // Let the radio try to start even if settings refresh fails.
    }
  }
  showPlayerAndConnect();
});

// ---- WebSocket ----
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('dj-text').textContent = '正在连接电台...';
    startBreathLoop();
    updateBreathState('loading', true);
    ws.send(JSON.stringify({
      type: 'handshake',
      uid: uid,
      utc_offset: -new Date().getTimezoneOffset(),
      timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      locale: navigator.language || 'zh-CN',
      region_hint: inferRegionHint(),
      settings: onboardingSettings,
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    document.getElementById('dj-text').textContent = '连线中断，3秒后重连...';
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    document.getElementById('dj-text').textContent = '连接出错，正在重试...';
  };
}

// ---- TTS Cache ----
async function getTTSBlob(hash) {
  if (!hash) return null;
  if (ttsCache[hash]) return ttsCache[hash];
  const resp = await fetch(`/api/radio/tts/${hash}`);
  if (!resp.ok) return null;
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  ttsCache[hash] = url;
  return url;
}

// ---- Message Handler ----
async function handleMessage(msg) {
  switch (msg.type) {
    case 'session_start': {
      const sl = document.getElementById('scene-label');
      const sceneMap = { '深夜': 'FREQME 深夜', '清晨': 'FREQME 清晨', '午后': 'FREQME 午后' };
      sl.textContent = sceneMap[msg.scene] || 'FREQME';
      updateBreathState('loading', true);

      beginIntroWait();
      if (msg.tts_ready && msg.tts_hash) {
        playIntroTTS(msg.tts_hash, msg.intro_text);
      } else {
        document.getElementById('dj-text').textContent = msg.intro_text || LOCAL_DJ_GREETING;
        startBreathLoop();
        updateBreathState('speaking', true);
      }
      break;
    }

    case 'intro': {
      if (msg.tts_ready && msg.tts_hash) {
        playIntroTTS(msg.tts_hash, msg.text);
      } else if (msg.text) {
        showTextIntro(msg.text);
      } else {
        finishIntroPlayback();
      }
      break;
    }

    case 'play_track': {
      audioTTS._hasIntro = false;
      playTrack(msg.track, msg.url);
      break;
    }

    case 'segue': {
      const playNextTrack = () => {
        if (msg.next_track) {
          playTrack(msg.next_track, msg.url);
        }
      };

      if (msg.tts_ready && msg.tts_hash) {
        if (msg.next_track) {
          playTrack(msg.next_track, msg.url);
        }
        playTTS(msg.tts_hash, msg.text);
      } else if (msg.text) {
        document.getElementById('dj-text').textContent = msg.text;
        setTimeout(playNextTrack, 3500);
      } else {
        playNextTrack();
      }
      break;
    }

    case 'error': {
      document.getElementById('dj-text').textContent = msg.message || '出错了';
      updateBreathState('idle', true);
      resetIntroGate();
      // Auto-retry after a few seconds
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'track_ended' }));
        }
      }, 5000);
      break;
    }

    case 'dj_message': {
      if (msg.text) {
        if (msg.tts_ready && msg.tts_hash) {
          playTTS(msg.tts_hash, msg.text);
        } else {
          document.getElementById('dj-text').textContent = msg.text;
          startBreathLoop();
          updateBreathState('speaking', true);
          setTimeout(() => updateBreathState('idle', true), 2200);
        }
      }
      break;
    }

    case 'request_status': {
      if (msg.text) {
        document.getElementById('dj-text').textContent = msg.text;
      }
      break;
    }
  }
}

function inferRegionHint() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const language = navigator.language || '';
  if (timezone === 'Asia/Shanghai' || language.toLowerCase().includes('cn')) {
    return '中国大陆';
  }
  if (timezone === 'Asia/Hong_Kong') return '香港';
  if (timezone === 'Asia/Taipei') return '台湾';
  if (timezone === 'Asia/Tokyo') return '日本';
  if (timezone === 'Asia/Seoul') return '韩国';
  if (timezone.startsWith('America/')) return '北美';
  if (timezone.startsWith('Europe/')) return '欧洲';
  return '';
}

// ---- Audio Events ----
audioMain.addEventListener('ended', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'track_ended' }));
  }
  stopBreathLoop();
  setBreathLevel(0.18);
  updateBreathState('loading', true);
});

audioMain.addEventListener('error', () => {
  // Song URL might be invalid, skip to next after delay
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'track_ended' }));
    }
  }, 3000);
});

// ---- Controls ----
document.getElementById('btn-play').addEventListener('click', () => {
  if (isPlaying) {
    audioMain.pause();
    audioTTS.pause();
    isPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    stopBreathLoop();
    setBreathLevel(0.15);
  } else {
    if (audioTTS.src && !audioTTS.ended) {
      audioTTS.play().catch(() => {});
      startBreathLoop();
      updateBreathState('speaking', true);
    } else {
      audioMain.play().catch(() => {});
      startBreathLoop();
      updateBreathState('playing', true);
    }
    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
  }
});

document.getElementById('btn-skip').addEventListener('click', () => {
  resetIntroGate();
  audioMain.pause();
  audioTTS.pause();
  audioMain.currentTime = 0;
  audioTTS.currentTime = 0;
  audioTTS.removeAttribute('src');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'skip' }));
  }
  startBreathLoop();
  updateBreathState('loading', true);
});

if (requestForm && requestInput) {
  requestForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = requestInput.value.trim();
    if (!text) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'song_request', text }));
      requestInput.value = '';
      document.getElementById('dj-text').textContent = '我听到了，正在把频率往这个方向调。';
    }
  });
}

volumeSlider.addEventListener('input', (e) => {
  userVolume = clampVolume(e.target.value / 100);
  applyMainVolume({ durationMs: isDucked ? VOLUME_RETARGET_FADE_MS : 0 });
  audioTTS.volume = userVolume;
});

// ---- Boot ----
bootAuth();
