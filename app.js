'use strict';

// ===== CONFIG =====
// Reuses chrongo's Supabase project + Google OAuth client
const GOOGLE_CLIENT_ID  = '467685882670-6rr0fnqdpch5gk78b188fqa8j6m0j47d.apps.googleusercontent.com';
const SUPABASE_URL      = 'https://epqohkagzvboncaciynl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVwcW9oa2FnenZib25jYWNpeW5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NzEzNTksImV4cCI6MjA5NjI0NzM1OX0.KlFNBV0O1xJcFMbCbDtCJe0fDNqMY8i3Q9y63oKW3k8';

// ===== EXERCISE CONFIG =====
const EXERCISES = {
    pullup: {
        name: 'Kéo Xà',
        icon: '🏋️',
        usesCamera: true,
        label: 'LẦN KÉO XÀ',
        unit: 'lần kéo xà',
        startHint: '▶ Bắt đầu! Leo lên xà và bắt đầu kéo...',
        instructions: [
            'Đặt camera cách bạn 2–3 mét',
            'Điều chỉnh góc để thấy <strong>toàn thân</strong>',
            'Leo lên xà, tay nắm thanh',
            'Kéo lên cho đến khi <strong>cằm qua xà</strong>',
            'Thả xuống = 1 lần được đếm',
        ],
    },
    pushup: {
        name: 'Chống Đẩy',
        icon: '💪',
        usesCamera: true,
        label: 'LẦN CHỐNG ĐẨY',
        unit: 'lần chống đẩy',
        startHint: '▶ Bắt đầu! Về tư thế chống đẩy...',
        instructions: [
            'Đặt camera từ bên hoặc phía trước, cách 1–2m',
            'Điều chỉnh để camera thấy <strong>toàn thân</strong>',
            'Tay rộng hơn vai, thân người thẳng',
            'AI nhận diện qua <strong>góc khuỷu tay</strong>',
            'Xuống ngực gần sàn rồi đẩy lên = 1 lần',
        ],
    },
    situp: {
        name: 'Gập Bụng',
        icon: '🤸',
        usesCamera: true,
        label: 'LẦN GẬP BỤNG',
        unit: 'lần gập bụng',
        startHint: '▶ Bắt đầu! Nằm xuống để bắt đầu...',
        instructions: [
            'Đặt camera nhìn từ <strong>bên cạnh</strong>, cách 1–2m',
            'Nằm ngửa, gối gập, bàn chân đặt phẳng',
            'AI nhận diện qua <strong>góc gập hông</strong>',
            'Gập người lên rồi nằm xuống = 1 lần',
            'Camera nên thấy vai, hông và đầu gối',
        ],
    },
    squat: {
        name: 'Squat',
        icon: '🦵',
        usesCamera: true,
        label: 'LẦN SQUAT',
        unit: 'lần squat',
        startHint: '▶ Bắt đầu! Đứng vào vị trí để bắt đầu...',
        instructions: [
            'Đặt camera nhìn từ <strong>bên cạnh</strong>, cách 2–3m',
            'Điều chỉnh để camera thấy <strong>toàn bộ chân</strong>',
            'Chân rộng bằng vai, mũi chân hơi hướng ra ngoài',
            'AI nhận diện qua <strong>góc đầu gối</strong>',
            'Ngồi xuống đùi song song sàn rồi đứng lên = 1 lần',
        ],
    },
    dip: {
        name: 'Bar Dips',
        icon: '🦾',
        usesCamera: true,
        label: 'LẦN DIPS',
        unit: 'lần dips',
        startHint: '▶ Bắt đầu! Lên xà song song và bắt đầu...',
        instructions: [
            'Đặt camera nhìn từ <strong>bên cạnh</strong>, cách 1–2m',
            'Nắm hai thanh song song, duỗi thẳng tay',
            'AI nhận diện qua <strong>góc khuỷu tay</strong>',
            'Thả người xuống khuỷu tay ~90°, đẩy lên = 1 lần',
            'Camera nên thấy vai và khuỷu tay rõ ràng',
        ],
    },
    other: {
        name: 'Khác',
        icon: '🏃',
        usesCamera: false,
        label: 'LẦN',
        unit: 'lần',
        startHint: '▶ Bắt đầu! Nhấn màn hình sau mỗi lần tập...',
        instructions: [
            'Nhấn vào vùng trống sau mỗi lần tập',
            'Phù hợp cho mọi bài tập đếm số lượng',
            'Nhấn giữ để trừ 1 nếu đếm nhầm',
        ],
    },
};

