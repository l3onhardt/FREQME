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
let visualActivity = 'idle';
let visualStressScore = 0;
let lastBreathTickAt = 0;
let lastAmbientTick = 0;
let geoContextPromise = null;
let latestGeoContext = { permission: 'unavailable' };
let audioContext = null;
let analyserNode = null;
let sourceNode = null;
let analyserData = null;
let analyserActive = false;
let progressTimer = null;
const DUCKING_RATIO = 0.25;
const DUCK_FADE_MS = 700;
const RESTORE_FADE_MS = 1000;
const VOLUME_RETARGET_FADE_MS = 300;
const VOLUME_FADE_STEP_MS = 50;
const ENABLE_AUDIO_ANALYSER = true;
const BREATH_FRAME_MS = 120;
const LOADING_BREATH_FRAME_MS = 180;
const IDLE_BREATH_FRAME_MS = 260;
const HIDDEN_BREATH_FRAME_MS = 3000;
const AMBIENT_FRAME_MS = 1600;
const PROGRESS_FRAME_MS = 1000;
const LOCAL_DJ_GREETING = '晚上好，这里是今晚的私人电台。我先把第一首歌轻轻放进来，你不用急，跟着这一点光慢慢听。';

const VOICE_CONFIG = {
  female: {
    preset: 'mimo_v2_5_custom_female_radio_dj',
    label: '厚感女主播',
    description: '成熟、温暖、低沉一点的女主播音色，带轻微胸腔共鸣，语速从容，像深夜电台里专业、克制、很会陪伴听众的主持人。避免过亮、过甜、过清脆的质感。',
    prompt: '你是一位深夜电台女主播。声音要成熟、醇厚、温暖，略带低频共鸣和一点点沙哑感，语气松弛、稳定、有陪伴感。语速偏慢，停顿自然，像在安静的夜里和听众靠近地聊天。不要甜腻、不要过亮、不要像播报新闻，要有电台DJ的厚度和质感。',
  },
  male: {
    preset: 'mimo_v2_5_custom_male_radio_dj',
    label: '厚感男主播',
    description: '成熟、低沉、磁性更强的男主播音色，胸腔感明显，像深夜电台的主理人，稳、慢、厚，有陪伴感但不油腻。避免年轻、清亮、尖薄的质感。',
    prompt: '你是一位深夜电台男主播。声音要低沉、醇厚、磁性、稳重，胸腔共鸣明显，语速从容，字头清晰但不锋利，像在夜里轻声把故事和音乐递给听众。不要年轻感、不要清亮感、不要播报腔，要有电台DJ那种厚实、成熟、靠得住的质感。',
  },
};

const onboardingSteps = ['voice', 'notes', 'mode'];

const audioMain = document.getElementById('audio-main');
const audioTTS = document.getElementById('audio-tts');
const volumeSlider = document.getElementById('volume-slider');
const requestForm = document.getElementById('request-form');
const requestInput = document.getElementById('request-input');
const onboardingPrevBtn = document.getElementById('onboarding-prev-btn');
const onboardingNextBtn = document.getElementById('onboarding-next-btn');
const stepDots = Array.from(document.querySelectorAll('#step-indicator .step-dot'));
const spectrumBars = Array.from(document.querySelectorAll('#spectrum-bars span'));
const progressFill = document.getElementById('progress-fill');
const progressCurrent = document.getElementById('progress-current');
const progressTotal = document.getElementById('progress-total');
const progressTrack = document.querySelector('.progress-track');

audioMain.volume = userVolume;
audioTTS.volume = 0.9;

// ---- Background Particles ----
function createParticles() {
  if (particlesCreated) return;
  const bg = document.getElementById('player-bg');
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 6 + 's';
    p.style.animationDuration = (8 + Math.random() * 10) + 's';
    p.style.opacity = (0.05 + Math.random() * 0.12);
    bg.appendChild(p);
  }
  particlesCreated = true;
}


