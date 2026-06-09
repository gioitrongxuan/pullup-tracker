'use strict';

// ===== CONFIG =====
// Reuses chrongo's Supabase project + Google OAuth client
const GOOGLE_CLIENT_ID  = '467685882670-6rr0fnqdpch5gk78b188fqa8j6m0j47d.apps.googleusercontent.com';
const SUPABASE_URL      = 'https://epqohkagzvboncaciynl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwcW9oa2FnenZib25jYWNpeW5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NzEzNTksImV4cCI6MjA5NjI0NzM1OX0.KlFNBV0O1xJcFMbCbDtCJe0fDNqMY8i3Q9y63oKW3k8';

// ===== PULL-UP DETECTION PARAMS =====
// MediaPipe normalized coords: y=0 = top of frame, y=1 = bottom.
// When hanging DOWN: nose.y >> wrist.y  → diff = nose.y - wrist.y > DOWN_THRESH
// When pulled UP:    nose.y ≈ wrist.y   → diff < UP_THRESH
const DOWN_THRESH  = 0.15;   // nose at least 15% of frame height below wrists
const UP_THRESH    = 0.07;   // nose within 7% of wrist height = chin over bar
const MIN_VIS      = 0.5;    // landmark visibility threshold
const SMOOTH_LEN   = 7;      // frames to average for noise reduction
const BAR_Y_LIMIT  = 0.5;    // wrists must be in top 50% of frame (holding bar)

// ===== STATE =====
let supabaseClient = null;
let currentUser    = null;

let isRunning     = false;
let repCount      = 0;
let sessionStart  = 0;
let timerInterval = null;
let pullPhase        = null;  // null | 'DOWN' | 'UP'
let seenDownBeforeUp = false; // must hang DOWN before UP counts
let posBuffer        = [];    // smoothing ring buffer

let poseInst   = null;        // MediaPipe Pose instance
let mpCam      = null;        // MediaPipe Camera instance
let poseActive = false;

let sessions    = [];         // loaded from Supabase
let pendingSave = null;       // { reps, duration_sec } waiting for auth/confirm

// ===== UTILS =====
const pad = n => String(n).padStart(2, '0');

function formatDuration(sec) {
    return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
}