// ===== PULL-UP DETECTION PARAMS =====
// MediaPipe normalized coords: y=0 = top of frame, y=1 = bottom.
// When hanging DOWN: nose.y >> wrist.y  → diff = nose.y - wrist.y > DOWN_THRESH
// When pulled UP:    nose.y ≈ wrist.y   → diff < UP_THRESH
const DOWN_THRESH  = 0.15;   // nose at least 15% of frame height below wrists
const UP_THRESH    = 0.07;   // nose within 7% of wrist height = chin over bar
const MIN_VIS      = 0.5;    // landmark visibility threshold
const SMOOTH_LEN   = 7;      // frames to average for noise reduction
const BAR_Y_LIMIT  = 0.5;    // wrists must be in top 50% of frame (holding bar)

// ===== OTHER EXERCISE DETECTION PARAMS =====
const PUSHUP_DOWN_THRESH = 85;   // elbow angle (deg) < = arms bent (down position)
const PUSHUP_UP_THRESH   = 150;  // elbow angle (deg) > = arms extended (up position)
const DIP_DOWN_THRESH    = 140;   // elbow angle (deg) < = lowered (down position)
const DIP_UP_THRESH      = 170;  // elbow angle (deg) > = arms locked out (up position)
const SQUAT_DOWN_THRESH  = 90;   // knee angle (deg)  < = squatting (down position)
const SQUAT_UP_THRESH    = 155;  // knee angle (deg)  > = standing (up position)
const SITUP_DOWN_THRESH  = 140;  // hip angle (deg)   > = lying flat (down position)
const SITUP_UP_THRESH    = 90;   // hip angle (deg)   < = sitting up (up position)

// ===== SUPER SAIYAN AURA PARAMS =====
// "Nộ khí" – a golden battle aura blazes around the athlete at the peak of each
// rep, then bursts into a shockwave when the rep is counted. Pure motivation.
const AURA_BODY_POINTS     = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
// Phase at which each exercise hits peak effort → the aura flares brightest.
const AURA_SURGE_PHASE     = { pullup: 'UP', dip: 'UP', situp: 'UP', pushup: 'DOWN', squat: 'DOWN' };
const AURA_IDLE_LEVEL      = 0.28;   // baseline glow while a tracked athlete rests
const AURA_LIGHTNING_LEVEL = 0.85;   // intensity above which SSj2 sparks crackle
const AURA_MIN_BODY_POINTS = 4;      // visible landmarks needed to place the aura
const AURA_MAX_PARTICLES   = 140;    // cap on rising energy sparks (performance)
const AURA_SHOCKWAVE_MS    = 650;    // lifetime of the per-rep shockwave ring

// ===== STATE =====
let supabaseClient = null;
let currentUser    = null;

let currentExercise = 'pullup';

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
let pendingSave = null;       // { reps, duration_sec, exercise_type } waiting for auth/confirm

let tapLongPressTimer = null;

// ===== AURA STATE =====
let auraLevel      = 0;     // eased intensity 0..1 driven by current phase
let auraBurst      = 0;     // transient spike added on each counted rep (decays)
let auraParticles  = [];    // rising energy sparks
let auraShockwaves = [];    // expanding rings, one born per rep
let auraLastT      = 0;     // perf timestamp of previous frame (for dt)
let auraSprite     = null;  // cached radial-glow sprite, reused for every glow
let lastAuraBody   = null;  // last measured body box (for shockwaves after fade)

// ===== UTILS =====
const pad = n => String(n).padStart(2, '0');

// Angle in degrees at vertex b, formed by points a–b–c
function calcAngle(a, b, c) {
    const abx = a.x - b.x, aby = a.y - b.y;
    const cbx = c.x - b.x, cby = c.y - b.y;
    const dot = abx * cbx + aby * cby;
    const mag = Math.sqrt(abx*abx + aby*aby) * Math.sqrt(cbx*cbx + cby*cby);
    if (mag === 0) return 180;
    return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}

// Generic phase-transition handler shared by all non-pull-up exercises.
// For push/squat/sit-up: effort = DOWN, rest = UP → count fires on DOWN→UP return.
// (Pull-ups use their own inline logic for backward compatibility.)
function processPhaseTransition(detected) {
    if (!detected || detected === pullPhase) return;

    const prev = pullPhase;
    pullPhase  = detected;

    // For all non-pull-up exercises: effort = 'DOWN', rest = 'UP'
    if (prev === 'UP' && detected === 'DOWN') seenDownBeforeUp = true;

    if (isRunning && prev === 'DOWN' && detected === 'UP' && seenDownBeforeUp) {
        countRep();
        seenDownBeforeUp = false;
    }

    if (isRunning) setCounterPhase(pullPhase);
}

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

// ===== EXERCISE SELECTION =====

