// Debug-Lite 主入口 - 在线对战时角色选择后的处理

// 在线对战中，双方都选好角色后
function startOnlineGame() {
  if (!selectedCharId) {
    alert('请先选择角色!');
    return;
  }
  if (selectedSkillIds.length === 0) {
    selectedSkillIds = ['slash', 'shield', 'heal'];
  }
  
  game.selectedSkills = selectedSkillIds;
  game.selectedChar = selectedCharId;
  game.gameMode = 'online';
  
  game.socket.emit('selectCharacter', {
    charId: selectedCharId,
    skillIds: selectedSkillIds
  });
  
  showScreen('preparePhase');
  initPreparePhase();
  audio.playBGM('battle');
}

// 覆写角色选择页面的"开始对战"按钮
// 对于在线模式，需要在双方确认后进入
document.addEventListener('DOMContentLoaded', () => {
  // 监听在线模式的角色确认
  const origShowScreen = showScreen;
  
  // 在线模式下角色选择的处理
  const charSelectScreen = document.getElementById('characterSelect');
  if (charSelectScreen) {
    // 检查当前模式
    const observer = new MutationObserver(() => {
      if (charSelectScreen.classList.contains('active')) {
        const startBtn = charSelectScreen.querySelector('.btn-blue');
        if (startBtn && game.gameMode === 'online') {
          startBtn.onclick = startOnlineGame;
          startBtn.textContent = '确认并等待对手';
        } else if (startBtn && game.gameMode !== 'online') {
          startBtn.onclick = startAIGame;
          startBtn.textContent = '开始对战';
        }
      }
    });
    observer.observe(charSelectScreen, { attributes: true, attributeFilter: ['class'] });
  }
});