function formatDate(iso) {
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function esc(s) {
    return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let _toastTimer = null;
function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ===== PULL-UP ALGORITHM =====

function smoothPush(val) {
    posBuffer.push(val);
    if (posBuffer.length > SMOOTH_LEN) posBuffer.shift();
    return posBuffer.reduce((a, b) => a + b, 0) / posBuffer.length;
}

function lm(landmarks, idx) {
    return landmarks?.[idx] ?? null;
}

function visible(point) {
    return point && (point.visibility ?? 1) >= MIN_VIS;
}

// Returns true if hands are gripping bar (wrists above shoulders, near top of frame)
function isGrippingBar(lms) {
    const lw = lm(lms, 15), rw = lm(lms, 16);  // wrists
    const ls = lm(lms, 11), rs = lm(lms, 12);  // shoulders

    const wristOk = (visible(lw) || visible(rw));
    if (!wristOk) return false;

    const wristY = visible(lw) && visible(rw) ? (lw.y + rw.y) / 2
                 : visible(lw) ? lw.y
                 : rw.y;

    // Wrists must be in upper half of frame
    if (wristY > BAR_Y_LIMIT) return false;

    // Wrists must be above shoulders
    if (visible(ls) || visible(rs)) {
        const shoulderY = (visible(ls) && visible(rs)) ? (ls.y + rs.y) / 2
                        : visible(ls) ? ls.y : rs.y;
        if (wristY > shoulderY - 0.05) return false;
    }

    return true;
}

function onPoseResults(lms) {
    const nose = lm(lms, 0);
    const lw   = lm(lms, 15);
    const rw   = lm(lms, 16);

    if (!visible(nose)) {
        updatePoseDot(false, 'Không thấy người');
        return;
    }

    const gripping = isGrippingBar(lms);
    updatePoseDot(true, gripping ? '✓ Đang giữ xà' : 'Phát hiện người');
    updateTip(gripping ? 'Tốt! Bắt đầu kéo lên...' : 'Leo lên xà và nắm thanh');

    if (!gripping) {
        posBuffer = [];
        if (pullPhase !== null) {
            pullPhase = null;
            if (isRunning) setCounterPhase(null);
        }
        return;
    }

    // Average wrist y
    const wristY = (visible(lw) && visible(rw)) ? (lw.y + rw.y) / 2
                 : visible(lw) ? lw.y : rw.y;

    const smoothDiff = smoothPush(nose.y - wristY);

    let detectedPhase = null;
    if (smoothDiff > DOWN_THRESH) detectedPhase = 'DOWN';
    else if (smoothDiff < UP_THRESH) detectedPhase = 'UP';
    // else: transition zone, don't change phase

    if (detectedPhase && detectedPhase !== pullPhase) {
        const prev = pullPhase;
        pullPhase = detectedPhase;

        if (prev === 'DOWN' && detectedPhase === 'UP') {
            seenDownBeforeUp = true;
        }

        if (isRunning && prev === 'UP' && detectedPhase === 'DOWN' && seenDownBeforeUp) {
            countRep();
            seenDownBeforeUp = false;
        }

        if (isRunning) setCounterPhase(pullPhase);
    }
}

function countRep() {
    repCount++;
    const el = document.getElementById('repCount');
    el.textContent = repCount;
    el.classList.remove('bump');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('bump');
    triggerRepFlash();
    updateTip(`🔥 Tốt lắm! ${repCount} lần rồi!`);
}

function setCounterPhase(phase) {
    const el = document.getElementById('counterPhase');
    const overlay = document.getElementById('phaseOverlay');
    const oText   = document.getElementById('phaseOverlayText');

    if (phase === 'DOWN') {
        el.textContent = '⬇ Đang xuống';
        el.className   = 'counter-phase phase-down';
        overlay.className = 'phase-overlay phase-down';
        oText.textContent = '↓';
        overlay.style.display = '';
    } else if (phase === 'UP') {
        el.textContent = '⬆ Đã lên – thả xuống';
        el.className   = 'counter-phase phase-up';
        overlay.className = 'phase-overlay phase-up';
        oText.textContent = '↑';
        overlay.style.display = '';
    } else {
        el.textContent = '⏳ Đang theo dõi...';
        el.className   = 'counter-phase';
        overlay.style.display = 'none';
    }
}

function updatePoseDot(detected, text) {
    poseActive = detected;
    const dot  = document.getElementById('poseDot');
    const span = document.getElementById('poseStatusText');
    dot.className  = detected ? 'pose-dot active' : 'pose-dot';
    span.textContent = text || (detected ? 'Đã phát hiện' : 'Đang tìm kiếm...');
}

function updateTip(text) {
    document.getElementById('tipText').textContent = text;
}

function triggerRepFlash() {
    const el = document.getElementById('repFlash');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
}

// ===== MEDIAPIPE INIT =====

function setupCanvas() {
    const video    = document.getElementById('inputVideo');
    const canvas   = document.getElementById('outputCanvas');
    const isMobile = window.innerWidth <= 780;

    video.addEventListener('loadeddata', () => {
        canvas.width  = video.videoWidth  || (isMobile ? 480 : 1280);
        canvas.height = video.videoHeight || (isMobile ? 640 : 720);
    }, { once: false });
}

function initPose() {
    if (typeof Pose === 'undefined') {
        showToast('⚠️ MediaPipe chưa tải, vui lòng tải lại trang');
        return false;
    }

    const video  = document.getElementById('inputVideo');
    const canvas = document.getElementById('outputCanvas');
    const ctx    = canvas.getContext('2d');

    poseInst = new Pose({
        locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    poseInst.setOptions({
        modelComplexity:       1,
        smoothLandmarks:       true,
        enableSegmentation:    false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence:  0.5,
    });

    poseInst.onResults(results => {
        // Sync canvas size to video
        if (video.videoWidth && canvas.width !== video.videoWidth) {
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
        }

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Mirror horizontally for natural selfie view
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);

        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        if (results.poseLandmarks) {
            if (typeof drawConnectors === 'function' && typeof POSE_CONNECTIONS !== 'undefined') {
                drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, {
                    color: 'rgba(0,229,212,0.65)',
                    lineWidth: 3,
                });
            }
            if (typeof drawLandmarks === 'function') {
                drawLandmarks(ctx, results.poseLandmarks, {
                    color: 'rgba(255,255,255,0.85)',
                    fillColor: 'rgba(0,200,190,0.75)',
                    lineWidth: 1,
                    radius: 4,
                });
            }
            onPoseResults(results.poseLandmarks);
        } else {
            updatePoseDot(false, 'Không thấy người');
        }

        ctx.restore();
    });

    const isMobile = window.innerWidth <= 780;
    mpCam = new Camera(video, {
        onFrame: async () => {
            if (poseInst) await poseInst.send({ image: video });
        },
        width:  isMobile ? 480 : 1280,
        height: isMobile ? 640 : 720,
    });

    return true;
}

async function startCamera() {
    // Camera API requires HTTPS (or localhost)
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        showCameraError(
            '🔒 Cần HTTPS',
            'Camera chỉ hoạt động trên HTTPS. Vui lòng truy cập qua https://'
        );
        return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        showCameraError(
            '📷 Trình duyệt không hỗ trợ',
            'Trình duyệt này không hỗ trợ camera. Hãy dùng Chrome hoặc Safari mới nhất.'
        );
        return;
    }

    document.getElementById('cameraPlaceholder').style.display = 'none';
    document.getElementById('poseStatus').style.display        = '';
    document.getElementById('cameraTipBar').style.display      = '';

    if (!poseInst && !initPose()) {
        document.getElementById('cameraPlaceholder').style.display = '';
        return;
    }

    try {
        await mpCam.start();
    } catch (err) {
        showCameraError('⚠️ Lỗi camera', err.message);
    }
}

function showCameraError(title, message) {
    const ph = document.getElementById('cameraPlaceholder');
    ph.style.display = '';
    ph.innerHTML = `
        <div class="cam-icon">🔒</div>
        <p class="cam-title">${esc(title)}</p>
        <p class="cam-sub">${esc(message)}</p>`;
    document.getElementById('poseStatus').style.display   = 'none';
    document.getElementById('cameraTipBar').style.display = 'none';
    // Reset workout state
    isRunning = false;
    clearInterval(timerInterval);
    document.getElementById('btnStop').style.display  = 'none';
    document.getElementById('btnStart').style.display = '';
}

function stopCamera() {
    if (mpCam) mpCam.stop();
    document.getElementById('cameraPlaceholder').style.display = '';
    document.getElementById('poseStatus').style.display        = 'none';
    document.getElementById('phaseOverlay').style.display      = 'none';
    document.getElementById('cameraTipBar').style.display      = 'none';
}

// ===== WORKOUT SESSION =====

function startWorkout() {
    repCount        = 0;
    pullPhase       = null;
    seenDownBeforeUp = false;
    posBuffer       = [];
    isRunning    = true;
    sessionStart = Date.now();

    document.getElementById('repCount').textContent = '0';
    document.getElementById('counterPhase').textContent = 'Đang theo dõi...';
    document.getElementById('counterPhase').className  = 'counter-phase';
    document.getElementById('timerCard').style.visibility = 'visible';
    document.getElementById('btnStart').style.display    = 'none';
    document.getElementById('btnStop').style.display     = '';
    document.getElementById('instructionsCard').style.display = 'none';

    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();

    startCamera();
    showToast('▶ Bắt đầu! Leo lên xà và bắt đầu kéo...');
}

function tickTimer() {
    const sec = Math.floor((Date.now() - sessionStart) / 1000);
    document.getElementById('timerDisplay').textContent = formatDuration(sec);
}

function endWorkout() {
    if (!isRunning) return;
    isRunning = false;
    clearInterval(timerInterval);

    const duration = Math.floor((Date.now() - sessionStart) / 1000);

    document.getElementById('btnStop').style.display     = 'none';
    document.getElementById('btnStart').style.display    = '';
    document.getElementById('counterPhase').textContent  = 'Kết thúc';
    document.getElementById('counterPhase').className    = 'counter-phase';
    document.getElementById('phaseOverlay').style.display = 'none';
    document.getElementById('instructionsCard').style.display = '';

    stopCamera();

    if (repCount > 0) {
        pendingSave = { reps: repCount, duration_sec: duration };
        openSaveModal(repCount, duration);
    } else {
        showToast('Không có lần kéo nào được ghi nhận.');
    }
}

// ===== SAVE MODAL =====

function openSaveModal(reps, duration) {
    document.getElementById('saveReps').textContent     = reps;
    document.getElementById('saveDuration').textContent = formatDuration(duration);
    document.getElementById('saveOverlay').classList.add('open');
}

function closeSaveModal() {
    document.getElementById('saveOverlay').classList.remove('open');
}

async function confirmSave() {
    closeSaveModal();
    if (!currentUser) {
        openLoginModal();   // will retry after login via handleCredentialResponse
        return;
    }
    if (pendingSave) await writeSession(pendingSave.reps, pendingSave.duration_sec);
}

async function writeSession(reps, duration_sec) {
    if (!supabaseClient || !currentUser) return;

    const { data, error } = await supabaseClient
        .from('pullup_sessions')
        .insert({ user_id: currentUser.id, reps, duration_sec })
        .select()
        .single();

    if (error) {
        showToast(`⚠️ Lỗi khi lưu: ${error.message}`);
        return;
    }

    pendingSave = null;
    sessions.unshift(data);
    renderDashStats();
    renderHistory();
    updateAISection();
    showToast(`✅ Đã lưu ${reps} lần kéo xà!`);
}

// ===== HISTORY =====

async function loadHistory() {
    if (!supabaseClient || !currentUser) return;

    const { data, error } = await supabaseClient
        .from('pullup_sessions')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(100);

    if (error) { console.warn('history:', error.message); return; }
    sessions = data || [];
    renderHistory();
    updateAISection();
}

// Group sessions by calendar day, return array sorted newest-first
function groupByDay(list) {
    const map = {};
    list.forEach(s => {
        const key = localDateKey(new Date(s.created_at));
        if (!map[key]) map[key] = { reps: 0, duration: 0, sets: 0 };
        map[key].reps     += s.reps;
        map[key].duration += s.duration_sec;
        map[key].sets++;
    });
    return Object.keys(map).sort().reverse().map(key => ({ key, ...map[key] }));
}

function renderHistory() {
    const container = document.getElementById('historyList');
    const empty     = document.getElementById('historyEmpty');
    const countEl   = document.getElementById('historyCount');

    if (!sessions.length) {
        container.innerHTML = '';
        container.appendChild(empty);
        empty.style.display = '';
        countEl.textContent = '';
        return;
    }

    const days = groupByDay(sessions);
    empty.style.display = 'none';
    countEl.textContent = `${days.length} ngày`;

    const grid = document.createElement('div');
    grid.className = 'history-grid';

    days.forEach(d => {
        const [y, m, day] = d.key.split('-');
        const dateStr  = `${parseInt(day)}/${parseInt(m)}/${y}`;
        const rateStr  = d.duration > 0
            ? `${(d.reps / (d.duration / 60)).toFixed(1)}/phút`
            : '';
        const setsStr  = d.sets > 1 ? `${d.sets} lần` : '';

        const card = document.createElement('div');
        card.className = 'session-card';
        card.innerHTML = `
            <div class="session-reps-box">
                <span class="session-reps-num">${esc(String(d.reps))}</span>
                <span class="session-reps-label">LẦN</span>
            </div>
            <div class="session-meta">
                <div class="session-date">${esc(dateStr)}</div>
                <div class="session-dur">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${esc(formatDuration(d.duration))}
                </div>
            </div>
            <div class="session-rate">${setsStr ? esc(setsStr) + '<br>' : ''}${esc(rateStr)}</div>`;
        grid.appendChild(card);
    });

    container.innerHTML = '';
    container.appendChild(empty);
    container.appendChild(grid);
}

// ===== AUTH =====

function decodeJwt(token) {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
}

function initGoogleAuth() {
    if (!window.google?.accounts?.id) return;
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: false,
    });
}