function selectExercise(type) {
    if (isRunning) return;
    if (!EXERCISES[type]) return;

    currentExercise  = type;
    posBuffer        = [];
    pullPhase        = null;
    seenDownBeforeUp = false;

    const ex = EXERCISES[type];

    document.querySelectorAll('.ex-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
    });

    document.getElementById('counterLabel').textContent = ex.label;
    document.getElementById('counterPhase').textContent = 'Chưa bắt đầu';
    document.getElementById('counterPhase').className   = 'counter-phase';

    const instList = document.getElementById('instList');
    instList.innerHTML = ex.instructions.map(i => `<li>${i}</li>`).join('');

    const placeholder = document.getElementById('cameraPlaceholder');
    const tapArea     = document.getElementById('tapArea');

    if (ex.usesCamera) {
        placeholder.style.display = '';
        tapArea.style.display = 'none';
    } else {
        placeholder.style.display = 'none';
        tapArea.style.display = '';
    }

    // Reset AI panel then load cached analysis for this exercise (if any)
    const aiResultEl = document.getElementById('aiResult');
    const aiIdleEl   = document.getElementById('aiIdle');
    if (aiResultEl) aiResultEl.style.display = 'none';
    if (aiIdleEl)   aiIdleEl.style.display   = '';

    updateAISection();
    loadAICache();
}

// ===== MANUAL TAP COUNT =====

function manualCountRep() {
    if (!isRunning) return;
    repCount++;
    const el = document.getElementById('repCount');
    el.textContent = repCount;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
    triggerRepFlash();
    updateTip(`🔥 Tốt lắm! ${repCount} lần rồi!`);
}

function setupTapArea() {
    const tapArea = document.getElementById('tapArea');

    tapArea.addEventListener('pointerdown', () => {
        if (!isRunning) return;
        tapLongPressTimer = setTimeout(() => {
            tapLongPressTimer = null;
            if (repCount > 0) {
                repCount--;
                document.getElementById('repCount').textContent = repCount;
                showToast('↩ Đã trừ 1');
            }
        }, 600);
    });

    tapArea.addEventListener('pointerup', () => {
        if (tapLongPressTimer !== null) {
            clearTimeout(tapLongPressTimer);
            tapLongPressTimer = null;
            manualCountRep();
        }
    });

    tapArea.addEventListener('pointerleave', () => {
        if (tapLongPressTimer !== null) {
            clearTimeout(tapLongPressTimer);
            tapLongPressTimer = null;
        }
    });
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
    switch (currentExercise) {
        case 'pushup': onPushupPose(lms); return;
        case 'squat':  onSquatPose(lms);  return;
        case 'situp':  onSitupPose(lms);  return;
        case 'dip':    onDipPose(lms);    return;
        default:       onPullupPose(lms); return;
    }
}

