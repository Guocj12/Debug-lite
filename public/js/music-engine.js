// ============================================================
// MusicEngine — Web Audio API 背景音乐引擎
// 纯客户端运行，零服务端依赖
// 作为"主时钟"驱动战斗步进，实现音画完全同步
// ============================================================
//
// 架构：
//   - look-ahead 调度器 (每50ms唤醒，提前100ms调度音符)
//   - 三条独立音轨：bass / melody / drums
//   - 节拍回调系统：onBeat(每拍) / onLoopComplete(每循环)
//   - 编辑阶段：bass + hi-hat only
//   - 战斗阶段：bass + melody + full drums
//
// 使用 AudioContext.currentTime 作为绝对时钟源
// 这是 Web Audio 的最高精度时钟，优于 performance.now()
//
// 乐谱格式见 data/music.json
// ============================================================

const MusicEngine = (() => {
  // ---- 内部状态 ----
  let _ctx = null;                 // AudioContext
  let _masterGain = null;         // 总音量控制节点
  let _trackGains = {};           // { bass, melody, drums } → GainNode

  let _bpm = 120;
  let _beatDuration = 0.5;        // 每拍秒数 = 60/BPM
  let _sixteenthDuration = 0;     // 16分音符秒数
  let _beatsPerLoop = 16;         // 4小节×4拍 = 16拍/循环

  let _score = null;              // 乐谱数据（已展开为16分音符槽位查找表）
  let _editDrums = null;          // 编辑阶段专用鼓组

  let _isRunning = false;
  let _isBattleMode = false;      // 当前是否战斗阶段（决定哪些轨静音）

  let _schedulerTimer = null;     // setTimeout ID for look-ahead
  let _next16thSlot = 0;          // 下一个要调度的 16分音符槽位 (0-63)
  let _current16thSlot = 0;       // 当前正在播放的槽位
  let _loopStartTime = 0;         // 当前循环开始的 AudioContext 时间
  let _loopCount = 0;

  let _lastBeatInLoop = -1;       // 上一循环内拍号 (0-15)，用于 onBeat 触发

  // ---- 回调 ----
  let _onBeatCallback = null;     // (beatNumber, contextTime) => void
  let _onLoopCompleteCallback = null; // () => void
  let _loopCompletePending = false;   // 当前循环是否已发送过回调

  // ---- MIDI 音高 → 频率 ----
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // ---- 音色合成器 ----

  /** Bass: 锯齿波 → 低通滤波器 → gain */
  function createBassVoice(note, vel, startTime, duration) {
    const osc = _ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(midiToFreq(note), startTime);

    const filter = _ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, startTime);
    filter.Q.setValueAtTime(2, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.35 * vel, startTime + 0.01);
    env.gain.linearRampToValueAtTime(0.25 * vel, startTime + duration * 0.6);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(_trackGains.bass);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  /** Melody: 方波 → 带共振低通 → gain（chiptune风格） */
  function createMelodyVoice(note, vel, startTime, duration) {
    const osc = _ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(midiToFreq(note), startTime);

    const filter = _ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, startTime);
    filter.Q.setValueAtTime(4, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0, startTime);
    env.gain.linearRampToValueAtTime(0.18 * vel, startTime + 0.005);
    env.gain.linearRampToValueAtTime(0.14 * vel, startTime + duration * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    // 添加轻微颤音
    const lfo = _ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(5, startTime);
    const lfoGain = _ctx.createGain();
    lfoGain.gain.setValueAtTime(2, startTime);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(startTime);
    lfo.stop(startTime + duration);

    osc.connect(filter);
    filter.connect(env);
    env.connect(_trackGains.melody);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  /** Drum: Kick — 正弦波滑音 */
  function createKick(vel, startTime) {
    const osc = _ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, startTime);
    osc.frequency.exponentialRampToValueAtTime(30, startTime + 0.08);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.8 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.12);

    osc.connect(env);
    env.connect(_trackGains.drums);

    osc.start(startTime);
    osc.stop(startTime + 0.12);
  }

  /** Drum: Snare — 噪声 + 正弦波混合 */
  function createSnare(vel, startTime) {
    const bufferSize = _ctx.sampleRate * 0.1;
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = _ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1200, startTime);
    noiseFilter.Q.setValueAtTime(0.5, startTime);

    const noiseEnv = _ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.5 * vel, startTime);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, startTime + 0.08);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseEnv);
    noiseEnv.connect(_trackGains.drums);
    noise.start(startTime);
    noise.stop(startTime + 0.08);

    // 叠加低频正弦
    const osc = _ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, startTime);
    const oscEnv = _ctx.createGain();
    oscEnv.gain.setValueAtTime(0.35 * vel, startTime);
    oscEnv.gain.exponentialRampToValueAtTime(0.001, startTime + 0.06);
    osc.connect(oscEnv);
    oscEnv.connect(_trackGains.drums);
    osc.start(startTime);
    osc.stop(startTime + 0.06);
  }

  /** Drum: Hi-hat Closed — 高通噪声 */
  function createHihatClosed(vel, startTime) {
    const bufferSize = _ctx.sampleRate * 0.05;
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const hpFilter = _ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(8000, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.3 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.03);

    noise.connect(hpFilter);
    hpFilter.connect(env);
    env.connect(_trackGains.drums);

    noise.start(startTime);
    noise.stop(startTime + 0.03);
  }

  /** Drum: Hi-hat Open — 更长的噪声 */
  function createHihatOpen(vel, startTime) {
    const bufferSize = _ctx.sampleRate * 0.12;
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const hpFilter = _ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(6000, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.35 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.1);

    noise.connect(hpFilter);
    hpFilter.connect(env);
    env.connect(_trackGains.drums);

    noise.start(startTime);
    noise.stop(startTime + 0.1);
  }

  /** Drum: Clap — 多次噪声 burst */
  function createClap(vel, startTime) {
    const bufferSize = _ctx.sampleRate * 0.08;
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const bpFilter = _ctx.createBiquadFilter();
    bpFilter.type = 'bandpass';
    bpFilter.frequency.setValueAtTime(2000, startTime);
    bpFilter.Q.setValueAtTime(0.6, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.4 * vel, startTime);
    env.gain.linearRampToValueAtTime(0.2 * vel, startTime + 0.01);
    env.gain.linearRampToValueAtTime(0.25 * vel, startTime + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.06);

    noise.connect(bpFilter);
    bpFilter.connect(env);
    env.connect(_trackGains.drums);

    noise.start(startTime);
    noise.stop(startTime + 0.06);
  }

  /** Drum: Crash — 长噪声撞击 */
  function createCrash(vel, startTime) {
    const bufferSize = _ctx.sampleRate * 0.4;
    const noiseBuffer = _ctx.createBuffer(1, bufferSize, _ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = _ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const hpFilter = _ctx.createBiquadFilter();
    hpFilter.type = 'highpass';
    hpFilter.frequency.setValueAtTime(4000, startTime);

    const env = _ctx.createGain();
    env.gain.setValueAtTime(0.5 * vel, startTime);
    env.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);

    noise.connect(hpFilter);
    hpFilter.connect(env);
    env.connect(_trackGains.drums);

    noise.start(startTime);
    noise.stop(startTime + 0.35);
  }

  /** 根据鼓类型播放 */
  function playDrum(type, vel, startTime) {
    switch (type) {
      case 'kick': createKick(vel, startTime); break;
      case 'snare': createSnare(vel, startTime); break;
      case 'hihat_closed': createHihatClosed(vel, startTime); break;
      case 'hihat_open': createHihatOpen(vel, startTime); break;
      case 'clap': createClap(vel, startTime); break;
      case 'crash': createCrash(vel, startTime); break;
    }
  }

  // ---- 乐谱查找表构建 ----

  /** 将乐谱 events 数组转为 16分音符槽位查找表 */
  function buildSlotTable(events, total16th, isDrumTrack) {
    const slots = new Array(total16th);
    for (let i = 0; i < total16th; i++) {
      slots[i] = [];
    }

    for (const ev of events) {
      const slot = Math.round(ev.beat * 4); // beat*4 = 16分音符槽位索引
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

  /**
   * look-ahead 调度：每 50ms 唤醒，提前调度未来 100ms 内的音符
   * 使用 AudioContext.currentTime 而非 setTimeout 计时
   */
  function scheduleLoop() {
    if (!_isRunning) return;

    const now = _ctx.currentTime;
    const lookAhead = 0.1; // 提前调度 100ms

    // 计算当前时间对应的16分音符槽位
    const elapsedInLoop = now - _loopStartTime;
    const totalLoopDuration = _beatsPerLoop * _beatDuration;

    // 如果当前循环已结束，进入下一循环
    if (elapsedInLoop >= totalLoopDuration) {
      _loopStartTime += totalLoopDuration;
      _loopCount++;
      _next16thSlot = 0;
      _lastBeatInLoop = -1;
      _loopCompletePending = false;

      // 发送循环完成回调
      if (_onLoopCompleteCallback) {
        _onLoopCompleteCallback();
      }
      _loopCompletePending = true;

      // 继续调度
      _schedulerTimer = setTimeout(scheduleLoop, 25);
      return;
    }

    // 当前槽位
    const currentSlotFloat = (elapsedInLoop / totalLoopDuration) * _score.total16th;
    _current16thSlot = Math.floor(currentSlotFloat);

    // 向前调度直到 lookAhead 结束
    const lookAheadEnd = now + lookAhead;
    let slotToSchedule = _next16thSlot;

    while (slotToSchedule < _score.total16th) {
      const slotTime = _loopStartTime + slotToSchedule * _sixteenthDuration;
      if (slotTime > lookAheadEnd) break;

      // 调度此槽位的所有音符
      scheduleSlot(slotToSchedule, slotTime);
      slotToSchedule++;
    }

    _next16thSlot = slotToSchedule;

    // 检测节拍变化 → 触发 onBeat
    checkBeatChange(currentSlotFloat);

    // 继续调度循环
    _schedulerTimer = setTimeout(scheduleLoop, 50);
  }

  /** 调度某个16分音符槽位的所有音符 */
  function scheduleSlot(slot, time) {
    // Bass
    for (const ev of _score.bassSlots[slot]) {
      createBassVoice(ev.note, ev.vel, time, ev.duration);
    }
    // Melody（仅在战斗阶段）
    if (_isBattleMode) {
      for (const ev of _score.melodySlots[slot]) {
        createMelodyVoice(ev.note, ev.vel, time, ev.duration);
      }
    }
    // Drums（战斗阶段全鼓，编辑阶段仅 hi-hat）
    const drumEvents = _isBattleMode
      ? _score.drumsSlots[slot]
      : (_editDrums ? _editDrums[slot] : []);
    for (const ev of drumEvents) {
      playDrum(ev.drumType, ev.vel, time);
    }
  }

  /** 检测是否跨越了节拍边界，触发 onBeat */
  function checkBeatChange(currentSlotFloat) {
    // 每拍 = 4个16分音符
    const currentBeat = Math.floor(currentSlotFloat / 4);
    if (currentBeat !== _lastBeatInLoop) {
      _lastBeatInLoop = currentBeat;
      if (_onBeatCallback && currentBeat >= 0 && currentBeat < _beatsPerLoop) {
        console.log('[MUSIC] Beat ' + currentBeat + '/' + (_beatsPerLoop-1) + ' | loop=' + _loopCount + ' | slot=' + Math.floor(currentSlotFloat) + '/' + (_score?.total16th-1 || 63) + ' | ctxTime=' + _ctx.currentTime.toFixed(3));
        _onBeatCallback(currentBeat, _ctx.currentTime);
      }
    }
  }

  // ---- 公开 API ----

  const api = {
    /** 获取每拍时长（秒） */
    get beatDuration() { return _beatDuration; },
    /** 每循环拍数 */
    get beatsPerLoop() { return _beatsPerLoop; },
    /** 循环总时长（秒） */
    get loopDuration() { return _beatsPerLoop * _beatDuration; },
    /** 是否正在播放 */
    get isRunning() { return _isRunning; },
    /** 是否战斗模式 */
    get isBattleMode() { return _isBattleMode; },
    /** AudioContext */
    get ctx() { return _ctx; },
    /** 当前循环数 */
    get loopCount() { return _loopCount; },
    /** 当前循环内拍号 (0-15) */
    get currentBeatInLoop() { return _lastBeatInLoop; },

    /**
     * 初始化引擎，创建 AudioContext 和节点图
     * 必须在用户手势后调用（浏览器自动播放策略）
     * @returns {boolean} 是否成功
     */
    init() {
      if (_ctx) return true;

      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.warn('[MusicEngine] AudioContext不可用:', e.message);
        return false;
      }

      // 主音量
      _masterGain = _ctx.createGain();
      _masterGain.gain.setValueAtTime(0.5, _ctx.currentTime);
      _masterGain.connect(_ctx.destination);

      // 三条音轨增益节点
      _trackGains.bass = _ctx.createGain();
      _trackGains.bass.gain.setValueAtTime(0.8, _ctx.currentTime);
      _trackGains.bass.connect(_masterGain);

      _trackGains.melody = _ctx.createGain();
      _trackGains.melody.gain.setValueAtTime(0.7, _ctx.currentTime);
      _trackGains.melody.connect(_masterGain);

      _trackGains.drums = _ctx.createGain();
      _trackGains.drums.gain.setValueAtTime(0.75, _ctx.currentTime);
      _trackGains.drums.connect(_masterGain);

      return true;
    },

    /**
     * 加载乐谱配置
     * @param {object} scoreData - music.json 的数据
     */
    loadScore(scoreData) {
      _bpm = scoreData._meta?.bpm || 120;
      _beatDuration = 60 / _bpm;
      _sixteenthDuration = _beatDuration / 4;
      _beatsPerLoop = scoreData._meta?.totalBeats || 16;

      const total16th = scoreData._meta?.total16thNotes || 64;

      _score = {
        total16th,
        bassSlots: buildSlotTable(scoreData.bass || [], total16th, false),
        melodySlots: buildSlotTable(scoreData.melody || [], total16th, false),
        drumsSlots: buildSlotTable(scoreData.drums || [], total16th, true),
      };

      // 编辑阶段的轻量鼓组（仅 hi-hat）
      if (scoreData.editOnlyDrums) {
        _editDrums = buildSlotTable(scoreData.editOnlyDrums, total16th, true);
      }
    },

    /**
     * 注册节拍回调
     * @param {function} cb - (beatNumber, contextTime) => void
     */
    onBeat(cb) {
      _onBeatCallback = cb;
    },

    /**
     * 注册循环完成回调（4小节播完触发一次）
     * @param {function} cb - () => void
     */
    onLoopComplete(cb) {
      _onLoopCompleteCallback = cb;
    },

    /**
     * 开始播放
     * @param {'edit'|'battle'} [mode='edit'] - 初始模式
     */
    start(mode = 'edit') {
      if (!_ctx) {
        if (!api.init()) return;
      }

      if (_ctx.state === 'suspended') {
        _ctx.resume();
      }

      _isRunning = true;
      _isBattleMode = (mode === 'battle');
      _next16thSlot = 0;
      _current16thSlot = 0;
      _loopStartTime = _ctx.currentTime + 0.05; // 延迟5ms开始，避免初始卡顿
      _loopCount = 0;
      _lastBeatInLoop = -1;
      _loopCompletePending = false;

      // 更新轨道增益
      api._updateTrackGains();

      // 启动调度器
      scheduleLoop();
    },

    /** 更新音轨增益（根据当前模式） */
    _updateTrackGains() {
      if (!_ctx) return;
      const now = _ctx.currentTime;
      // 旋律轨：仅在战斗阶段开启
      _trackGains.melody.gain.cancelScheduledValues(now);
      _trackGains.melody.gain.setValueAtTime(
        _isBattleMode ? 0.7 : 0,
        now
      );
      // 鼓轨：战斗阶段全音量，编辑阶段保持全音量（editOnlyDrums 来控制内容）
      _trackGains.drums.gain.cancelScheduledValues(now);
      _trackGains.drums.gain.setValueAtTime(0.75, now);
    },

    /**
     * 切换到战斗模式（打开旋律轨和全鼓组）
     * 在下一个循环边界生效
     */
    enterBattleMode() {
      if (!_isRunning) return;
      _isBattleMode = true;
      if (_ctx) {
        const now = _ctx.currentTime;
        _trackGains.melody.gain.cancelScheduledValues(now);
        _trackGains.melody.gain.linearRampToValueAtTime(0.7, now + 0.02);
      }
    },

    /**
     * 切换到编辑模式（关闭旋律轨，仅 hi-hat）
     */
    enterEditMode() {
      if (!_isRunning) return;
      _isBattleMode = false;
      if (_ctx) {
        const now = _ctx.currentTime;
        _trackGains.melody.gain.cancelScheduledValues(now);
        _trackGains.melody.gain.linearRampToValueAtTime(0, now + 0.3);
      }
    },

    /** 停止播放 */
    stop() {
      _isRunning = false;
      _isBattleMode = false;

      if (_schedulerTimer) {
        clearTimeout(_schedulerTimer);
        _schedulerTimer = null;
      }
    },

    /** 暂停（可恢复） */
    suspend() {
      if (_ctx && _ctx.state === 'running') {
        _ctx.suspend();
      }
      api.stop();
    },

    /** 恢复播放 */
    resume(mode) {
      if (_ctx && _ctx.state === 'suspended') {
        _ctx.resume();
      }
      if (!_isRunning) {
        api.start(mode);
      }
    },

    /** 设置主音量 (0-1) */
    setVolume(vol) {
      if (_masterGain && _ctx) {
        const now = _ctx.currentTime;
        _masterGain.gain.cancelScheduledValues(now);
        _masterGain.gain.linearRampToValueAtTime(
          Math.max(0, Math.min(1, vol)),
          now + 0.05
        );
      }
    },

    /** 销毁引擎，释放资源 */
    destroy() {
      api.stop();
      if (_ctx) {
        _ctx.close();
        _ctx = null;
      }
      _masterGain = null;
      _trackGains = {};
      _score = null;
      _editDrums = null;
      _onBeatCallback = null;
      _onLoopCompleteCallback = null;
    },
  };

  return api;
})();