async function handleCredentialResponse(response) {
    if (supabaseClient) {
        const { data, error } = await supabaseClient.auth.signInWithIdToken({
            provider: 'google',
            token: response.credential,
        });
        if (error || !data.user) { showToast('⚠️ Đăng nhập thất bại'); return; }
        const u = data.user;
        currentUser = {
            id:      u.id,
            name:    u.user_metadata.full_name || u.user_metadata.name || u.email,
            email:   u.email,
            picture: u.user_metadata.avatar_url || u.user_metadata.picture || '',
        };
    } else {
        const p = decodeJwt(response.credential);
        currentUser = { id: p.sub, name: p.name, email: p.email, picture: p.picture };
    }

    closeLoginModal();
    updateAuthUI();
    showToast(`👋 Xin chào, ${currentUser.name}!`);
    await loadHistory();

    // Save pending workout if any
    if (pendingSave) {
        await writeSession(pendingSave.reps, pendingSave.duration_sec);
    }
}

async function signOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
    currentUser = null;
    sessions    = [];
    pendingSave = null;
    closeProfileModal();
    updateAuthUI();
    renderHistory();
    updateAISection();
    showToast('👋 Đã đăng xuất');
}

function updateAuthUI() {
    const headerUser = document.getElementById('headerUser');
    const btnLogin   = document.getElementById('btnLoginHeader');
    if (currentUser) {
        document.getElementById('headerAvatar').src = currentUser.picture || '';
        document.getElementById('headerUsername').textContent =
            currentUser.name.split(' ').at(-1);
        headerUser.style.display = '';
        btnLogin.style.display   = 'none';
    } else {
        headerUser.style.display = 'none';
        btnLogin.style.display   = '';
    }
    updateAISection();
}

