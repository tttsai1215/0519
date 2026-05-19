'use strict';

// ─────────────────────────────────────────────────────────────
//  系統環境與靜態配置 (CONFIG)
// ─────────────────────────────────────────────────────────────
const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 480;

// 將 DOM 元件改為全域變數，延遲到網頁載入完成後再綁定
let gameCanvas, ctx, videoElement;

const GAME_WEAPONS = ['rock', 'paper', 'scissors'];
const ICON_MAP = { rock: '✊', paper: '🖐', scissors: '✌️', signal_thumbs_up: '👍', signal_thumbs_down: '👎' };
const LABEL_MAP = { rock: '石頭', paper: '布', scissors: '剪刀', signal_thumbs_up: '讚 / 繼續', signal_thumbs_down: '倒讚 / 結束' };
const RULES_MATRIX = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

// 復古 8-bit 像素配色
const RETRO_PALETTE = {
    red: '#ff4136', green: '#2ecc40', blue: '#0074d9',
    yellow: '#ffdc00', white: '#ffffff', black: '#111111',
    gray: '#aaaaaa', lightGray: '#dddddd'
};

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
    // 基礎手勢判定
    const isExtended = (tip, pip) => tip.y < pip.y;
    const isCurled = (tip, pip) => tip.y > pip.y;

    const indexExtended = isExtended(pts[8], pts[6]);
    const middleExtended = isExtended(pts[12], pts[10]);
    const ringExtended = isExtended(pts[16], pts[14]);
    const pinkyExtended = isExtended(pts[20], pts[18]);

    const indexCurled = isCurled(pts[8], pts[6]);
    const middleCurled = isCurled(pts[12], pts[10]);
    const ringCurled = isCurled(pts[16], pts[14]);
    const pinkyCurled = isCurled(pts[20], pts[18]);

    // 猜拳手勢
    if (indexCurled && middleCurled && ringCurled && pinkyCurled) return 'rock';
    if (indexExtended && middleExtended && ringExtended && pinkyExtended) return 'paper';
    if (indexExtended && middleExtended && ringCurled && pinkyCurled) return 'scissors';

    // 選單控制手勢：👍 / 👎
    const allFingersCurled = indexCurled && middleCurled && ringCurled && pinkyCurled;
    if (allFingersCurled) {
        if (pts[4].y < pts[3].y && pts[3].y < pts[2].y) return 'signal_thumbs_up';
        if (pts[4].y > pts[3].y && pts[3].y > pts[2].y) return 'signal_thumbs_down';
    }

    return 'unidentified';
}

function filterDominantGesture(historyArray) {
    if (historyArray.length < 4) return null;
    const dynamicCounter = {};
    historyArray.forEach(item => { if (item !== 'unidentified') { dynamicCounter[item] = (dynamicCounter[item] || 0) + 1; } });
    let topGesture = null; let highestCount = 0;
    for (const key in dynamicCounter) {
        if (dynamicCounter[key] > highestCount) { highestCount = dynamicCounter[key]; topGesture = key; }
    }
    return (highestCount / historyArray.length) >= 0.6 ? topGesture : null;
}

// ─────────────────────────────────────────────────────────────
//  復古像素粒子爆破系統 (PIXEL PARTICLES)
// ─────────────────────────────────────────────────────────────
function createRetroExplosion(originX, originY, colorHex) {
    const targetColor = colorHex || Object.values(RETRO_PALETTE)[Math.floor(Math.random() * 6)];
    for (let i = 0; i < 35; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 6 + 1.5;
        visualEffectsContainer.push({
            posX: originX, posY: originY,
            velX: Math.cos(angle) * speed, velY: Math.sin(angle) * speed - 1.5,
            remainingLife: 60, // 存活 60 幀
            blockSize: Math.floor(Math.random() * 5 + 6), renderColor: targetColor
        });
    }
}

function updateAndRenderEffects() {
    visualEffectsContainer.forEach(part => {
        part.posX += part.velX;
        part.posY += part.velY;
        part.velY += 0.18; // 簡化重力
        part.remainingLife--;

        ctx.save();
        ctx.fillStyle = part.renderColor;
        ctx.fillRect(part.posX, part.posY, part.blockSize, part.blockSize);
        ctx.restore();
    });
    visualEffectsContainer = visualEffectsContainer.filter(part => part.remainingLife > 0);
}

