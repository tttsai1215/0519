'use strict';

// ─────────────────────────────────────────────────────────────
//  系統環境與靜態配置 (CONFIG)
// ─────────────────────────────────────────────────────────────
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;

// 將 DOM 元件改為全域變數，延遲到網頁載入完成後再綁定
let gameCanvas, ctx, videoElement;

const GAME_WEAPONS = ['rock', 'paper', 'scissors'];
const ICON_MAP = { rock: '✊', paper: '🖐', scissors: '✌️', signal_continue: '☝️', signal_quit: '✊' };
const LABEL_MAP = { rock: '石頭', paper: '布', scissors: '剪刀', signal_continue: '食指繼續', signal_quit: '握拳結束' };
const RULES_MATRIX = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

// 賽博龐克街機霓虹配色
const CYBER_PALETTE = ['#FF007F', '#00F0FF', '#7000FF', '#FFB800', '#00FF66', '#FF5555'];
const HAND_BONES_STRUCTURE = [
    [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];

// ─────────────────────────────────────────────────────────────
//  全域動態狀態管理 (STATE)
// ─────────────────────────────────────────────────────────────
let currentPhase = 'initial_loading'; // 階段：initial_loading, lobby_waiting, match_countdown, result_reveal, victory, defeat, stalemate, menu_selection, game_terminated
let phaseTimestamp = Date.now();
const switchPhase = (targetPhase) => { currentPhase = targetPhase; phaseTimestamp = Date.now(); };

let playerMove = null;
let cpuMove = null;
let detectedPoints = null; 
let verifiedGesture = null; 
let trackingHandSide = null;

let gestureHistory = [];
let executionLockTimer = null;
let backgroundEffectAlpha = 0;

const STABILITY_QUEUE_SIZE = 8;
const LOCK_TRIGGER_MS = 500; // 蓄力定格判定時間 (0.5秒)
const COUNTDOWN_SECONDS = 3;

let recordTracker = { playerWins: 0, cpuWins: 0, stalemates: 0 };
let visualEffectsContainer = [];

let cursorX = 0, cursorY = 0;

// ─────────────────────────────────────────────────────────────
//  網頁載入安全防禦核心 (DOM READY & INITIALIZATION)
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    // 1. 安全綁定網頁元件
    gameCanvas = document.getElementById('c');
    if (!gameCanvas) {
        console.error("錯誤：找不到 ID 為 'c' 的 canvas 標籤，請確認 HTML 結構。");
        return;
    }
    ctx = gameCanvas.getContext('2d');
    videoElement = document.getElementById('vid');

    // 2. 監聽滑鼠與點擊事件
    gameCanvas.addEventListener('mousemove', event => {
        const boundaries = gameCanvas.getBoundingClientRect();
        cursorX = event.clientX - boundaries.left;
        cursorY = event.clientY - boundaries.top;
    });
    gameCanvas.addEventListener('click', handleCanvasClick);

    // 3. 啟動 MediaPipe 核心
    initializeMediaPipe();

    // 4. 正式推進渲染主循環
    masterGameLoop();
});

// ─────────────────────────────────────────────────────────────
//  MEDIAPIPE & 攝影機安全初始化
// ─────────────────────────────────────────────────────────────
function initializeMediaPipe() {
    const visionHands = new Hands({ locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    visionHands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.75, minTrackingConfidence: 0.6 });
    
    visionHands.onResults(results => {
        if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            detectedPoints = results.multiHandLandmarks[0];
            trackingHandSide = results.multiHandedness[0].label;
            const rawTag = analyzeCoordinates(detectedPoints);
            
            gestureHistory.push(rawTag);
            if (gestureHistory.length > STABILITY_QUEUE_SIZE) gestureHistory.shift();
            verifiedGesture = filterDominantGesture(gestureHistory);
        } else {
            detectedPoints = null; verifiedGesture = null; trackingHandSide = null; gestureHistory = [];
        }
    });

    if (videoElement) {
        try {
            const camera = new Camera(videoElement, { 
                onFrame: async () => { await visionHands.send({ image: videoElement }); }, 
                width: CANVAS_WIDTH, 
                height: CANVAS_HEIGHT 
            });
            camera.start()
                .then(() => { if (currentPhase === 'initial_loading') switchPhase('lobby_waiting'); })
                .catch(err => {
                    console.warn("攝影機啟動失敗（可能無鏡頭或未允許權限），切換至無鏡頭預覽模式:", err);
                    if (currentPhase === 'initial_loading') switchPhase('lobby_waiting');
                });
        } catch (e) {
            console.warn("無法初始化攝影機物件（目前環境無裝置），維持無鏡頭預覽模式。");
            if (currentPhase === 'initial_loading') switchPhase('lobby_waiting');
        }
    } else {
        if (currentPhase === 'initial_loading') switchPhase('lobby_waiting');
    }
}