function openLoginModal() {
    document.getElementById('loginOverlay').classList.add('open');
    setTimeout(() => {
        const wrap = document.getElementById('googleSignInBtn');
        if (!wrap || !window.google?.accounts?.id) return;
        wrap.innerHTML = '';
        google.accounts.id.renderButton(wrap, {
            theme: 'filled_black',
            size: 'large',
            text: 'signin_with',
            width: 280,
            locale: 'vi',
        });
    }, 80);
}

function closeLoginModal()   { document.getElementById('loginOverlay').classList.remove('open'); }
function openProfileModal()  {
    if (!currentUser) return;
    document.getElementById('profileAvatar').src = currentUser.picture || '';
    document.getElementById('profileName').textContent  = currentUser.name;
    document.getElementById('profileEmail').textContent = currentUser.email;
    document.getElementById('profileOverlay').classList.add('open');
}
function closeProfileModal() { document.getElementById('profileOverlay').classList.remove('open'); }

// ===== EVENT WIRING =====
document.getElementById('btnStart').addEventListener('click', startWorkout);
document.getElementById('btnStop').addEventListener('click', endWorkout);

document.getElementById('btnSaveConfirm').addEventListener('click', confirmSave);
document.getElementById('btnSaveDiscard').addEventListener('click', () => {
    closeSaveModal();
    pendingSave = null;
    showToast('Kết quả không được lưu');
});
document.getElementById('saveOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSaveModal();
});