// ─────────────────────────────────────────────────────────────
//  繪圖與視覺增強工具組 (UI RENDERING)
// ─────────────────────────────────────────────────────────────
function drawHandJoints() {
    if (!detectedPoints) return;
    ctx.save();
    detectedPoints.forEach((pt, idx) => {
        const cx = (1 - pt.x) * CANVAS_WIDTH;
        const cy = pt.y * CANVAS_HEIGHT;
        ctx.fillStyle = idx === 0 ? RETRO_PALETTE.red : RETRO_PALETTE.blue;
        ctx.fillRect(cx - 3, cy - 3, 6, 6);
    });
    ctx.restore();
}

function renderCustomText(stringText, posX, posY, fontSize, primaryColor, outlineColor) {
    ctx.save();
    ctx.font = `bold ${fontSize}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (outlineColor) { ctx.strokeStyle = outlineColor; ctx.lineWidth = 4; ctx.strokeText(stringText, posX, posY); }
    ctx.fillStyle = primaryColor || '#FFFFFF'; ctx.fillText(stringText, posX, posY);
    ctx.restore();
}

function renderPixelButton(textLabel, startX, startY, blockW, blockH, activeColor) {
    const isHovered = cursorX >= startX && cursorX <= startX + blockW && cursorY >= startY && cursorY <= startY + blockH;
    ctx.save();
    ctx.fillStyle = isHovered ? RETRO_PALETTE.white : activeColor;
    ctx.fillRect(startX, startY, blockW, blockH);
    ctx.strokeStyle = RETRO_PALETTE.black;
    ctx.lineWidth = 3;
    ctx.strokeRect(startX, startY, blockW, blockH);

    ctx.font = `bold ${Math.floor(blockH * 0.4)}px monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = isHovered ? RETRO_PALETTE.black : RETRO_PALETTE.white;
    ctx.fillText(textLabel, startX + blockW / 2, startY + blockH / 2);
    ctx.restore();
}

function displayStatsPanel() {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(10, 10, 235, 30);
    ctx.strokeStyle = RETRO_PALETTE.white; ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, 235, 30);

    ctx.font = 'bold 14px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = RETRO_PALETTE.green; ctx.fillText(`勝: ${recordTracker.playerWins}`, 20, 25);
    ctx.fillStyle = RETRO_PALETTE.red; ctx.fillText(`敗: ${recordTracker.cpuWins}`, 90, 25);
    ctx.fillStyle = RETRO_PALETTE.yellow; ctx.fillText(`平: ${recordTracker.stalemates}`, 160, 25);
    ctx.restore();
}

