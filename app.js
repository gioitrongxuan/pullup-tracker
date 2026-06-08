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
let pullPhase     = null;     // null | 'DOWN' | 'UP'
let posBuffer     = [];       // smoothing ring buffer

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

        if (isRunning && prev === 'UP' && detectedPhase === 'DOWN') {
            countRep();
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
    const video  = document.getElementById('inputVideo');
    const canvas = document.getElementById('outputCanvas');

    video.addEventListener('loadeddata', () => {
        canvas.width  = video.videoWidth  || 1280;
        canvas.height = video.videoHeight || 720;
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

    mpCam = new Camera(video, {
        onFrame: async () => {
            if (poseInst) await poseInst.send({ image: video });
        },
        width:  1280,
        height: 720,
    });

    return true;
}

async function startCamera() {
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
        showToast(`⚠️ Không mở được camera: ${err.message}`);
        document.getElementById('cameraPlaceholder').style.display = '';
        document.getElementById('poseStatus').style.display        = 'none';
        document.getElementById('cameraTipBar').style.display      = 'none';
    }
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
    repCount     = 0;
    pullPhase    = null;
    posBuffer    = [];
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
    renderHistory();
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

    empty.style.display = 'none';
    countEl.textContent = `${sessions.length} buổi`;

    const grid = document.createElement('div');
    grid.className = 'history-grid';

    sessions.forEach(s => {
        const rateStr = s.duration_sec > 0
            ? `${(s.reps / (s.duration_sec / 60)).toFixed(1)}/phút`
            : '';

        const card = document.createElement('div');
        card.className = 'session-card';
        card.innerHTML = `
            <div class="session-reps-box">
                <span class="session-reps-num">${esc(String(s.reps))}</span>
                <span class="session-reps-label">LẦN</span>
            </div>
            <div class="session-meta">
                <div class="session-date">${esc(formatDate(s.created_at))}</div>
                <div class="session-dur">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${esc(formatDuration(s.duration_sec))}
                </div>
            </div>
            <div class="session-rate">${esc(rateStr)}</div>`;
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