document.getElementById('btnLoginHeader').addEventListener('click', openLoginModal);
document.getElementById('btnLoginClose').addEventListener('click', closeLoginModal);
document.getElementById('btnLoginSkip').addEventListener('click', closeLoginModal);
document.getElementById('loginOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeLoginModal();
});

document.getElementById('headerUser').addEventListener('click', openProfileModal);
document.getElementById('btnProfileClose').addEventListener('click', closeProfileModal);
document.getElementById('btnProfileCancel').addEventListener('click', closeProfileModal);
document.getElementById('btnSignOut').addEventListener('click', signOut);
document.getElementById('profileOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeProfileModal();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeDashboard();
        closeLoginModal();
        closeProfileModal();
        closeSaveModal();
    }
});

// ===== BOOT =====
setupCanvas();

// Init Supabase & restore session
if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supabaseClient.auth.getSession().then(async ({ data: { session } }) => {
        if (!session) return;
        const u = session.user;
        currentUser = {
            id:      u.id,
            name:    u.user_metadata.full_name || u.user_metadata.name || u.email,
            email:   u.email,
            picture: u.user_metadata.avatar_url || u.user_metadata.picture || '',
        };
        updateAuthUI();
        await loadHistory();
    });
}

// Init Google auth (GIS loads async)
if (window.google?.accounts?.id) {
    initGoogleAuth();
} else {
    window.addEventListener('load', () => setTimeout(initGoogleAuth, 300));
}

updateAuthUI();
renderHistory();

// ===== AI ANALYSIS =====

const DOW_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function updateAISection() {
    const idle = document.getElementById('aiIdle');
    if (!idle) return;

    if (!currentUser) {
        idle.innerHTML = 'Đăng nhập để sử dụng tính năng phân tích AI';
    } else if (sessions.length < 1) {
        idle.innerHTML = 'Chưa có lần tập nào. Hãy hoàn thành lần đầu tiên!';
    } else {
        idle.innerHTML = 'Nhấn <strong>Phân tích</strong> để AI nhận xét lịch sử tập luyện của bạn';
    }

    document.getElementById('btnAnalyze').disabled = !currentUser;
}