function renderPixelCard(gestureKey, coordX, coordY, cardW, cardH, themeColor, currentAlpha = 1) {
    ctx.save(); ctx.globalAlpha = currentAlpha;
    ctx.fillStyle = RETRO_PALETTE.black;
    ctx.strokeStyle = themeColor; ctx.lineWidth = 2.5;

    ctx.fillRect(coordX, coordY, cardW, cardH);
    ctx.strokeRect(coordX, coordY, cardW, cardH);

    ctx.font = `${Math.floor(cardH * 0.5)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ICON_MAP[gestureKey] || '❔', coordX + cardW / 2, coordY + cardH * 0.46);

    ctx.font = `bold ${Math.floor(cardH * 0.18)}px monospace`; ctx.fillStyle = themeColor;
    ctx.fillText(LABEL_MAP[gestureKey] || '未知', coordX + cardW / 2, coordY + cardH * 0.8);
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────
//  各狀態渲染子模組 (STATE RENDERERS)
// ─────────────────────────────────────────────────────────────
function renderLoadingScreen() {
    ctx.fillStyle = RETRO_PALETTE.black; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const cycle = Date.now() / 1000;
    renderCustomText('... LOADING ...', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 10, 28, RETRO_PALETTE.white);
    ctx.fillStyle = RETRO_PALETTE.gray;
    for (let i = 0; i < 8; i++) {
        if (Math.sin(cycle * 4 + i * 0.8) > 0) {
            ctx.fillRect(CANVAS_WIDTH / 2 - 44 + i * 12, CANVAS_HEIGHT / 2 + 20, 8, 8);
        }
    }
}

function renderLobbyScreen() {
    drawHandJoints(); displayStatsPanel();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillRect(0, CANVAS_HEIGHT - 90, CANVAS_WIDTH, 90);

    if (!detectedPoints) {
        renderCustomText('AWAITING PLAYER INPUT', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 55, 20, RETRO_PALETTE.white);
    } else if (verifiedGesture) {
        const isValidWeapon = GAME_WEAPONS.includes(verifiedGesture);
        renderCustomText(isValidWeapon ? `LOCKED: ${ICON_MAP[verifiedGesture]} ${LABEL_MAP[verifiedGesture]}` : 'INVALID GESTURE', CANVAS_WIDTH / 2, CANVAS_HEIGHT - 60, 18, isValidWeapon ? RETRO_PALETTE.green : RETRO_PALETTE.yellow);

        const ratio = executionLockTimer ? Math.min(1, (Date.now() - executionLockTimer) / LOCK_TRIGGER_MS) : 0;
        ctx.fillStyle = '#444'; ctx.fillRect(CANVAS_WIDTH / 2 - 100, CANVAS_HEIGHT - 35, 200, 10);
        ctx.fillStyle = RETRO_PALETTE.yellow; ctx.fillRect(CANVAS_WIDTH / 2 - 100, CANVAS_HEIGHT - 35, 200 * ratio, 10);
    }
}

function renderCountdownScreen() {
    const elapsed = Date.now() - phaseTimestamp;
    drawHandJoints(); displayStatsPanel();

    const secondsLeft = Math.ceil((COUNTDOWN_SECONDS * 1000 - elapsed) / 1000);
    const pulse = 1 + 0.15 * Math.abs(Math.sin(elapsed / 250));

    ctx.save(); ctx.translate(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2); ctx.scale(pulse, pulse);
    ctx.font = 'bold 96px monospace'; ctx.fillStyle = secondsLeft === 1 ? RETRO_PALETTE.red : secondsLeft === 2 ? RETRO_PALETTE.yellow : RETRO_PALETTE.green;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(secondsLeft > 0 ? secondsLeft : '出拳！', 0, 0); ctx.restore();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillRect(0, 0, CANVAS_WIDTH, 40);
    renderCustomText(`LOCKED: ${ICON_MAP[playerMove] || '❓'} ${LABEL_MAP[playerMove]}`, CANVAS_WIDTH / 2, 20, 16, RETRO_PALETTE.white);
}

function renderRevealScreen() {
    const delta = Date.now() - phaseTimestamp;
    const alphaRatio = Math.min(1, Math.max(0, (delta - 300) / 400));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    renderCustomText('PLAYER', CANVAS_WIDTH / 4, 60, 18, RETRO_PALETTE.blue);
    renderCustomText('CPU', CANVAS_WIDTH * 3 / 4, 60, 18, RETRO_PALETTE.red);
    renderCustomText('VS', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 34, RETRO_PALETTE.white, RETRO_PALETTE.black);

    renderPixelCard(playerMove, 60, CANVAS_HEIGHT / 2 - 60, 180, 120, RETRO_PALETTE.blue);
    renderPixelCard(cpuMove, CANVAS_WIDTH - 240, CANVAS_HEIGHT / 2 - 60, 180, 120, RETRO_PALETTE.red, alphaRatio);
    displayStatsPanel();
}

function renderVictoryScreen() { updateAndRenderEffects(); displayStatsPanel(); renderCustomText('YOU WIN!', CANVAS_WIDTH / 2, 60, 34, RETRO_PALETTE.green, RETRO_PALETTE.black); }
function renderDefeatScreen() { displayStatsPanel(); renderCustomText('YOU LOSE', CANVAS_WIDTH / 2, 60, 34, RETRO_PALETTE.red, RETRO_PALETTE.black); }
function renderStalemateScreen() { displayStatsPanel(); renderCustomText('DRAW', CANVAS_WIDTH / 2, 60, 34, RETRO_PALETTE.yellow, RETRO_PALETTE.black); }

function renderSelectionMenu() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.88)'; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    displayStatsPanel();
    renderCustomText('PLAY AGAIN?', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 85, 32, RETRO_PALETTE.white);

    renderCustomText('GESTURE: 👍 (Thumbs Up) to Continue / 👎 (Thumbs Down) to Quit', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 30, 14, RETRO_PALETTE.lightGray);

    const btnW = 140, btnH = 50, btnY = CANVAS_HEIGHT / 2 + 20;
    renderPixelButton('QUIT', CANVAS_WIDTH / 2 - btnW - 15, btnY, btnW, btnH, RETRO_PALETTE.red);
    renderPixelButton('AGAIN', CANVAS_WIDTH / 2 + 15, btnY, btnW, btnH, RETRO_PALETTE.green);

    if (currentPhase === 'menu_selection' && (verifiedGesture === 'signal_thumbs_up' || verifiedGesture === 'signal_thumbs_down')) {
        const ratio = executionLockTimer ? Math.min(1, (Date.now() - executionLockTimer) / LOCK_TRIGGER_MS) : 0;
        const isContinue = verifiedGesture === 'signal_thumbs_up';
        const colorBar = isContinue ? RETRO_PALETTE.green : RETRO_PALETTE.red;

        ctx.fillStyle = '#444'; ctx.fillRect(CANVAS_WIDTH / 2 - 90, CANVAS_HEIGHT / 2 + 95, 180, 8);
        ctx.fillStyle = colorBar; ctx.fillRect(CANVAS_WIDTH / 2 - 90, CANVAS_HEIGHT / 2 + 115, 180 * ratio, 6);
        renderCustomText(isContinue ? 'LOADING...' : 'QUITTING...', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 115, 15, colorBar);
    }
}

function renderTerminationScreen() {
    ctx.fillStyle = RETRO_PALETTE.black; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    renderCustomText('GAME OVER', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 - 25, 30, RETRO_PALETTE.white, RETRO_PALETTE.red);
    renderCustomText(`FINAL SCORE: ${recordTracker.playerWins} WINS`, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + 25, 15, RETRO_PALETTE.yellow);
}

// ─────────────────────────────────────────────────────────────
//  主控制引擎更新邏輯 (UPDATE & LOOP)
// ─────────────────────────────────────────────────────────────
function updateCoreEngine() {
    const currentTimestamp = Date.now();
    const elapsedInPhase = currentTimestamp - phaseTimestamp;

    if (currentPhase === 'menu_selection') {
        if (verifiedGesture === 'signal_thumbs_up' || verifiedGesture === 'signal_thumbs_down') {
            if (!executionLockTimer) executionLockTimer = currentTimestamp;
            if (currentTimestamp - executionLockTimer >= LOCK_TRIGGER_MS) {
                if (verifiedGesture === 'signal_thumbs_up') resetGameToLobby();
                else if (verifiedGesture === 'signal_thumbs_down') switchPhase('game_terminated');
                executionLockTimer = null;
            }
        } else { executionLockTimer = null; }
    }

    if (currentPhase === 'lobby_waiting') {
        if (verifiedGesture && GAME_WEAPONS.includes(verifiedGesture)) {
            if (playerMove !== verifiedGesture) { executionLockTimer = currentTimestamp; playerMove = verifiedGesture; }
            if (currentTimestamp - executionLockTimer >= LOCK_TRIGGER_MS) switchPhase('match_countdown');
        } else if (verifiedGesture === 'signal_thumbs_up' || !detectedPoints) {
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
            recordTracker.playerWins++; createRetroExplosion(CANVAS_WIDTH / 3, CANVAS_HEIGHT / 2);
            createRetroExplosion(CANVAS_WIDTH * 2 / 3, CANVAS_HEIGHT / 2);
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
    const btnW = 140, btnH = 50, btnY = CANVAS_HEIGHT / 2 + 20;

    if (clkX >= CANVAS_WIDTH / 2 + 15 && clkX <= CANVAS_WIDTH / 2 + 15 + btnW && clkY >= btnY && clkY <= btnY + btnH) resetGameToLobby();
    if (clkX >= CANVAS_WIDTH / 2 - btnW - 15 && clkX <= CANVAS_WIDTH / 2 - 15 + btnW && clkY >= btnY && clkY <= btnY + btnH) switchPhase('game_terminated');
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
    ctx.fillStyle = RETRO_PALETTE.black; ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
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
