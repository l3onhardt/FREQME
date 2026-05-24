// ---- State ----
let ws = null;
let uid = null;
let isPlaying = false;
const ttsCache = {};
let retryTimer = null;
let onboardingSettings = null;
let onboardingStepIndex = 0;
let particlesCreated = false;

const onboardingSteps = ['voice', 'notes', 'mode'];

const audioMain = document.getElementById('audio-main');
const audioTTS = document.getElementById('audio-tts');
const volumeSlider = document.getElementById('volume-slider');

audioMain.volume = 0.8;
audioTTS.volume = 0.9;

// ---- Background Particles ----
function createParticles() {
  if (particlesCreated) return;
  const bg = document.getElementById('player-bg');
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.top = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 6 + 's';
    p.style.animationDuration = (4 + Math.random() * 8) + 's';
    p.style.opacity = (0.1 + Math.random() * 0.3);
    bg.appendChild(p);
  }
  particlesCreated = true;
}

// ---- TTS Helper ----
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
  audioTTS.onended = () => {
    audioTTS.onended = null;
    if (onEnd) onEnd();
  };
  audioTTS.play().catch(() => { if (onEnd) onEnd(); });
}

function playTrack(track, url) {
  document.getElementById('track-name').textContent = track.name || '--';
  document.getElementById('track-artist').textContent = track.artist || '--';
  audioMain.src = url;
  audioMain.play().catch(() => {});
  isPlaying = true;
  document.getElementById('btn-play').textContent = '⏸';
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

  const data = await fetchOnboarding(profile.userId);
  if (data.onboarded && data.settings) {
    onboardingSettings = data.settings;
    document.getElementById('start-radio-btn').style.display = 'block';
    return;
  }

  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('onboarding-screen').classList.add('active');
  document.getElementById('onboarding-status').textContent = data.profile_ready
    ? '歌单已经准备好，选好频率就能开播。'
    : '还在整理你的听歌资料，先选一个喜欢的电台频率。';
  resetOnboardingSteps();
}

async function bootAuth() {
  document.getElementById('qr-status').textContent = '正在检查登录状态...';
  try {
    const statusResp = await fetch('/api/auth/status');
    const statusData = await statusResp.json();
    const profile = statusData.data?.profile || statusData.profile;
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

function showPlayerAndConnect() {
  const startButton = document.getElementById('start-radio-btn');
  startButton.disabled = true;
  startButton.style.display = 'none';
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('onboarding-screen').classList.remove('active');
  document.getElementById('player-screen').classList.add('active');
  createParticles();
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
  document.getElementById('onboarding-next-btn').textContent =
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

document.getElementById('onboarding-next-btn').addEventListener('click', async () => {
  if (onboardingStepIndex < onboardingSteps.length - 1) {
    onboardingStepIndex += 1;
    updateOnboardingStep();
    return;
  }

  const selectedVoice = document.querySelector('#voice-options .choice-card.selected');
  const selectedMode = document.querySelector('#mode-options .choice-card.selected');
  const payload = {
    voice_preset: selectedVoice?.dataset.voice || 'warm_female',
    display_name: document.getElementById('display-name-input').value,
    music_notes: document.getElementById('music-notes-input').value,
    current_mode: selectedMode?.dataset.mode || '陪伴',
  };

  const nextButton = document.getElementById('onboarding-next-btn');
  nextButton.disabled = true;
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
    ws.send(JSON.stringify({
      type: 'handshake',
      uid: uid,
      utc_offset: -new Date().getTimezoneOffset(),
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
      const sceneMap = { '深夜': '深夜电台', '清晨': '清晨电台', '午后': '午后电台' };
      sl.textContent = sceneMap[msg.scene] || '小米memo电台';

      // Play TTS intro first; the first play_track will arrive
      // and play after TTS finishes (handled in play_track case)
      if (msg.tts_ready && msg.tts_hash) {
        audioTTS._hasIntro = true;
        playTTS(msg.tts_hash, msg.intro_text);
      } else {
        audioTTS._hasIntro = false;
        document.getElementById('dj-text').textContent = msg.intro_text || '';
      }
      break;
    }

    case 'play_track': {
      // If TTS intro is still playing, wait for it to finish
      if (audioTTS._hasIntro && !audioTTS.ended && audioTTS.src && !audioTTS.paused) {
        audioTTS.onended = () => {
          audioTTS.onended = null;
          audioTTS._hasIntro = false;
          playTrack(msg.track, msg.url);
        };
      } else {
        audioTTS._hasIntro = false;
        playTrack(msg.track, msg.url);
      }
      break;
    }

    case 'segue': {
      const playNextTrack = () => {
        if (msg.next_track) {
          playTrack(msg.next_track, msg.url);
        }
      };

      if (msg.tts_ready && msg.tts_hash) {
        playTTS(msg.tts_hash, msg.text, playNextTrack);
      } else if (msg.text) {
        document.getElementById('dj-text').textContent = msg.text;
        playNextTrack();
      } else {
        playNextTrack();
      }
      break;
    }

    case 'error': {
      document.getElementById('dj-text').textContent = msg.message || '出错了';
      // Auto-retry after a few seconds
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'track_ended' }));
        }
      }, 5000);
      break;
    }
  }
}

// ---- Audio Events ----
audioMain.addEventListener('ended', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'track_ended' }));
  }
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
  } else {
    if (audioTTS.src && !audioTTS.ended) {
      audioTTS.play().catch(() => {});
    } else {
      audioMain.play().catch(() => {});
    }
    isPlaying = true;
    document.getElementById('btn-play').textContent = '⏸';
  }
});

document.getElementById('btn-skip').addEventListener('click', () => {
  audioMain.pause();
  audioTTS.pause();
  audioMain.currentTime = 0;
  audioTTS.currentTime = 0;
  audioTTS.removeAttribute('src');
  audioTTS._hasIntro = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'skip' }));
  }
});

volumeSlider.addEventListener('input', (e) => {
  const v = e.target.value / 100;
  audioMain.volume = v;
  audioTTS.volume = v;
});

// ---- Boot ----
bootAuth();