async function analyzeWithAI() {
    console.log('analyzeWithAI called', { currentUser, sessions: sessions.length, supabaseClient: !!supabaseClient });
    if (!supabaseClient || !currentUser) { openLoginModal(); return; }
    if (sessions.length < 1) { showToast('Chưa có dữ liệu để phân tích'); return; }

    const btn      = document.getElementById('btnAnalyze');
    const idleEl   = document.getElementById('aiIdle');
    const loadEl   = document.getElementById('aiLoading');
    const resultEl = document.getElementById('aiResult');

    btn.disabled        = true;
    idleEl.style.display   = 'none';
    loadEl.style.display   = '';
    resultEl.style.display = 'none';

    try {
        const { data, error } = await supabaseClient.functions.invoke('analyze-pullup', {
            body: { sessions: sessions.slice(0, 30) },
        });
        if (error) throw new Error(error.message);
        if (!data)  throw new Error('Không nhận được dữ liệu từ server');

        renderAIResult(data);
        loadEl.style.display   = 'none';
        resultEl.style.display = '';
    } catch (err) {
        console.error('analyzeWithAI:', err);
        loadEl.style.display = 'none';
        idleEl.style.display = '';
        showToast(`⚠️ Phân tích thất bại: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
}

function renderAIResult(data) {
    // Trend badge
    const badge = document.getElementById('aiTrendBadge');
    const trendMap = {
        improving: { label: `↑ Tiến bộ ${data.trend_pct ? '+'+data.trend_pct+'%' : ''}`, cls: 'improving' },
        declining:  { label: `↓ Giảm ${data.trend_pct ? data.trend_pct+'%' : ''}`, cls: 'declining' },
        stable:     { label: '→ Ổn định', cls: 'stable' },
    };
    const t = trendMap[data.trend] || trendMap.stable;
    badge.textContent = t.label;
    badge.className   = `ai-trend-badge ${t.cls}`;

    // Summary
    document.getElementById('aiSummaryText').textContent = data.summary || '';

    // Weekly bar chart
    const barsEl = document.getElementById('aiBars');
    barsEl.innerHTML = '';
    const weekly = data.weekly_data || DOW_VI.map((_, i) => ({ dow: i, avg: 0 }));
    const maxAvg = Math.max(1, ...weekly.map((d) => Number(d.avg) || 0));

    weekly.forEach((d) => {
        const col  = document.createElement('div');
        col.className = 'ai-bar-col';
        const pct  = Math.max(4, ((Number(d.avg) || 0) / maxAvg) * 100);
        const best = d.dow === data.best_dow;
        col.innerHTML = `
            <div class="ai-bar-fill${best ? ' best' : ''}" style="height:${pct}%"></div>
            <div class="ai-bar-label${best ? ' best' : ''}">${DOW_VI[d.dow]}</div>`;
        barsEl.appendChild(col);
    });

    // Recommendations
    const recsEl = document.getElementById('aiRecs');
    recsEl.innerHTML = '';
    (data.recommendations || []).forEach((rec) => {
        const item = document.createElement('div');
        item.className = 'ai-rec-item';
        item.innerHTML = `<div class="ai-rec-dot"></div><span>${esc(rec)}</span>`;
        recsEl.appendChild(item);
    });

    // Next goal
    const goalEl = document.getElementById('aiGoal');
    if (data.next_goal) {
        goalEl.innerHTML = `
            <div class="ai-goal-num">${data.next_goal}</div>
            <div>Mục tiêu tiếp theo: <strong>${data.next_goal} lần</strong> trong một lần tập</div>`;
        goalEl.style.display = 'flex';
    } else {
        goalEl.style.display = 'none';
    }
}

document.getElementById('btnAnalyze').addEventListener('click', analyzeWithAI);

// ===== DASHBOARD =====

let dashPeriod = 'day';

function localDateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function localMonthKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
}

function localWeekKey(d) {
    // ISO week: move to Thursday to get correct year+week
    const dt = new Date(d);
    dt.setDate(dt.getDate() + 4 - (dt.getDay() || 7));
    const yearStart = new Date(dt.getFullYear(), 0, 1);
    const wn = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
    return `${dt.getFullYear()}-W${pad(wn)}`;
}

function buildBuckets(period) {
    const now    = new Date();
    const result = [];

    if (period === 'day') {
        for (let i = 13; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            result.push({ key: localDateKey(d), label: i === 0 ? 'Hôm\nnay' : `${d.getDate()}/${d.getMonth()+1}`, current: i === 0 });
        }
    } else if (period === 'week') {
        for (let i = 11; i >= 0; i--) {
            const d   = new Date(now);
            d.setDate(d.getDate() - i * 7);
            const dow = d.getDay() || 7;
            const mon = new Date(d);
            mon.setDate(d.getDate() - dow + 1);
            result.push({ key: localWeekKey(d), label: i === 0 ? 'Tuần\nnày' : `${mon.getDate()}/${mon.getMonth()+1}`, current: i === 0 });
        }
    } else if (period === 'month') {
        const M = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12'];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            result.push({ key: localMonthKey(d), label: M[d.getMonth()], current: i === 0 });
        }
    } else {
        const yearMap = {};
        sessions.forEach(s => { const y = new Date(s.created_at).getFullYear(); yearMap[y] = 1; });
        const curY  = now.getFullYear();
        yearMap[curY] = 1;
        Object.keys(yearMap).map(Number).sort().forEach(y => {
            result.push({ key: String(y), label: String(y), current: y === curY });
        });
    }
    return result;
}

function sessionPeriodKey(isoStr, period) {
    const d = new Date(isoStr);
    if (period === 'day')   return localDateKey(d);
    if (period === 'week')  return localWeekKey(d);
    if (period === 'month') return localMonthKey(d);
    return String(d.getFullYear());
}

function renderDashStats() {
    if (!sessions.length) {
        ['dashTotalReps','dashBestSession','dashAvgSession','dashTotalSessions'].forEach(id => {
            document.getElementById(id).textContent = '—';
        });
        return;
    }
    const days  = groupByDay(sessions);
    const total = days.reduce((s, d) => s + d.reps, 0);
    const best  = days.reduce((m, d) => Math.max(m, d.reps), 0);
    const avg   = days.length ? Math.round(total / days.length) : 0;
    document.getElementById('dashTotalReps').textContent     = total.toLocaleString('vi-VN');
    document.getElementById('dashBestSession').textContent   = best;
    document.getElementById('dashAvgSession').textContent    = avg;
    document.getElementById('dashTotalSessions').textContent = days.length;
}

function renderDashChart() {
    const barsEl   = document.getElementById('dashBars');
    const emptyEl  = document.getElementById('dashChartEmpty');
    const scrollEl = document.getElementById('dashChartScroll');

    if (!sessions.length) {
        emptyEl.style.display  = '';
        scrollEl.style.display = 'none';
        return;
    }

    const buckets = buildBuckets(dashPeriod);

    // Sum reps per bucket
    const totals = {};
    sessions.forEach(s => {
        const k = sessionPeriodKey(s.created_at, dashPeriod);
        totals[k] = (totals[k] || 0) + s.reps;
    });

    const values = buckets.map(b => totals[b.key] || 0);
    const maxVal = values.reduce((m, v) => Math.max(m, v), 0);

    if (maxVal === 0) {
        emptyEl.style.display  = '';
        scrollEl.style.display = 'none';
        emptyEl.querySelector('p').textContent = 'Chưa có dữ liệu trong khoảng thời gian này';
        return;
    }

    emptyEl.style.display  = 'none';
    scrollEl.style.display = '';
    barsEl.innerHTML = '';

    // Bar sizing: expand to fill if few bars, else fixed width + scroll
    const isSmall = buckets.length <= 8;
    const barW    = isSmall ? `${Math.floor((100 - (buckets.length - 1) * 2) / buckets.length)}%` : '36px';

    buckets.forEach((b, i) => {
        const pct  = values[i] > 0 ? Math.max(3, (values[i] / maxVal) * 100) : 0;
        const peak = values[i] === maxVal && values[i] > 0;
        const col  = document.createElement('div');
        col.className = 'dash-bar-col' + (b.current ? ' current' : '');
        col.style.width    = barW;
        col.style.minWidth = isSmall ? '24px' : '36px';
        col.innerHTML = `<div class="dash-bar-fill${peak ? ' peak' : ''}" style="height:${pct}%"></div>
<div class="dash-bar-label">${b.label}</div>`;
        barsEl.appendChild(col);
    });

    // Scroll to end then draw line overlay
    requestAnimationFrame(() => {
        scrollEl.scrollLeft = scrollEl.scrollWidth;
        requestAnimationFrame(() => drawLineOverlay(barsEl, values));
    });
}

function drawLineOverlay(barsEl, values) {
    const old = barsEl.querySelector('.dash-line-svg');
    if (old) old.remove();
    if (!values.some(v => v > 0)) return;

    const cols     = Array.from(barsEl.querySelectorAll('.dash-bar-col'));
    if (!cols.length) return;

    const barsRect = barsEl.getBoundingClientRect();
    const svgW     = barsEl.scrollWidth;
    const svgH     = barsEl.offsetHeight;

    const pts = cols.map((col, i) => {
        const fill = col.querySelector('.dash-bar-fill');
        const r    = fill.getBoundingClientRect();
        return { x: r.left - barsRect.left + r.width / 2, y: r.top - barsRect.top, val: values[i] };
    });

    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('dash-line-svg');
    svg.setAttribute('width', svgW);
    svg.setAttribute('height', svgH);
    svg.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:visible';

    // Polyline through all points
    const polyline = document.createElementNS(ns, 'polyline');
    polyline.setAttribute('points',         pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    polyline.setAttribute('fill',           'none');
    polyline.setAttribute('stroke',         'rgba(0,229,212,0.65)');
    polyline.setAttribute('stroke-width',   '1.5');
    polyline.setAttribute('stroke-linejoin','round');
    polyline.setAttribute('stroke-linecap', 'round');
    svg.appendChild(polyline);

    // Dot + value label for each non-zero bar
    pts.forEach(p => {
        if (p.val === 0) return;

        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', p.x.toFixed(1));
        c.setAttribute('cy', p.y.toFixed(1));
        c.setAttribute('r',  '3');
        c.setAttribute('fill',         'var(--accent)');
        c.setAttribute('stroke',       'var(--bg)');
        c.setAttribute('stroke-width', '1.5');
        svg.appendChild(c);

        const t = document.createElementNS(ns, 'text');
        t.setAttribute('x',           p.x.toFixed(1));
        t.setAttribute('y',           Math.max(9, p.y - 6).toFixed(1));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('font-size',   '9');
        t.setAttribute('font-weight', '600');
        t.setAttribute('fill',        'rgba(152,152,184,0.9)');
        t.setAttribute('font-family', '-apple-system,BlinkMacSystemFont,sans-serif');
        t.textContent = p.val;
        svg.appendChild(t);
    });

    barsEl.appendChild(svg);
}

function renderHeatmap() {
    const grid     = document.getElementById('dashHeatmap');
    const scrollEl = document.getElementById('dashHeatmapScroll');
    if (!grid) return;

    const dayMap = {};
    sessions.forEach(s => {
        const k = localDateKey(new Date(s.created_at));
        dayMap[k] = (dayMap[k] || 0) + s.reps;
    });
    const maxReps = Object.values(dayMap).reduce((m, v) => Math.max(m, v), 1);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow   = today.getDay() || 7;          // 1=Mon … 7=Sun
    const start = new Date(today);
    start.setDate(today.getDate() - (dow - 1) - 51 * 7); // Monday, 52 weeks ago

    grid.innerHTML = '';
    grid.style.gridTemplateRows = 'repeat(7, 12px)';
    grid.style.gridAutoFlow     = 'column';
    grid.style.gridAutoColumns  = '12px';
    grid.style.gap              = '2px';

    for (let i = 0; i < 364; i++) {
        const d      = new Date(start);
        d.setDate(start.getDate() + i);
        const future = d > today;
        const key    = localDateKey(d);
        const reps   = future ? 0 : (dayMap[key] || 0);

        const cell = document.createElement('div');
        cell.style.cssText = 'width:12px;height:12px;border-radius:2px';

        if (future) {
            cell.style.background = 'transparent';
        } else if (reps === 0) {
            cell.style.background = 'var(--surface2)';
        } else {
            const alpha = (0.25 + (reps / maxReps) * 0.70).toFixed(2);
            cell.style.background = `rgba(0,229,212,${alpha})`;
        }
        if (reps > 0) cell.title = `${key}: ${reps} lần`;
        grid.appendChild(cell);
    }

    requestAnimationFrame(() => { scrollEl.scrollLeft = scrollEl.scrollWidth; });
}

function openDashboard() {
    renderDashStats();
    renderDashChart();
    renderHeatmap();
    document.getElementById('dashboardScreen').classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeDashboard() {
    document.getElementById('dashboardScreen').classList.remove('open');
    document.body.style.overflow = '';
}

// Dashboard event wiring
document.getElementById('fabDashboard').addEventListener('click', openDashboard);
document.getElementById('dashboardBack').addEventListener('click', closeDashboard);

document.getElementById('dashboardLogo').addEventListener('click', () => {
    closeDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('headerLogo').addEventListener('click', () => {
    closeDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.querySelectorAll('.dash-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.dash-tab').forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        dashPeriod = btn.dataset.period;
        renderDashChart();
    });
});
