// ============================================================
// AmbientMusic — 环境配乐引擎（主菜单及所有非战斗场景）
// ============================================================
//
// 架构：
//   - 独立 AudioContext（与 MusicEngine 分离，互不干扰）
//   - 四条音轨：bass（铺底）/ melody（旋律）/ pad（合成垫）/ drums（轻鼓）
//   - 单循环：16小节直接循环，无段落切换
//   - 柔和音色：正弦波pad、带颤音旋律、轻量鼓组
//   - 悬浮平和风格，C利底亚(#4)，避免V-I解决
//
// 乐谱格式见 data/menu-music.json
// ============================================================

const AmbientMusic = (() => {
  // ---- 内部状态 ----
  let _ctx = null;
  let _masterGain = null;
  let _trackGains = {};       // { bass, melody, pad, drums } → GainNode

  let _bpm = 100;
  let _beatDuration = 0.6;    // 60/100
  let _sixteenthDuration = 0;

  let _score = null;          // { total16th, bassSlots, melodySlots, padSlots, drumsSlots }
  let _isRunning = false;

  let _schedulerTimer = null;
  let _next16thSlot = 0;
  let _loopStartTime = 0;
  let _loopCount = 0;

  // ---- MIDI 音高 → 频率 ----
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // ---- 音色合成器（柔和氛围风格）----

  /** Bass 铺底：三角波 → 低通 → 慢攻陷包络 */
  function createBassPad(note, vel, startTime, duration) {
    const osc = _ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(midiToFreq(note), startTime);

    const filter = _ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, startTime);
    filter.Q.setValueAtTime(1, startTime);

    const env = _ctx.createGain();
    const attackTime = Math.min(0.08, duration * 0.1);
    const releaseTime = Math.min(0.3, duration * 0.3);
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.55 * vel, startTime + attackTime);
    env.gain.setValueAtTime(0.55 * vel, startTime + duration - releaseTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(_trackGains.bass);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  /** Melody 旋律：正弦波 → 带通 → 慢颤音 → 柔包络 */
  function createAmbientMelody(note, vel, startTime, duration) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(midiToFreq(note), startTime);

    // 轻柔颤音
    const lfo = _ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(3.5, startTime);
    const lfoGain = _ctx.createGain();
    lfoGain.gain.setValueAtTime(3, startTime);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(startTime);
    lfo.stop(startTime + duration);

    const filter = _ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1500, startTime);
    filter.Q.setValueAtTime(1.5, startTime);

    const env = _ctx.createGain();
    const attackTime = Math.min(0.06, duration * 0.15);
    const releaseTime = Math.min(0.25, duration * 0.4);
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.30 * vel, startTime + attackTime);
    env.gain.setValueAtTime(0.30 * vel, startTime + duration - releaseTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(_trackGains.melody);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  /** Pad 合成垫：多正弦波叠加 → 低通 → 极慢包络（氛围感） */
  function createPadVoice(note, vel, startTime, duration) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(midiToFreq(note), startTime);

    // 极慢颤音
    const lfo = _ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.8, startTime);
    const lfoGain = _ctx.createGain();
    lfoGain.gain.setValueAtTime(1.5, startTime);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(startTime);
    lfo.stop(startTime + duration);

    const filter = _ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, startTime);
    filter.Q.setValueAtTime(0.7, startTime);

    const env = _ctx.createGain();
    const attackTime = Math.min(0.5, duration * 0.15);
    const releaseTime = Math.min(1.0, duration * 0.3);
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.20 * vel, startTime + attackTime);
    env.gain.setValueAtTime(0.20 * vel, startTime + duration - releaseTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(_trackGains.pad);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.1);
  }

  /** 轻鼓：Kick（正弦滑音，极轻） */
  function createSoftKick(vel, startTime) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(100, startTime);
    osc.frequency.exponentialRampToValueAtTime(25, startTime + 0.1);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.5 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.15);

    osc.connect(env);
    env.connect(_trackGains.drums);
    osc.start(startTime);
    osc.stop(startTime + 0.15);
  }

  /** 轻鼓：Hi-hat Closed */
  function createSoftHihat(vel, startTime) {
    const bufferSize = Math.floor(_ctx.sampleRate * 0.04);
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const hp = _ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(10000, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.22 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.025);

    noise.connect(hp);
    hp.connect(env);
    env.connect(_trackGains.drums);
    noise.start(startTime);
    noise.stop(startTime + 0.025);
  }

  /** 轻鼓：Hi-hat Open */
  function createSoftHihatOpen(vel, startTime) {
    const bufferSize = Math.floor(_ctx.sampleRate * 0.08);
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const hp = _ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(7000, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.28 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.07);

    noise.connect(hp);
    hp.connect(env);
    env.connect(_trackGains.drums);
    noise.start(startTime);
    noise.stop(startTime + 0.07);
  }

  function playSoftDrum(type, vel, startTime) {
    switch (type) {
      case 'kick': createSoftKick(vel, startTime); break;
      case 'hihat_closed': createSoftHihat(vel, startTime); break;
      case 'hihat_open': createSoftHihatOpen(vel, startTime); break;
    }
  }

  // ---- 乐谱查找表构建 ----
  function buildSlotTable(events, total16th, isDrumTrack) {
    const slots = new Array(total16th);
    for (let i = 0; i < total16th; i++) slots[i] = [];

    for (const ev of events) {
      const slot = Math.round(ev.beat * 4);
      if (slot >= 0 && slot < total16th) {
        if (isDrumTrack) {
          slots[slot].push({ type: 'drum', drumType: ev.type, vel: ev.vel });
        } else {
          const dur16 = ev.dur16 || 1;
          const dur = dur16 * _sixteenthDuration;
          slots[slot].push({ type: 'note', note: ev.note, vel: ev.vel, duration: dur });
        }
      }
    }
    return slots;
  }

  // ---- 调度器 ----
  function scheduleLoop() {
    if (!_isRunning) return;

    const now = _ctx.currentTime;
    const lookAhead = 0.15;
    const elapsedInLoop = now - _loopStartTime;
    const totalLoopDuration = (_score.total16th / 4) * _beatDuration;

    // 循环结束 → 重新开始
    if (elapsedInLoop >= totalLoopDuration) {
      _loopStartTime += totalLoopDuration;
      _loopCount++;
      _next16thSlot = 0;
      _schedulerTimer = setTimeout(scheduleLoop, 25);
      return;
    }

    const lookAheadEnd = now + lookAhead;
    let slotToSchedule = _next16thSlot;

    while (slotToSchedule < _score.total16th) {
      const slotTime = _loopStartTime + slotToSchedule * _sixteenthDuration;
      if (slotTime > lookAheadEnd) break;
      scheduleSlot(slotToSchedule, slotTime);
      slotToSchedule++;
    }

    _next16thSlot = slotToSchedule;
    _schedulerTimer = setTimeout(scheduleLoop, 50);
  }

  function scheduleSlot(slot, time) {
    // Bass 铺底
    for (const ev of _score.bassSlots[slot]) {
      createBassPad(ev.note, ev.vel, time, ev.duration);
    }
    // Melody 旋律
    for (const ev of _score.melodySlots[slot]) {
      createAmbientMelody(ev.note, ev.vel, time, ev.duration);
    }
    // Pad 合成垫
    for (const ev of _score.padSlots[slot]) {
      createPadVoice(ev.note, ev.vel, time, ev.duration);
    }
    // Drums 轻鼓
    for (const ev of _score.drumsSlots[slot]) {
      playSoftDrum(ev.drumType, ev.vel, time);
    }
  }

  // ---- 公开 API ----
  const api = {
    get isRunning() { return _isRunning; },

    /** 初始化引擎 */
    init() {
      if (_ctx) return true;
      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn('[Ambient] AudioContext不可用:', e.message);
        return false;
      }

      _masterGain = _ctx.createGain();
      _masterGain.gain.setValueAtTime(0.55, _ctx.currentTime);
      _masterGain.connect(_ctx.destination);

      _trackGains.bass = _ctx.createGain();
      _trackGains.bass.gain.setValueAtTime(0.85, _ctx.currentTime);
      _trackGains.bass.connect(_masterGain);

      _trackGains.melody = _ctx.createGain();
      _trackGains.melody.gain.setValueAtTime(0.75, _ctx.currentTime);
      _trackGains.melody.connect(_masterGain);

      _trackGains.pad = _ctx.createGain();
      _trackGains.pad.gain.setValueAtTime(0.6, _ctx.currentTime);
      _trackGains.pad.connect(_masterGain);

      _trackGains.drums = _ctx.createGain();
      _trackGains.drums.gain.setValueAtTime(0.5, _ctx.currentTime);
      _trackGains.drums.connect(_masterGain);

      return true;
    },

    /** 加载乐谱 */
    async loadScore() {
      try {
        const resp = await fetch('/data/menu-music.json');
        if (!resp.ok) {
          console.warn('[Ambient] 乐谱加载失败:', resp.status);
          return false;
        }
        const data = await resp.json();
        _bpm = data._meta?.bpm || 100;
        _beatDuration = 60 / _bpm;
        _sixteenthDuration = _beatDuration / 4;

        const total16th = data._meta?.total16thNotes || 256;
        _score = {
          total16th,
          bassSlots: buildSlotTable(data.bass || [], total16th, false),
          melodySlots: buildSlotTable(data.melody || [], total16th, false),
          padSlots: buildSlotTable(data.pad || [], total16th, false),
          drumsSlots: buildSlotTable(data.drums || [], total16th, true),
        };
        return true;
      } catch (e) {
        console.warn('[Ambient] 乐谱加载异常:', e.message);
        return false;
      }
    },

    /** 开始播放 */
    start() {
      if (!_ctx) { if (!api.init()) return; }
      if (_ctx.state === 'suspended') _ctx.resume();

      // ★ 关键修复：取消 stop() 的淡出，恢复主音量
      // （否则 stop() 把 _masterGain ramp 到 0 后，start() 只有调度器在跑但无声）
      const now = _ctx.currentTime;
      _masterGain.gain.cancelScheduledValues(now);
      _masterGain.gain.setValueAtTime(0.55, now);

      if (_isRunning) return; // 已经在播放

      _isRunning = true;
      _next16thSlot = 0;
      _loopStartTime = _ctx.currentTime + 0.05;
      _loopCount = 0;
      scheduleLoop();
    },

    /** 停止播放（可带淡出） */
    stop(fadeOutMs = 300) {
      if (!_isRunning) return;
      _isRunning = false;

      if (_schedulerTimer) {
        clearTimeout(_schedulerTimer);
        _schedulerTimer = null;
      }

      // 淡出
      if (fadeOutMs > 0 && _masterGain && _ctx) {
        const now = _ctx.currentTime;
        _masterGain.gain.cancelScheduledValues(now);
        _masterGain.gain.setValueAtTime(_masterGain.gain.value || 0.35, now);
        _masterGain.gain.linearRampToValueAtTime(0, now + fadeOutMs / 1000);
      }
    },

    /** 设置主音量 (0-1) */
    setVolume(vol) {
      if (_masterGain && _ctx) {
        const now = _ctx.currentTime;
        _masterGain.gain.cancelScheduledValues(now);
        _masterGain.gain.linearRampToValueAtTime(
          Math.max(0, Math.min(1, vol)),
          now + 0.1
        );
      }
    },

    /** 销毁 */
    destroy() {
      api.stop(0);
      if (_ctx) { _ctx.close(); _ctx = null; }
      _masterGain = null;
      _trackGains = {};
      _score = null;
    },
  };

  return api;
})();
