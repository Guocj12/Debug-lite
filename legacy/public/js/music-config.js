// ============================================================
// MusicConfig — 乐谱加载与 MusicEngine 桥接
// ============================================================

const MusicConfig = {
  _loaded: false,

  /**
   * 从服务端加载 music.json 并注入 MusicEngine
   * @returns {Promise<boolean>}
   */
  async load() {
    if (this._loaded) return true;

    try {
      const resp = await fetch('/data/music.json');
      if (!resp.ok) {
        console.warn('[MusicConfig] 无法加载 music.json:', resp.status);
        return false;
      }
      const score = await resp.json();
      MusicEngine.loadScore(score);
      this._loaded = true;
      return true;
    } catch (e) {
      console.warn('[MusicConfig] 加载乐谱失败:', e.message);
      return false;
    }
  },

  /** 是否已加载 */
  get isLoaded() { return this._loaded; },
};