function onPullupPose(lms) {
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

// ===== PUSH-UP DETECTION =====
function onPushupPose(lms) {
    const ls = lm(lms, 11), rs = lm(lms, 12);  // shoulders
    const le = lm(lms, 13), re = lm(lms, 14);  // elbows
    const lw = lm(lms, 15), rw = lm(lms, 16);  // wrists

    const hasLeft  = visible(ls) && visible(le) && visible(lw);
    const hasRight = visible(rs) && visible(re) && visible(rw);

    if (!hasLeft && !hasRight) {
        updatePoseDot(false, 'Không thấy tay – điều chỉnh camera');
        return;
    }

    updatePoseDot(true, 'Đang theo dõi');

    const angles = [];
    if (hasLeft)  angles.push(calcAngle(ls, le, lw));
    if (hasRight) angles.push(calcAngle(rs, re, rw));
    const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
    const smooth = smoothPush(avg);

    let detected = null;
    if (smooth < PUSHUP_DOWN_THRESH) detected = 'DOWN';
    else if (smooth > PUSHUP_UP_THRESH) detected = 'UP';

    if (detected === 'UP')   updateTip('Tư thế sẵn sàng – xuống để đếm');
    else if (detected === 'DOWN') updateTip('Đẩy lên!');

    processPhaseTransition(detected);
}

// ===== SQUAT DETECTION =====
function onSquatPose(lms) {
    const lh = lm(lms, 23), rh = lm(lms, 24);  // hips
    const lk = lm(lms, 25), rk = lm(lms, 26);  // knees
    const la = lm(lms, 27), ra = lm(lms, 28);  // ankles

    const hasLeft  = visible(lh) && visible(lk) && visible(la);
    const hasRight = visible(rh) && visible(rk) && visible(ra);

    if (!hasLeft && !hasRight) {
        updatePoseDot(false, 'Không thấy chân – camera từ bên cạnh');
        return;
    }

    updatePoseDot(true, 'Đang theo dõi');

    const angles = [];
    if (hasLeft)  angles.push(calcAngle(lh, lk, la));
    if (hasRight) angles.push(calcAngle(rh, rk, ra));
    const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
    const smooth = smoothPush(avg);

    let detected = null;
    if (smooth < SQUAT_DOWN_THRESH) detected = 'DOWN';
    else if (smooth > SQUAT_UP_THRESH) detected = 'UP';

    if (detected === 'UP')   updateTip('Đứng thẳng – squat xuống để đếm');
    else if (detected === 'DOWN') updateTip('Đứng lên!');

    processPhaseTransition(detected);
}

// ===== SIT-UP DETECTION =====
function onSitupPose(lms) {
    const ls = lm(lms, 11), rs = lm(lms, 12);  // shoulders
    const lh = lm(lms, 23), rh = lm(lms, 24);  // hips
    const lk = lm(lms, 25), rk = lm(lms, 26);  // knees

    const hasLeft  = visible(ls) && visible(lh) && visible(lk);
    const hasRight = visible(rs) && visible(rh) && visible(rk);

    if (!hasLeft && !hasRight) {
        updatePoseDot(false, 'Không thấy người – camera từ bên cạnh');
        return;
    }

    updatePoseDot(true, 'Đang theo dõi');

    const angles = [];
    if (hasLeft)  angles.push(calcAngle(ls, lh, lk));
    if (hasRight) angles.push(calcAngle(rs, rh, rk));
    const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
    const smooth = smoothPush(avg);

    // Large angle = lying flat (DOWN), small angle = sitting up (UP)
    let detected = null;
    if (smooth > SITUP_DOWN_THRESH) detected = 'DOWN';
    else if (smooth < SITUP_UP_THRESH) detected = 'UP';

    if (detected === 'DOWN') updateTip('Gập người lên!');
    else if (detected === 'UP')   updateTip('Nằm xuống để đếm');

    processPhaseTransition(detected);
}

// ===== BAR DIP DETECTION =====
function onDipPose(lms) {
    const ls = lm(lms, 11), rs = lm(lms, 12);  // shoulders
    const le = lm(lms, 13), re = lm(lms, 14);  // elbows
    const lw = lm(lms, 15), rw = lm(lms, 16);  // wrists

    const hasLeft  = visible(ls) && visible(le) && visible(lw);
    const hasRight = visible(rs) && visible(re) && visible(rw);

    if (!hasLeft && !hasRight) {
        updatePoseDot(false, 'Không thấy tay – camera từ bên cạnh');
        return;
    }

    // Optional: check that wrists are roughly at hip level or above (hanging position)
    const lh = lm(lms, 23), rh = lm(lms, 24);
    const hipY = (visible(lh) && visible(rh)) ? (lh.y + rh.y) / 2
               : visible(lh) ? lh.y : visible(rh) ? rh.y : 1;
    const wristY = (hasLeft && hasRight) ? (lw.y + rw.y) / 2
                 : hasLeft ? lw.y : rw.y;
    const onBars = wristY < hipY + 0.05;

    updatePoseDot(true, onBars ? '✓ Đang trên xà' : 'Phát hiện người');
    if (!onBars) updateTip('Leo lên xà song song và nắm thanh');

    const angles = [];
    if (hasLeft)  angles.push(calcAngle(ls, le, lw));
    if (hasRight) angles.push(calcAngle(rs, re, rw));
    const avg = angles.reduce((a, b) => a + b, 0) / angles.length;
    const smooth = smoothPush(avg);

    let detected = null;
    if (smooth < DIP_DOWN_THRESH) detected = 'DOWN';
    else if (smooth > DIP_UP_THRESH) detected = 'UP';

    if (detected === 'UP')   updateTip('Tay thẳng – thả xuống để đếm');
    else if (detected === 'DOWN') updateTip('Đẩy lên!');

    processPhaseTransition(detected);
}

function countRep() {
    repCount++;
    const el = document.getElementById('repCount');
    el.textContent = repCount;
    el.classList.remove('bump');
    void el.offsetWidth; // reflow to restart animation
    el.classList.add('bump');
    triggerRepFlash();
    igniteAuraBurst();
    updateTip(`🔥 Tốt lắm! ${repCount} lần rồi!`);
}

function setCounterPhase(phase) {
    const el      = document.getElementById('counterPhase');
    const overlay = document.getElementById('phaseOverlay');
    const oText   = document.getElementById('phaseOverlayText');

    const phaseText = {
        pullup: { DOWN: '⬇ Đang xuống',          UP: '⬆ Đã lên – thả xuống' },
        pushup: { DOWN: '⬇ Xuống – đẩy lên!',    UP: '⬆ Tư thế sẵn sàng' },
        situp:  { DOWN: '⬇ Nằm xuống',            UP: '⬆ Ngồi lên!' },
        squat:  { DOWN: '⬇ Squat – đứng lên!',    UP: '⬆ Đứng thẳng' },
        dip:    { DOWN: '⬇ Xuống – đẩy lên!',     UP: '⬆ Tay thẳng' },
    };
    const labels = phaseText[currentExercise] || phaseText.pullup;

    if (phase === 'DOWN') {
        el.textContent    = labels.DOWN;
        el.className      = 'counter-phase phase-down';
        overlay.className = 'phase-overlay phase-down';
        oText.textContent = '↓';
        overlay.style.display = '';
    } else if (phase === 'UP') {
        el.textContent    = labels.UP;
        el.className      = 'counter-phase phase-up';
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

// ===== SUPER SAIYAN AURA =====
// All drawing runs inside the same mirrored, video-scaled canvas context as the
// pose skeleton, so aura coordinates (landmark * canvas size) line up with the
// athlete. Glows use additive ('lighter') blending so the body "powers up"
// instead of being covered.

function resetAura() {
    auraLevel      = 0;
    auraBurst      = 0;
    auraParticles  = [];
    auraShockwaves = [];
    lastAuraBody   = null;
}

// One soft radial sprite, drawn (scaled/stretched) for every glow and spark.
function getAuraSprite() {
    if (auraSprite) return auraSprite;
    const s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,    'rgba(255,255,238,1)');
    grad.addColorStop(0.25, 'rgba(255,228,140,0.85)');
    grad.addColorStop(0.55, 'rgba(255,160,45,0.35)');
    grad.addColorStop(1,    'rgba(255,140,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    auraSprite = s;
    return s;
}

// Bounding box + torso-weighted center of the athlete, in canvas pixels.
function measureBody(lms, canvasW, canvasH) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0, count = 0;
    for (const idx of AURA_BODY_POINTS) {
        const p = lm(lms, idx);
        if (!visible(p)) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        count++;
    }
    if (count < AURA_MIN_BODY_POINTS) return null;

    // Center the aura on the torso so it stays put even if limbs swing wide.
    const torso = [lm(lms, 11), lm(lms, 12), lm(lms, 23), lm(lms, 24)].filter(visible);
    let cx, cy;
    if (torso.length >= 2) {
        cx = torso.reduce((a, p) => a + p.x, 0) / torso.length;
        cy = torso.reduce((a, p) => a + p.y, 0) / torso.length;
    } else {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
    }
    return {
        cx: cx * canvasW,
        cy: cy * canvasH,
        halfW: Math.max((maxX - minX) * canvasW / 2, 30),
        halfH: Math.max((maxY - minY) * canvasH / 2, 60),
    };
}

function spawnAuraParticle(body) {
    const ang = Math.random() * Math.PI * 2;
    // Bias sparks toward the silhouette edge and lower body so flames lick upward.
    const rx = body.halfW * (0.55 + Math.random() * 0.6);
    const ry = body.halfH * (0.55 + Math.random() * 0.55);
    const speed = body.halfH * (0.9 + Math.random() * 0.9);
    const life  = 0.5 + Math.random() * 0.7;
    auraParticles.push({
        x: body.cx + Math.cos(ang) * rx,
        y: body.cy + Math.sin(ang) * ry * 0.6 + body.halfH * 0.15,
        vx: (Math.random() - 0.5) * body.halfW * 0.5,
        vy: -speed,                       // negative = rising (y grows downward)
        accY: -body.halfH * 0.6,          // accelerate upward like real flame
        life,
        maxLife: life,
        size: body.halfW * 0.18 * (0.5 + Math.random() * 0.9),
        wobble: Math.random() * Math.PI * 2,
        wobSpeed: 6 + Math.random() * 6,
    });
}

function updateAura(dt, intensity, body) {
    if (body && intensity > 0.05) {
        // Spawn rate scales with intensity; a burst adds a quick puff of sparks.
        const rate = intensity * 26 * dt + (auraBurst > 0.3 ? auraBurst * 1.5 : 0);
        let toSpawn = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
        toSpawn = Math.min(toSpawn, 8);
        for (let i = 0; i < toSpawn && auraParticles.length < AURA_MAX_PARTICLES; i++) {
            spawnAuraParticle(body);
        }
    }
    for (let i = auraParticles.length - 1; i >= 0; i--) {
        const p = auraParticles[i];
        p.life -= dt;
        if (p.life <= 0) { auraParticles.splice(i, 1); continue; }
        p.vy += p.accY * dt;
        p.wobble += dt * p.wobSpeed;
        p.x += p.vx * dt + Math.sin(p.wobble) * 8 * dt;
        p.y += p.vy * dt;
    }
}

function drawAuraHalo(ctx, body, intensity, flicker) {
    const sprite = getAuraSprite();
    // Body halo – a tall golden glow enveloping the athlete.
    const w = body.halfW * 2 * (1.7 + 0.5 * intensity) * flicker;
    const h = body.halfH * 2 * (1.35 + 0.45 * intensity) * flicker;
    ctx.globalAlpha = Math.min(0.6, 0.32 + 0.4 * intensity);
    ctx.drawImage(sprite, body.cx - w / 2, body.cy - h / 2, w, h);

    // Energy pillar rising above the head – the classic Super Saiyan beam.
    const pw = body.halfW * 1.4 * flicker;
    const ph = body.halfH * (1.6 + 1.2 * intensity) * flicker;
    ctx.globalAlpha = Math.min(0.5, 0.2 + 0.4 * intensity);
    ctx.drawImage(sprite, body.cx - pw / 2, body.cy - body.halfH - ph * 0.55, pw, ph);
    ctx.globalAlpha = 1;
}

function drawAuraFlames(ctx, body, intensity, t, flicker) {
    const spikes = 22;
    const baseR  = Math.max(body.halfW, body.halfH * 0.7);
    ctx.lineCap = 'round';
    for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2;
        // Pseudo-noise so each tongue of flame flickers independently.
        const n   = 0.5 + 0.5 * Math.sin(t * 9 + i * 1.7) * Math.sin(t * 5 + i * 0.6);
        const len = baseR * (0.25 + 0.75 * n) * intensity * flicker;
        const ox  = body.cx + Math.cos(a) * body.halfW * 1.05;
        const oy  = body.cy + Math.sin(a) * body.halfH * 1.05;
        const tx  = ox + Math.cos(a) * len * 0.4;
        const ty  = oy + Math.sin(a) * len * 0.4 - len;   // tips bend upward
        ctx.strokeStyle = i % 5 === 0
            ? `rgba(255,255,210,${0.5 * intensity})`
            : `rgba(255,${150 + Math.floor(80 * n)},40,${0.4 * intensity})`;
        ctx.lineWidth = (2 + 3 * intensity) * (0.6 + 0.4 * n);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.quadraticCurveTo((ox + tx) / 2 + Math.sin(t * 7 + i) * 4, (oy + ty) / 2, tx, ty);
        ctx.stroke();
    }
}

function drawAuraParticles(ctx) {
    const sprite = getAuraSprite();
    for (const p of auraParticles) {
        const k = p.life / p.maxLife;            // 1 → 0 over its lifetime
        ctx.globalAlpha = Math.max(0, k * k) * 0.9;
        const sz = p.size * (0.4 + 0.6 * k);     // shrink as it fades out
        ctx.drawImage(sprite, p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
}

function drawAuraLightning(ctx, body, intensity) {
    const alpha = Math.min(0.8, intensity - AURA_LIGHTNING_LEVEL);
    const bolts = 1 + Math.floor(Math.random() * 2);
    for (let b = 0; b < bolts; b++) {
        const a0 = Math.random() * Math.PI * 2;
        let x = body.cx + Math.cos(a0) * body.halfW * 0.7;
        let y = body.cy + Math.sin(a0) * body.halfH * 0.7;
        const segs = 5 + Math.floor(Math.random() * 4);
        ctx.strokeStyle = `rgba(150,235,255,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < segs; s++) {
            x += (Math.random() - 0.5) * body.halfW * 0.8;
            y += -Math.random() * body.halfH * 0.5;   // crackle upward & outward
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
}

function drawAuraShockwaves(ctx, now) {
    auraShockwaves = auraShockwaves.filter(s => now - s.born < AURA_SHOCKWAVE_MS);
    if (!auraShockwaves.length || !lastAuraBody) return;

    const b = lastAuraBody;
    const baseR = Math.max(b.halfW, b.halfH);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of auraShockwaves) {
        const k = (now - s.born) / AURA_SHOCKWAVE_MS;  // 0 → 1
        ctx.strokeStyle = `rgba(255,225,120,${(1 - k) * 0.6})`;
        ctx.lineWidth = 6 * (1 - k) + 1;
        ctx.beginPath();
        ctx.arc(b.cx, b.cy, (0.4 + k * 1.6) * baseR, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}

// Fired on every counted rep: flare the aura, puff sparks, launch a shockwave.
function igniteAuraBurst() {
    auraBurst = Math.min(1.6, auraBurst + 1.2);
    auraShockwaves.push({ born: performance.now() });
    const wrap = document.getElementById('cameraWrap');
    if (wrap) {
        wrap.classList.remove('power-surge');
        void wrap.offsetWidth;
        wrap.classList.add('power-surge');
    }
}

function drawSuperSaiyanAura(ctx, lms, canvasW, canvasH) {
    const now = performance.now();
    const dt  = auraLastT ? Math.min(0.05, (now - auraLastT) / 1000) : 0.016;
    auraLastT = now;
    const t   = now / 1000;

    // Ease intensity toward the target set by the current exercise phase.
    let target = 0;
    if (isRunning && poseActive) {
        target = AURA_IDLE_LEVEL;
        const surgePhase = AURA_SURGE_PHASE[currentExercise] || 'UP';
        if (pullPhase === surgePhase) target = 1;
    }
    auraLevel += (target - auraLevel) * Math.min(1, dt * 6);
    auraBurst *= Math.exp(-dt * 3.2);
    const intensity = auraLevel + auraBurst;

    const body = measureBody(lms, canvasW, canvasH);
    if (body) lastAuraBody = body;
    updateAura(dt, body ? intensity : 0, body);

    if (body && intensity >= 0.03) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const flicker = 1 + 0.07 * Math.sin(t * 31) + 0.05 * Math.sin(t * 53 + 1.3);
        drawAuraHalo(ctx, body, intensity, flicker);
        drawAuraFlames(ctx, body, intensity, t, flicker);
        drawAuraParticles(ctx);
        if (intensity > AURA_LIGHTNING_LEVEL) drawAuraLightning(ctx, body, intensity);
        ctx.restore();
    }

    // Shockwaves outlive the fading aura, so draw them regardless of intensity.
    drawAuraShockwaves(ctx, now);
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
            // Blaze the Super Saiyan aura behind the skeleton so lines stay crisp.
            drawSuperSaiyanAura(ctx, results.poseLandmarks, canvas.width, canvas.height);

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
    resetAura();
    isRunning    = true;
    sessionStart = Date.now();

    const ex = EXERCISES[currentExercise];

    document.getElementById('repCount').textContent = '0';
    document.getElementById('counterPhase').textContent = 'Đang theo dõi...';
    document.getElementById('counterPhase').className  = 'counter-phase';
    document.getElementById('timerCard').style.visibility = 'visible';
    document.getElementById('btnStart').style.display    = 'none';
    document.getElementById('btnStop').style.display     = '';
    document.getElementById('instructionsCard').style.display = 'none';
    document.getElementById('exercisePicker').style.display = 'none';

    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();

    if (ex.usesCamera) {
        startCamera();
    } else {
        document.getElementById('tapArea').style.display = '';
        document.getElementById('tapArea').classList.add('active');
    }

    showToast(ex.startHint);
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
    const ex = EXERCISES[currentExercise];

    document.getElementById('btnStop').style.display     = 'none';
    document.getElementById('btnStart').style.display    = '';
    document.getElementById('counterPhase').textContent  = 'Kết thúc';
    document.getElementById('counterPhase').className    = 'counter-phase';
    document.getElementById('phaseOverlay').style.display = 'none';
    document.getElementById('instructionsCard').style.display = '';
    document.getElementById('exercisePicker').style.display = '';

    if (ex.usesCamera) {
        stopCamera();
    } else {
        document.getElementById('tapArea').classList.remove('active');
    }

    if (repCount > 0) {
        pendingSave = { reps: repCount, duration_sec: duration, exercise_type: currentExercise };
        openSaveModal(repCount, duration);
    } else {
        showToast('Không có lần tập nào được ghi nhận.');
    }
}

// ===== SAVE MODAL =====

function openSaveModal(reps, duration) {
    const ex = EXERCISES[currentExercise] || EXERCISES.pullup;
    document.getElementById('saveReps').textContent      = reps;
    document.getElementById('saveDuration').textContent  = formatDuration(duration);
    document.getElementById('saveBigLabel').textContent  = ex.unit;
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

    const exercise_type = pendingSave?.exercise_type || 'pullup';

    const { data, error } = await supabaseClient
        .from('pullup_sessions')
        .insert({ user_id: currentUser.id, reps, duration_sec, exercise_type })
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
    const ex = EXERCISES[exercise_type] || EXERCISES.pullup;
    showToast(`✅ Đã lưu ${reps} ${ex.unit}!`);
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
    loadAICache();
}

// Group sessions by calendar day + exercise type, sorted newest-first
function groupByDayAndExercise(list) {
    const map = {};
    list.forEach(s => {
        const exType  = s.exercise_type || 'pullup';
        const dateKey = localDateKey(new Date(s.created_at));
        const mapKey  = `${dateKey}|${exType}`;
        if (!map[mapKey]) map[mapKey] = { dateKey, exercise_type: exType, reps: 0, duration: 0, sets: 0 };
        map[mapKey].reps     += s.reps;
        map[mapKey].duration += s.duration_sec;
        map[mapKey].sets++;
    });
    return Object.values(map).sort((a, b) => {
        const dc = b.dateKey.localeCompare(a.dateKey);
        return dc !== 0 ? dc : a.exercise_type.localeCompare(b.exercise_type);
    });
}

// Group sessions by calendar day (all exercises), return array sorted newest-first
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

    const entries    = groupByDayAndExercise(sessions);
    const uniqueDays = new Set(entries.map(e => e.dateKey)).size;
    empty.style.display = 'none';
    countEl.textContent = `${uniqueDays} ngày`;

    const grid = document.createElement('div');
    grid.className = 'history-grid';

    entries.forEach(d => {
        const [y, m, day] = d.dateKey.split('-');
        const dateStr  = `${parseInt(day)}/${parseInt(m)}/${y}`;
        const rateStr  = d.duration > 0
            ? `${(d.reps / (d.duration / 60)).toFixed(1)}/phút`
            : '';
        const setsStr  = d.sets > 1 ? `${d.sets} hiệp` : '';
        const ex       = EXERCISES[d.exercise_type] || EXERCISES.pullup;

        const card = document.createElement('div');
        card.className = 'session-card';
        card.innerHTML = `
            <div class="session-reps-box">
                <span class="session-reps-num">${esc(String(d.reps))}</span>
                <span class="session-reps-label">LẦN</span>
            </div>
            <div class="session-meta">
                <div class="session-ex-badge">${esc(ex.icon)} ${esc(ex.name)}</div>
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
    clearAICache();
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

// Exercise picker
document.querySelectorAll('.ex-btn').forEach(btn => {
    btn.addEventListener('click', () => selectExercise(btn.dataset.type));
});

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
setupTapArea();
selectExercise('pullup');

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

    const ex = EXERCISES[currentExercise] || EXERCISES.pullup;
    const exSessions = sessions.filter(s => (s.exercise_type || 'pullup') === currentExercise);

    if (!currentUser) {
        idle.innerHTML = 'Đăng nhập để sử dụng tính năng phân tích AI';
    } else if (exSessions.length < 1) {
        idle.innerHTML = `Chưa có lần tập <strong>${esc(ex.name)}</strong> nào. Hãy hoàn thành lần đầu tiên!`;
    } else {
        idle.innerHTML = `Nhấn <strong>Phân tích</strong> để AI nhận xét lịch sử tập <strong>${esc(ex.name)}</strong>`;
    }

    document.getElementById('btnAnalyze').disabled = !currentUser;
}

function aiCacheKey() {
    return currentUser ? `ai_result_${currentUser.id}_${currentExercise}` : null;
}

function saveAICache(data) {
    const key = aiCacheKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
}

function loadAICache() {
    const key = aiCacheKey();
    if (!key) return false;
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data) return false;

        const idleEl   = document.getElementById('aiIdle');
        const loadEl   = document.getElementById('aiLoading');
        const resultEl = document.getElementById('aiResult');
        renderAIResult(data);
        idleEl.style.display   = 'none';
        loadEl.style.display   = 'none';
        resultEl.style.display = '';
        return true;
    } catch (_) { return false; }
}

function clearAICache() {
    const key = aiCacheKey();
    if (key) localStorage.removeItem(key);
}

async function analyzeWithAI() {
    if (!supabaseClient || !currentUser) { openLoginModal(); return; }

    const ex = EXERCISES[currentExercise] || EXERCISES.pullup;
    const exSessions = sessions.filter(s => (s.exercise_type || 'pullup') === currentExercise);
    if (exSessions.length < 1) { showToast(`Chưa có dữ liệu ${ex.name} để phân tích`); return; }

    const btn      = document.getElementById('btnAnalyze');
    const idleEl   = document.getElementById('aiIdle');
    const loadEl   = document.getElementById('aiLoading');
    const resultEl = document.getElementById('aiResult');

    btn.disabled           = true;
    idleEl.style.display   = 'none';
    loadEl.style.display   = '';
    resultEl.style.display = 'none';

    try {
        const days = groupByDay(exSessions).slice(0, 90).map(d => ({ date: d.key, reps: d.reps }));
        const { data, error } = await supabaseClient.functions.invoke('analyze-pullup', {
            body: { days, exercise_name: ex.name },
        });
        if (error) {
            let detail = error.message;
            try { const b = await error.context?.json?.(); detail += ' | ' + JSON.stringify(b); } catch (_) {}
            console.error('invoke error:', detail);
            throw new Error(detail);
        }
        if (!data)  throw new Error('Không nhận được dữ liệu từ server');

        saveAICache(data);
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
let dashExerciseFilter = 'all';

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
    const filtered = dashExerciseFilter === 'all'
        ? sessions
        : sessions.filter(s => s.exercise_type === dashExerciseFilter);
    if (!filtered.length) {
        ['dashTotalReps','dashBestSession','dashAvgSession','dashTotalSessions'].forEach(id => {
            document.getElementById(id).textContent = '—';
        });
        return;
    }
    const days  = groupByDay(filtered);
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

    const filtered = dashExerciseFilter === 'all'
        ? sessions
        : sessions.filter(s => s.exercise_type === dashExerciseFilter);

    if (!filtered.length) {
        emptyEl.style.display  = '';
        scrollEl.style.display = 'none';
        emptyEl.querySelector('p').textContent = dashExerciseFilter === 'all'
            ? 'Chưa có dữ liệu để hiển thị'
            : 'Chưa có dữ liệu cho bài tập này';
        return;
    }

    const buckets = buildBuckets(dashPeriod);

    // Sum reps per bucket
    const totals = {};
    filtered.forEach(s => {
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

    const filtered = dashExerciseFilter === 'all'
        ? sessions
        : sessions.filter(s => s.exercise_type === dashExerciseFilter);

    const dayMap = {};
    filtered.forEach(s => {
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

document.querySelectorAll('.dash-ex-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.dash-ex-btn').forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        dashExerciseFilter = btn.dataset.exercise;
        renderDashStats();
        renderDashChart();
        renderHeatmap();
    });
});