// ─────────────────────────────────────────────────────────────
//  手勢運算與特徵判定解碼 (CLASSIFICATION)
// ─────────────────────────────────────────────────────────────
function analyzeCoordinates(pts) {
    const indexExtended = pts[8].y < pts[6].y;
    const middleExtended = pts[12].y < pts[10].y;
    const ringExtended = pts[16].y < pts[14].y;
    const pinkyExtended = pts[20].y < pts[18].y;

    if (!indexExtended && !middleExtended && !ringExtended && !pinkyExtended) return 'rock';
    if (indexExtended && middleExtended && ringExtended && pinkyExtended) return 'paper';
    if (indexExtended && middleExtended && !ringExtended && !pinkyExtended) return 'scissors';
    
    // 選單控制手勢：☝️ 僅食指伸直 = 繼續遊戲
    if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) return 'signal_continue';
    
    return 'unidentified';
}

function filterDominantGesture(historyArray) {
    if (historyArray.length < 4) return null;
    const dynamicCounter = {};
    historyArray.forEach(item => { if (item !== 'unidentified') dynamicCounter[item] = (dynamicCounter[item] || 0) + 1; });
    let topGesture = null; let highestCount = 0;
    for (const key in dynamicCounter) {
        if (dynamicCounter[key] > highestCount) { highestCount = dynamicCounter[key]; topGesture = key; }
    }
    return (highestCount / historyArray.length) >= 0.6 ? topGesture : null;
}

// ─────────────────────────────────────────────────────────────
//  全新八位元像素粒子爆破系統 (PIXEL PARTICLES)
// ─────────────────────────────────────────────────────────────
function createPixelExplosion(originX, originY, colorHex) {
    const targetColor = colorHex || CYBER_PALETTE[Math.floor(Math.random() * CYBER_PALETTE.length)];
    for (let i = 0; i < 45; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 7 + 2;
        visualEffectsContainer.push({
            posX: originX, posY: originY,
            velX: Math.cos(angle) * speed, velY: Math.sin(angle) * speed - 1.5,
            remainingLife: 1.0, decayRate: Math.random() * 0.02 + 0.012,
            blockSize: Math.random() * 7 + 4, renderColor: targetColor
        });
    }
}

function updateAndRenderEffects() {
    visualEffectsContainer.forEach(part => {
        part.posX += part.velX; part.posY += part.velY;
        part.velY += 0.22; 
        part.velX *= 0.98;
        part.remainingLife -= part.decayRate;
        
        ctx.save();
        ctx.globalAlpha = part.remainingLife;
        ctx.fillStyle = part.renderColor;
        ctx.fillRect(part.posX, part.posY, part.blockSize, part.blockSize);
        ctx.restore();
    });
    visualEffectsContainer = visualEffectsContainer.filter(part => part.remainingLife > 0);
}