async function connectAudioAnalyser() {
  if (!ENABLE_AUDIO_ANALYSER) {
    analyserActive = false;
    return false;
  }
  const runtimeWindow = typeof window !== 'undefined' ? window : null;
  const AC = runtimeWindow?.AudioContext || runtimeWindow?.webkitAudioContext;
  if (!AC) return false;
  try {
    if (!audioContext) {
      audioContext = new AC();
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 128;
      analyserNode.smoothingTimeConstant = 0.78;
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
  const visualLevel = Math.min(clamped, 0.72);
  const presets = {
    morning: { hue: 6, warmth: 0.08, halo: 'rgba(255, 196, 145, 0.12)', halo2: 'rgba(255, 230, 193, 0.06)' },
    afternoon: { hue: 14, warmth: 0.1, halo: 'rgba(242, 157, 109, 0.11)', halo2: 'rgba(232, 184, 127, 0.07)' },
    evening: { hue: 22, warmth: 0.16, halo: 'rgba(218, 121, 98, 0.12)', halo2: 'rgba(242, 157, 109, 0.08)' },
    night: { hue: 28, warmth: 0.2, halo: 'rgba(163, 98, 118, 0.12)', halo2: 'rgba(242, 157, 109, 0.08)' },
    late: { hue: 34, warmth: 0.24, halo: 'rgba(128, 89, 132, 0.12)', halo2: 'rgba(242, 157, 109, 0.06)' },
  };
  const preset = presets[phase] || presets.night;
  root.style.setProperty('--ambient-alpha', String(0.08 + (visualLevel * 0.1)));
  root.style.setProperty('--bg-hue', `${preset.hue + (visualLevel * 3)}deg`);
  root.style.setProperty('--bg-warmth', String(preset.warmth + (visualLevel * 0.08)));
  root.style.setProperty('--pulse-alpha', String(0.08 + (visualLevel * 0.1)));
  root.style.setProperty('--breath-glow', String(0.1 + (visualLevel * 0.1)));
  root.style.setProperty('--breath-scale', String(1 + (visualLevel * 0.006)));
  root.style.setProperty('--time-halo', preset.halo);
  root.style.setProperty('--time-halo-2', preset.halo2);
  root.style.setProperty('--surface-tint', visualLevel > 0.5 ? 'rgba(255, 255, 255, 0.045)' : 'rgba(255, 255, 255, 0.03)');
  root.style.setProperty('--progress-glow', String(0.16 + (visualLevel * 0.3)));
}

function setAmbientStateThrottled(level, phase = currentDayPhase()) {
  const now = Date.now();
  if (now - lastAmbientTick < AMBIENT_FRAME_MS) return;
  lastAmbientTick = now;
  setAmbientState(level, phase);
}

function updateSpectrum(energy = 0, speaking = false) {
  if (!spectrumBars.length) return;
  const total = spectrumBars.length;
  const center = (total - 1) / 2;
  const e = Math.max(0, Math.min(1, energy));
  spectrumBars.forEach((bar, index) => {
    const dist = Math.abs(index - center) / Math.max(1, center);
    const centerWeight = Math.pow(1 - dist, 1.65);
    const phase = breathPhase * (speaking ? 0.13 : 0.19) + index * (speaking ? 0.62 : 0.82);
    const beat = Math.sin(phase);
    const flutter = Math.abs(Math.sin(phase * (speaking ? 1.35 : 1.85)));
    const kick = Math.abs(Math.sin(breathPhase * (speaking ? 0.06 : 0.09) + index * 0.4));
    const energyLift = speaking ? e * 0.6 : e * 1.55;
    const movement = speaking ? (Math.abs(beat) * 0.08 + flutter * 0.06 + kick * 0.05) : (Math.abs(beat) * 0.36 + flutter * 0.3 + kick * 0.16);
    const scale = Math.max(0.08, Math.min(1.9, 0.1 + (centerWeight * (speaking ? 0.34 : 0.62)) + energyLift + movement + (index % 4) * 0.018));
    const opacity = Math.max(0.12, Math.min(1, 0.14 + (centerWeight * 0.46) + e * (speaking ? 0.4 : 0.88) + movement * 0.38));
    bar.style.setProperty('--bar-scale', scale.toFixed(3));
    bar.style.setProperty('--bar-opacity', opacity.toFixed(3));
  });
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

function currentVisualFrameMs() {
  if (visualStressScore >= 5) return IDLE_BREATH_FRAME_MS;
  if (visualStressScore >= 3) return LOADING_BREATH_FRAME_MS;
  if (visualActivity === 'playing' || visualActivity === 'speaking') return BREATH_FRAME_MS;
  if (visualActivity === 'loading') return LOADING_BREATH_FRAME_MS;
  return IDLE_BREATH_FRAME_MS;
}

function startBreathLoop() {
  if (breathTimer) return;
  const tick = () => {
    if (document.hidden) {
      breathTimer = setTimeout(tick, HIDDEN_BREATH_FRAME_MS);
      return;
    }
    const now = Date.now();
    if (lastBreathTickAt) {
      const drift = now - lastBreathTickAt;
      const expected = currentVisualFrameMs();
      if (drift > expected * 2.4) {
        visualStressScore = Math.min(8, visualStressScore + 1);
      } else {
        visualStressScore = Math.max(0, visualStressScore - 0.25);
      }
    }
    lastBreathTickAt = now;
    breathPhase += 1;

    if (analyserActive && analyserNode && analyserData) {
      analyserNode.getByteTimeDomainData(analyserData);
      let sum = 0;
      let peak = 0;
      const len = analyserData.length;
      const energyBands = { low: 0, mid: 0, high: 0 };
      for (let i = 0; i < len; i += 1) {
        const n = (analyserData[i] - 128) / 128;
        const abs = Math.abs(n);
        sum += n * n;
        peak = Math.max(peak, abs);
        if (i < len * 0.34) energyBands.low += abs;
        else if (i < len * 0.68) energyBands.mid += abs;
        else energyBands.high += abs;
      }
      const rms = Math.sqrt(sum / len);
      const rawEnergy = (rms * 2.6) + (peak * 0.5) + ((energyBands.low / len) * 0.8) + ((energyBands.mid / len) * 0.6) + ((energyBands.high / len) * 0.9);
      const energy = Math.min(1, rawEnergy * 0.95 + 0.12);
      breathLevel = breathLevel + ((energy - breathLevel) * 0.18);
      setAmbientStateThrottled(breathLevel);
      updateSpectrum(Math.min(1, energy + (energyBands.low / len) * 0.4 + (energyBands.high / len) * 0.5), false);
    } else {
      const ambient = 0.18 + (Math.sin(breathPhase / 90) * 0.03);
      breathLevel = breathLevel + ((ambient - breathLevel) * 0.05);
      setAmbientStateThrottled(breathLevel);
      updateSpectrum(breathLevel * 0.22, false);
    }

    breathTimer = setTimeout(tick, currentVisualFrameMs());
  };
  breathTimer = setTimeout(tick, 0);
}

function stopBreathLoop() {
  if (breathTimer) {
    clearTimeout(breathTimer);
    breathTimer = null;
  }
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
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
  updateSpectrum(0.32, true);
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
  updateProgressUI();
  updateSpectrum(0.45, false);
  startBreathLoop();
  audioMain.play().catch(() => {});
  isPlaying = true;
  document.getElementById('btn-play').textContent = '⏸';
  startProgressLoop();
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
  updateSpectrum(0.08, false);
}

function updateBreathState(kind, active) {
  const map = {
    idle: 0.15,
    speaking: 0.62,
    playing: 0.86,
    loading: 0.38,
  };
  if (active) {
    visualActivity = kind || 'idle';
    setBreathLevel(map[kind] ?? 0.15);
  }
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateProgressUI() {
  const duration = Number.isFinite(audioMain.duration) ? audioMain.duration : 0;
  const current = Number.isFinite(audioMain.currentTime) ? audioMain.currentTime : 0;
  const percent = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
  if (progressFill) progressFill.style.width = `${percent}%`;
  if (progressFill?.style?.setProperty) {
    progressFill.style.setProperty('--progress-percent', `${percent}%`);
  }
  if (progressTrack) {
    progressTrack.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  if (progressCurrent) progressCurrent.textContent = formatTime(current);
  if (progressTotal) progressTotal.textContent = formatTime(duration);
}

function startProgressLoop() {
  if (progressTimer) return;
  const tick = () => {
    if (document.hidden) {
      progressTimer = setTimeout(tick, PROGRESS_FRAME_MS * 2);
      return;
    }
    updateProgressUI();
    progressTimer = setTimeout(tick, PROGRESS_FRAME_MS);
  };
  progressTimer = setTimeout(tick, 0);
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

function getGeoContext() {
  if (geoContextPromise) return geoContextPromise;
  geoContextPromise = new Promise((resolve) => {
    if (!navigator.geolocation) {
      latestGeoContext = { permission: 'unavailable' };
      resolve(latestGeoContext);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = position.coords || {};
        const lat = Number(coords.latitude);
        const lon = Number(coords.longitude);
        latestGeoContext = {
          permission: 'granted',
          lat: Number.isFinite(lat) ? Math.round(lat * 100) / 100 : undefined,
          lon: Number.isFinite(lon) ? Math.round(lon * 100) / 100 : undefined,
          accuracyM: Number.isFinite(coords.accuracy) ? Math.round(coords.accuracy) : undefined,
        };
        resolve(latestGeoContext);
      },
      () => {
        latestGeoContext = { permission: 'denied' };
        resolve(latestGeoContext);
      },
      {
        enableHighAccuracy: false,
        maximumAge: 60 * 60 * 1000,
        timeout: 2500,
      },
    );
  });
  return geoContextPromise;
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

function getSelectedVoiceConfig() {
  const selectedVoice = document.querySelector('#voice-options .choice-card.selected');
  const voiceKey = selectedVoice?.dataset.voice === 'warm_male' ? 'male' : 'female';
  return VOICE_CONFIG[voiceKey];
}

function getVoicePromptPayload() {
  const voiceConfig = getSelectedVoiceConfig();
  return {
    voice_preset: voiceConfig.preset,
    voice_prompt: voiceConfig.prompt,
    voice_label: voiceConfig.label,
    voice_description: voiceConfig.description,
  };
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

  const selectedMode = document.querySelector('#mode-options .choice-card.selected');
  const payload = {
    ...getVoicePromptPayload(),
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
    getGeoContext().catch(() => {});
    ws.send(JSON.stringify({
      type: 'handshake',
      uid: uid,
      utc_offset: -new Date().getTimezoneOffset(),
      timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      locale: navigator.language || 'zh-CN',
      region_hint: inferRegionHint(),
      geo: latestGeoContext,
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
  updateProgressUI();
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
    updateSpectrum(0.1, false);
  } else {
    if (audioTTS.src && !audioTTS.ended) {
      audioTTS.play().catch(() => {});
      startBreathLoop();
      updateBreathState('speaking', true);
      updateSpectrum(0.25, true);
    } else {
      audioMain.play().catch(() => {});
      startBreathLoop();
      updateBreathState('playing', true);
      updateSpectrum(0.5, false);
    }
    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
    startProgressLoop();
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
  updateProgressUI();
  updateBreathState('loading', true);
  updateSpectrum(0.12, false);
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
