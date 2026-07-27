// Debug-Lite 音效引擎 - 使用Web Audio API生成像素风音效

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.3;
    this.currentBGM = null;
    this.bgmInterval = null;
    this.audioData = null;
  }

  async init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 加载音频配置
      const resp = await fetch('/data/audio.json');
      this.audioData = await resp.json();
    } catch (e) {
      console.warn('音频系统初始化失败:', e);
    }
  }

  playTone(freq, duration, delay, type = 'square') {
    if (!this.ctx || !this.enabled) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime + (delay || 0);
    
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(this.volume * 0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  playNotes(notes) {
    if (!this.ctx || !this.enabled) return;
    notes.forEach(note => {
      this.playTone(note.freq, note.dur, note.delay, note.type || 'square');
    });
  }

  playSFX(name) {
    if (!this.audioData || !this.audioData.sfx[name]) return;
    this.playNotes(this.audioData.sfx[name]);
  }

  playBGM(name) {
    this.stopBGM();
    if (!this.audioData || !this.audioData.bgm[name]) return;
    
    const track = this.audioData.bgm[name];
    const beatDuration = 60 / track.bpm;
    let noteIndex = 0;
    
    const playLoop = () => {
      if (noteIndex >= track.notes.length) {
        noteIndex = 0;
        // 添加一个小间隙再循环
        this.bgmInterval = setTimeout(playLoop, beatDuration * 500);
        return;
      }
      
      const note = track.notes[noteIndex];
      this.playTone(note.freq, note.dur, 0, note.type || 'square');
      noteIndex++;
      this.bgmInterval = setTimeout(playLoop, beatDuration * 1000);
    };
    
    playLoop();
  }

  stopBGM() {
    if (this.bgmInterval) {
      clearTimeout(this.bgmInterval);
      this.bgmInterval = null;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stopBGM();
    return this.enabled;
  }

  // 便捷方法
  hit() { this.playSFX('hit'); }
  block() { this.playSFX('block'); }
  skill() { this.playSFX('skill'); }
  heal() { this.playSFX('heal'); }
  countdown() { this.playSFX('countdown'); }
  death() { this.playSFX('death'); }
}

// 全局音频引擎
const audio = new AudioEngine();