// ─────────────────────────────────────────────────────────────
//  全新原創：數位訊號故障與黑客警告效果 (GLITCH FAILURE MASK)
// ─────────────────────────────────────────────────────────────
function triggerGlitchPattern(intensity) {
    if (intensity <= 0) return;
    ctx.save();
    ctx.globalAlpha = intensity * 0.35;
    ctx.fillStyle = '#12021C';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    ctx.fillStyle = '#FF0055';
    for (let i = 0; i < 5; i++) {
        const barY = Math.random() * CANVAS_HEIGHT;
        const barHeight = Math.random() * 18 + 2;
        ctx.fillRect(0, barY, CANVAS_WIDTH, barHeight);
    }
    
    ctx.globalAlpha = intensity;
    ctx.fillStyle = '#000000';
    ctx.strokeStyle = '#FF0055';
    ctx.lineWidth = 3;
    ctx.fillRect(CANVAS_WIDTH / 2 - 160, CANVAS_HEIGHT / 2 - 45, 320, 90);
    ctx.strokeRect(CANVAS_WIDTH / 2 - 160, CANVAS_HEIGHT / 2 - 45, 320, 90);
    
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#FF0055';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚡ SYSTEM CRASHED ⚡', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 15);
    
    ctx.font = '13px monospace';
    ctx.fillStyle = '#00FFFF';
    ctx.fillText('CPU MATRIX OVERLOADED', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 20);
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────
//  繪圖與視覺增強工具組 (UI RENDERING)
// ─────────────────────────────────────────────────────────────
function drawVectorBoneStructure() {
    if (!detectedPoints) return;
    ctx.save();
    ctx.strokeStyle = '#00FFFF'; ctx.lineWidth = 3;
    ctx.shadowBlur = 12; ctx.shadowColor = '#00FFFF';
    
    HAND_BONES_STRUCTURE.forEach(([nodeA, nodeB]) => {
        const startX = (1 - detectedPoints[nodeA].x) * CANVAS_WIDTH;
        const startY = detectedPoints[nodeA].y * CANVAS_HEIGHT;
        const endX = (1 - detectedPoints[nodeB].x) * CANVAS_WIDTH;
        const endY = detectedPoints[nodeB].y * CANVAS_HEIGHT;
        
        ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
    });

    detectedPoints.forEach((pt, idx) => {
        const cx = (1 - pt.x) * CANVAS_WIDTH;
        const cy = pt.y * CANVAS_HEIGHT;
        ctx.fillStyle = idx === 0 ? '#FF007F' : '#00FF66';
        ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(cx, cy, idx === 0 ? 6.5 : 3.5, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
}

function renderCustomText(stringText, posX, posY, fontSize, primaryColor, outlineColor, neonGlow) {
    ctx.save();
    ctx.font = `bold ${fontSize}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (neonGlow) { ctx.shadowColor = neonGlow; ctx.shadowBlur = 22; }
    if (outlineColor) { ctx.strokeStyle = outlineColor; ctx.lineWidth = 4; ctx.strokeText(stringText, posX, posY); }
    ctx.fillStyle = primaryColor || '#FFFFFF'; ctx.fillText(stringText, posX, posY);
    ctx.restore();
}

function renderModernButton(textLabel, startX, startY, blockW, blockH, activeColor) {
    const isHovered = cursorX >= startX && cursorX <= startX + blockW && cursorY >= startY && cursorY <= startY + blockH;
    ctx.save();
    ctx.fillStyle = isHovered ? '#FFFFFF' : activeColor;
    ctx.shadowColor = activeColor; ctx.shadowBlur = isHovered ? 26 : 10;
    
    ctx.fillRect(startX, startY, blockW, blockH);
    ctx.shadowBlur = 0;
    ctx.font = `bold ${Math.floor(blockH * 0.36)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? activeColor : '#FFFFFF';
    ctx.fillText(textLabel, startX + blockW / 2, startY + blockH / 2);
    ctx.restore();
}

function displayStatsPanel() {
    ctx.save();
    ctx.fillStyle = 'rgba(12, 8, 24, 0.75)';
    ctx.strokeStyle = '#00F0FF'; ctx.lineWidth = 1.5;
    ctx.fillRect(12, 12, 210, 36);
    ctx.strokeRect(12, 12, 210, 36);
    
    ctx.font = 'bold 12px Arial'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#00FF66'; ctx.fillText(`🟢 勝局: ${recordTracker.playerWins}`, 24, 30);
    ctx.fillStyle = '#FF0055'; ctx.fillText(`🔴 敗局: ${recordTracker.cpuWins}`, 94, 30);
    ctx.fillStyle = '#FFB800'; ctx.fillText(`🟡 平手: ${recordTracker.stalemates}`, 164, 30);
    ctx.restore();
}

function displayInteractiveCard(gestureKey, coordX, coordY, cardW, cardH, themeColor, currentAlpha = 1) {
    ctx.save(); ctx.globalAlpha = currentAlpha;
    ctx.fillStyle = 'rgba(20, 15, 35, 0.82)';
    ctx.strokeStyle = themeColor; ctx.lineWidth = 2.5;
    
    ctx.fillRect(coordX, coordY, cardW, cardH);
    ctx.strokeRect(coordX, coordY, cardW, cardH);
    
    ctx.font = `${Math.floor(cardH * 0.44)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ICON_MAP[gestureKey] || '❔', coordX + cardW / 2, coordY + cardH * 0.46);
    
    ctx.font = `bold ${Math.floor(cardH * 0.16)}px Arial`; ctx.fillStyle = themeColor;
    ctx.fillText(LABEL_MAP[gestureKey] || '未知', coordX + cardW / 2, coordY + cardH * 0.8);
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────
//  各狀態渲染子模組 (STATE RENDERERS)
// ─────────────────────────────────────────────────────────────
function renderLoadingScreen() {
    ctx.fillStyle = '#080510'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const cycle = Date.now() / 1000;
    renderCustomText('🌌 載入 AI 矩陣核心中...', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 20, 24, '#00FFFF', null, '#00FFFF');
    ctx.save(); ctx.strokeStyle = '#FF007F'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 35, 22, cycle * 3, cycle * 3 + Math.PI * 1.3); ctx.stroke(); ctx.restore();
}

function renderLobbyScreen() {
    drawVectorBoneStructure(); displayStatsPanel();
    ctx.fillStyle = 'rgba(8, 4, 16, 0.85)'; ctx.fillRect(0, CANVAS_HEIGHT - 110, CANVAS_WIDTH, 110);

    if (!detectedPoints) {
        renderCustomText('請將手部主體對準視訊鏡頭', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 70, 20, '#FFFFFF');
        renderCustomText('可出拳：✊ 石頭 · 🖐 布 · ✌️ 剪刀', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 40, 14, 'rgba(255,255,255,0.5)');
    } else if (verifiedGesture) {
        const isValidWeapon = GAME_WEAPONS.includes(verifiedGesture);
        renderCustomText(isValidWeapon ? `準備就緒：${ICON_MAP[verifiedGesture]} ${LABEL_MAP[verifiedGesture]}` : '⚠️ 請做出正確出拳姿勢，勿比其他動作', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 80, 18, isValidWeapon ? '#00FF66' : '#FFB800');
        
        const ratio = executionLockTimer ? Math.min(1, (Date.now() - executionLockTimer) / LOCK_TRIGGER_MS) : 0;
        ctx.fillStyle = '#221930'; ctx.fillRect(CANVAS_WIDTH / 2 - 110, CANVAS_HEIGHT - 50, 220, 10);
        ctx.fillStyle = ratio < 0.9 ? '#FFB800' : '#00FF66'; ctx.fillRect(CANVAS_WIDTH / 2 - 110, CANVAS_HEIGHT - 50, 220 * ratio, 10);
    }
}

function renderCountdownScreen() {
    const elapsed = Date.now() - phaseTimestamp;
    drawVectorBoneStructure(); displayStatsPanel();
    
    const secondsLeft = Math.ceil((COUNTDOWN_SECONDS * 1000 - elapsed) / 1000);
    const pulse = 1 + 0.15 * Math.abs(Math.sin(elapsed / 250));
    
    ctx.save(); ctx.translate(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2); ctx.scale(pulse, pulse);
    ctx.font = 'bold 96px Arial'; ctx.fillStyle = secondsLeft === 1 ? '#FF0055' : secondsLeft === 2 ? '#FFB800' : '#00FF66';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(secondsLeft > 0 ? secondsLeft : '出拳！', 0, 0); ctx.restore();

    ctx.fillStyle = 'rgba(5, 3, 10, 0.75)'; ctx.fillRect(0, 0, CANVAS_WIDTH, 54);
    renderCustomText(`當前鎖定手勢: ${ICON_MAP[playerMove] || '❓'} ${LABEL_MAP[playerMove]}`, CANVAS_WIDTH / 2, 27, 18, '#FFFFFF');
}

function renderRevealScreen() {
    const delta = Date.now() - phaseTimestamp;
    const alphaRatio = Math.min(1, Math.max(0, (delta - 300) / 400));
    
    ctx.fillStyle = 'rgba(10, 6, 18, 0.92)'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    renderCustomText('PLAYER', CANVAS_WIDTH / 4, 45, 18, '#00FFFF');
    renderCustomText('COMPUTER', CANVAS_WIDTH * 3 / 4, 45, 18, '#FF007F');
    renderCustomText('VS', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 34, '#FFFFFF', '#000000', '#FFFFFF');
    
    displayInteractiveCard(playerMove, 55, CANVAS_HEIGHT / 2 - 65, 190, 130, '#00FFFF');
    displayInteractiveCard(cpuMove, CANVAS_WIDTH - 245, CANVAS_HEIGHT / 2 - 65, 190, 130, '#FF007F', alphaRatio);
    displayStatsPanel();
}

function renderVictoryScreen() { updateAndRenderEffects(); displayStatsPanel(); renderCustomText('✨ ROUND VICTORY 🎉', CANVAS_WIDTH / 2, 60, 34, '#FFB800', '#FF007F', '#FFB800'); }
function renderDefeatScreen() { const delta = Date.now() - phaseTimestamp; backgroundEffectAlpha = Math.min(1, delta / 600); triggerGlitchPattern(backgroundEffectAlpha); displayStatsPanel(); renderCustomText('⚡ DEFEATED ⚡', CANVAS_WIDTH / 2, 60, 34, '#FF0055', '#000000'); }
function renderStalemateScreen() { displayStatsPanel(); renderCustomText('🤝 STALEMATE DRAW 🤝', CANVAS_WIDTH / 2, 60, 34, '#FFB800', '#000000'); }

function renderSelectionMenu() {
    ctx.fillStyle = 'rgba(12, 8, 22, 0.88)'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    displayStatsPanel();
    renderCustomText('下一回合，重啟作戰？', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 75, 28, '#FFFFFF');
    
    renderCustomText('💡 街機手勢：☝️ 伸出食指 🚀 繼續  ·  ✊ 握拳 🚪 結束', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 15, 14, '#00FFFF');
    
    const btnW = 120, btnH = 46, btnY = CANVAS_HEIGHT / 2 + 45;
    renderModernButton('🚪 QUIT', CANVAS_WIDTH / 2 - btnW - 16, btnY, btnW, btnH, '#FF0055');
    renderModernButton('🚀 AGAIN', CANVAS_WIDTH / 2 + 16, btnY, btnW, btnH, '#00FF66');

    if (currentPhase === 'menu_selection' && (verifiedGesture === 'signal_continue' || verifiedGesture === 'rock')) {
        const ratio = executionLockTimer ? Math.min(1, (Date.now() - executionLockTimer) / LOCK_TRIGGER_MS) : 0;
        const isContinue = verifiedGesture === 'signal_continue';
        const colorBar = isContinue ? '#00FF66' : '#FF0055';
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'; ctx.fillRect(CANVAS_WIDTH / 2 - 90, CANVAS_HEIGHT / 2 + 115, 180, 6);
        ctx.fillStyle = colorBar; ctx.fillRect(CANVAS_WIDTH / 2 - 90, CANVAS_HEIGHT / 2 + 115, 180 * ratio, 6);
        renderCustomText(isContinue ? '🚀 連線加載中...' : '🚪 正在關閉終端...', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 140, 15, colorBar);
    }
}

function renderTerminationScreen() {
    ctx.fillStyle = '#06040A'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    renderCustomText('🎮 SESSION ENDED 🎮', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 25, 30, '#FFFFFF', null, '#FF0055');
    renderCustomText(`總計最終斬獲：${recordTracker.playerWins} 場卓越勝利`, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 25, 15, '#00FFFF');
}

// ─────────────────────────────────────────────────────────────
//  主控制引擎更新邏輯 (UPDATE & LOOP)
// ─────────────────────────────────────────────────────────────
function updateCoreEngine() {
    const currentTimestamp = Date.now();
    const elapsedInPhase = currentTimestamp - phaseTimestamp;

    if (currentPhase === 'menu_selection') {
        if (verifiedGesture === 'signal_continue' || verifiedGesture === 'rock') {
            if (!executionLockTimer) executionLockTimer = currentTimestamp;
            if (currentTimestamp - executionLockTimer >= LOCK_TRIGGER_MS) {
                if (verifiedGesture === 'signal_continue') resetGameToLobby();
                else switchPhase('game_terminated');
                executionLockTimer = null;
            }
        } else { executionLockTimer = null; }
    }

    if (currentPhase === 'lobby_waiting') {
        if (verifiedGesture && GAME_WEAPONS.includes(verifiedGesture)) {
            if (playerMove !== verifiedGesture) { executionLockTimer = currentTimestamp; playerMove = verifiedGesture; }
            if (currentTimestamp - executionLockTimer >= LOCK_TRIGGER_MS) switchPhase('match_countdown');
        } else if (verifiedGesture === 'signal_continue' || !detectedPoints) {
            executionLockTimer = null; playerMove = null;
        }
    }

    if (currentPhase === 'match_countdown') {
        if (verifiedGesture && GAME_WEAPONS.includes(verifiedGesture)) playerMove = verifiedGesture;
        if (elapsedInPhase >= COUNTDOWN_SECONDS * 1000) {
            if (!playerMove) playerMove = GAME_WEAPONS[Math.floor(Math.random() * 3)];
            cpuMove = GAME_WEAPONS[Math.floor(Math.random() * 3)];
            switchPhase('result_reveal');
        }
    }

    if (currentPhase === 'result_reveal' && elapsedInPhase > 1500) {
        const gameVerdict = playerMove === cpuMove ? 'stalemate' : RULES_MATRIX[playerMove] === cpuMove ? 'victory' : 'defeat';
        if (gameVerdict === 'victory') {
            recordTracker.playerWins++;
            createPixelExplosion(CANVAS_WIDTH / 3, CANVAS_HEIGHT / 2);
            createPixelExplosion(CANVAS_WIDTH * 2 / 3, CANVAS_HEIGHT / 2);
        } else if (gameVerdict === 'defeat') { recordTracker.cpuWins++; }
        else { recordTracker.stalemates++; }
        switchPhase(gameVerdict); backgroundEffectAlpha = 0;
    }

    if (currentPhase === 'victory' && elapsedInPhase > 3800) switchPhase('menu_selection');
    if (currentPhase === 'defeat' && elapsedInPhase > 3500) switchPhase('menu_selection');
    if (currentPhase === 'stalemate' && elapsedInPhase > 2400) switchPhase('menu_selection');
}

function handleCanvasClick(e) {
    if (currentPhase !== 'menu_selection') return;
    const bounds = gameCanvas.getBoundingClientRect();
    const clkX = e.clientX - bounds.left; const clkY = e.clientY - bounds.top;
    const btnW = 120, btnH = 46, btnY = CANVAS_HEIGHT / 2 + 45;
    
    if (clkX >= CANVAS_WIDTH / 2 + 16 && clkX <= CANVAS_WIDTH / 2 + 16 + btnW && clkY >= btnY && clkY <= btnY + btnH) resetGameToLobby();
    if (clkX >= CANVAS_WIDTH / 2 - btnW - 16 && clkX <= CANVAS_WIDTH / 2 - 16 && clkY >= btnY && clkY <= btnY + btnH) switchPhase('game_terminated');
}

function resetGameToLobby() {
    visualEffectsContainer = []; backgroundEffectAlpha = 0; gestureHistory = []; verifiedGesture = null;
    executionLockTimer = null; playerMove = null; cpuMove = null; switchPhase('lobby_waiting');
}

function masterGameLoop() {
    updateCoreEngine();
    
    // 安全防禦：如果 ctx 還沒初始化，先跳過這幀
    if (!ctx) {
        requestAnimationFrame(masterGameLoop);
        return;
    }

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    
    if (currentPhase !== 'initial_loading' && currentPhase !== 'game_terminated') {
        if (videoElement && videoElement.readyState >= 2) {
            ctx.save(); ctx.translate(CANVAS_WIDTH, 0); ctx.scale(-1, 1);
            ctx.drawImage(videoElement, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT); ctx.restore();
        }
    }

    const router = {
        initial_loading: renderLoadingScreen, lobby_waiting: renderLobbyScreen, match_countdown: renderCountdownScreen,
        result_reveal: renderRevealScreen, victory: renderVictoryScreen, defeat: renderDefeatScreen,
        stalemate: renderStalemateScreen, menu_selection: renderSelectionMenu, game_terminated: renderTerminationScreen
    };
    (router[currentPhase] || renderLoadingScreen)();
    requestAnimationFrame(masterGameLoop);
}