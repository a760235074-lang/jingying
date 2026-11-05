// 菁鷹直排輪 課務管理 — 管理員 / 教練 雙身分版本（Firebase）
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc,
  onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const WD = ['日','一','二','三','四','五','六'];
const LEVELS = ['入門','初級','中級','進階','選手班'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const money = n => 'NT$ ' + Math.round(n || 0).toLocaleString('zh-TW');
const endTime = (start, dur) => { const [h, m] = (start || '00:00').split(':').map(Number); const t = h * 60 + m + (+dur || 0); return pad(Math.floor(t / 60) % 24) + ':' + pad(t % 60); };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 未設定 Firebase ---------- */
if (!firebaseConfig || String(firebaseConfig.apiKey).startsWith('YOUR')) {
  $('#sync').textContent = '尚未設定';
  $('#main').innerHTML = `<div class="view"><div class="empty"><b>還沒有連上資料庫</b>
    <span>請打開 config.js，貼上你在 Firebase 建立的網頁應用程式設定，再重新上傳網站。<br>步驟請看「設定教學.md」。</span></div></div>`;
  throw new Error('Firebase config missing');
}

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
let fs;
try { fs = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (_) { fs = initializeFirestore(fb, {}); }

/* ---------- 狀態 ---------- */
const S = {
  me: null, profile: null, users: [], students: [], classes: [], payments: [], sessions: [], leads: [],
  settings: { locations: [], absentDeducts: true }, rates: {},
  tab: 'today', day: ymd(new Date()), q: '', month: ymd(new Date()).slice(0, 7), mine: true, unsubs: [],
  stuTab: 'students', stFilter: 'active', tag: '', leadFilter: 'open', moreTab: 'stats', year: new Date().getFullYear()
};
const isAdmin = () => S.profile && S.profile.role === 'admin';
const userName = uid => { const u = S.users.find(x => x.id === uid); return u ? (u.name || u.email) : ''; };
const coaches = () => S.users.filter(u => u.role === 'admin' || u.role === 'coach');

/* ---------- 共用 ---------- */
let toastT;
function toast(msg) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); } t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2400); }
function fbErr(e) {
  const c = (e && e.code) || '';
  const map = {
    'auth/invalid-email': 'Email 格式不正確。', 'auth/missing-password': '請輸入密碼。',
    'auth/invalid-credential': 'Email 或密碼錯誤。', 'auth/wrong-password': 'Email 或密碼錯誤。', 'auth/user-not-found': '找不到這個帳號，請先註冊。',
    'auth/email-already-in-use': '這個 Email 已經註冊過，請直接登入。', 'auth/weak-password': '密碼至少要 6 個字元。',
    'auth/too-many-requests': '嘗試太多次，請稍後再試。', 'auth/network-request-failed': '網路連線失敗，請檢查網路。',
    'permission-denied': '你沒有權限做這個動作。', 'unavailable': '目前連不上資料庫，網路恢復後會自動同步。'
  };
  return map[c] || ('發生錯誤：' + (e && e.message || c));
}
const setSync = t => $('#sync').textContent = t;

/* ---------- 登入 / 註冊 ---------- */
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
async function googleLogin() {
  const err = $('#au-err'); err.textContent = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    if (isStandalone()) { await signInWithRedirect(auth, provider); return; }
    const cred = await signInWithPopup(auth, provider);
    await createProfile(cred.user, cred.user.displayName);
  } catch (e) {
    if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
    }
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) return;
    if (e && e.code === 'auth/unauthorized-domain') { err.textContent = '這個網址還沒加入 Firebase 的授權網域，請管理員到 Authentication → 設定 → 授權網域 新增。'; return; }
    err.textContent = fbErr(e);
  }
}
getRedirectResult(auth).then(r => { if (r && r.user) createProfile(r.user, r.user.displayName).catch(() => {}); }).catch(e => { const el = $('#au-err'); if (el) el.textContent = fbErr(e); });

function authView(mode = 'login', msg = '') {
  $('#nav').hidden = true; closeSheet();
  setSync('未登入');
  const reg = mode === 'register';
  const showEmail = mode !== 'google';
  if (mode === 'google' || mode === 'login' && !msg && !authView.emailOpen) {
    $('#main').innerHTML = `<div class="auth">
      <h2>登入菁鷹</h2>
      <div class="sub">教練第一次登入後，請通知管理員開通。第一位登入的人會自動成為管理員。</div>
      <button class="btn gbtn" id="au-google" type="button"><svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>使用 Google 帳號登入</button>
      <div class="err" id="au-err">${esc(msg)}</div>
      <button class="linkbtn" id="au-email-open" type="button">改用 Email 登入</button></div>`;
    $('#au-google').onclick = googleLogin;
    $('#au-email-open').onclick = () => { authView.emailOpen = true; authView('login'); };
    return;
  }
  $('#main').innerHTML = `<div class="auth">
    <h2>${reg ? '用 Email 註冊' : '用 Email 登入'}</h2>
    <div class="sub">${reg ? '註冊後請通知管理員開通。第一位註冊的人會自動成為管理員。' : '輸入你的 Email 和密碼。'}</div>
    <form class="form" id="authf">
      ${reg ? `<div class="field"><label for="au-name">姓名（顯示在課表上）</label><input id="au-name" required placeholder="林教練" autocomplete="name"></div>` : ''}
      <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" required autocomplete="email" inputmode="email"></div>
      <div class="field"><label for="au-pw">密碼${reg ? '（至少 6 個字元）' : ''}</label><input id="au-pw" type="password" required minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}"></div>
      <div class="err" id="au-err">${esc(msg)}</div>
      <button class="btn" type="submit">${reg ? '註冊' : '登入'}</button>
    </form>
    <div class="row wrap"><button class="linkbtn" id="au-sw">${reg ? '已經有帳號？登入' : '還沒有帳號？註冊'}</button>
    ${reg ? '' : '<span class="grow"></span><button class="linkbtn" id="au-forgot">忘記密碼</button>'}</div>
    <button class="btn ghost" id="au-back" type="button">← 回到 Google 登入</button></div>`;
  $('#au-back').onclick = () => { authView.emailOpen = false; authView('google'); };
  $('#au-sw').onclick = () => authView(reg ? 'login' : 'register');
  const fg = $('#au-forgot');
  if (fg) fg.onclick = async () => {
    const em = $('#au-email').value.trim(); if (!em) { $('#au-err').textContent = '請先在上面輸入 Email。'; return; }
    try { await sendPasswordResetEmail(auth, em); $('#au-err').textContent = '已寄出重設密碼信，請到信箱收信。'; } catch (e) { $('#au-err').textContent = fbErr(e); }
  };
  $('#authf').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
    const em = $('#au-email').value.trim(), pw = $('#au-pw').value;
    try {
      if (reg) {
        const name = $('#au-name').value.trim();
        const cred = await createUserWithEmailAndPassword(auth, em, pw);
        await createProfile(cred.user, name);
      } else await signInWithEmailAndPassword(auth, em, pw);
    } catch (err) { $('#au-err').textContent = fbErr(err); btn.disabled = false; }
  };
}
async function createProfile(user, name) {
  const mine = await getDoc(doc(fs, 'users', user.uid)).catch(() => null);
  if (mine && mine.exists()) return; // 已經建立過，不要覆蓋
  const base = { name: name || user.email, email: user.email, createdAt: Date.now() };
  const owner = await getDoc(doc(fs, 'meta', 'owner')).catch(() => null);
  if (owner && !owner.exists()) {
    const b = writeBatch(fs);
    b.set(doc(fs, 'users', user.uid), { ...base, role: 'admin' });
    b.set(doc(fs, 'meta', 'owner'), { uid: user.uid });
    try { await b.commit(); return; } catch (_) { /* 有人搶先成為管理員 */ }
  }
  await setDoc(doc(fs, 'users', user.uid), { ...base, role: 'pending' });
}
function waitView(title, text) {
  $('#nav').hidden = true; setSync(S.me ? S.me.email : '');
  $('#main').innerHTML = `<div class="auth"><div class="empty"><b>${esc(title)}</b><span>${text}</span>
    <button class="btn ghost" id="lo">登出</button></div></div>`;
  $('#lo').onclick = () => signOut(auth);
}

/* ---------- 資料同步 ---------- */
function stopAll() { S.unsubs.forEach(u => { try { u(); } catch (_) {} }); S.unsubs = []; }
let profUnsub = null;
onAuthStateChanged(auth, user => {
  stopAll(); if (profUnsub) { profUnsub(); profUnsub = null; }
  S.me = user; S.profile = null;
  if (!user) return authView();
  setSync('連線中…');
  let started = false, tries = 0;
  profUnsub = onSnapshot(doc(fs, 'users', user.uid), async snap => {
    if (!snap.exists()) {
      // 剛註冊、資料還沒寫好；或資料被刪除
      waitView('正在建立帳號…', '請稍候幾秒。');
      if (tries++ < 1) setTimeout(async () => { try { await createProfile(user, user.displayName || ''); } catch (_) {} }, 4000);
      else setTimeout(() => { if (!S.profile) waitView('找不到帳號資料', '請聯絡管理員，或登出後重新註冊。'); }, 6000);
      return;
    }
    const prev = S.profile && S.profile.role;
    S.profile = { id: snap.id, ...snap.data() };
    const r = S.profile.role;
    if (r === 'pending') { stopAll(); started = false; return waitView('等待管理員開通', `你的帳號（${esc(user.email)}）已註冊。請管理員到「管理 → 教練帳號」按「開通」，開通後這個畫面會自動進入。`); }
    if (r === 'disabled') { stopAll(); started = false; return waitView('帳號已停用', '如有疑問請聯絡管理員。'); }
    if (!started || prev !== r) { stopAll(); started = true; startData(); }
    else render();
  }, err => waitView('無法讀取帳號', esc(fbErr(err))));
});

function sub(ref, fn) {
  S.unsubs.push(onSnapshot(ref, fn, err => { if (err.code !== 'permission-denied') setSync('同步中斷'); }));
}
function startData() {
  $('#nav').hidden = false;
  S.tab = 'today';
  const cols = ['users', 'students', 'classes', 'sessions', 'leads'];
  if (isAdmin()) cols.push('payments');
  const cached = {};
  const syncLabel = () => setSync(Object.values(cached).some(Boolean) ? (navigator.onLine ? '同步中…' : '離線中') : '已同步');
  for (const c of cols) {
    cached[c] = true;
    S.unsubs.push(onSnapshot(collection(fs, c), { includeMetadataChanges: true }, snap => {
      cached[c] = snap.metadata.fromCache; syncLabel();
      if (S[c]._ok && snap.docChanges().length === 0) return; // 只有同步狀態改變，資料沒變
      S[c] = snap.docs.map(d => ({ id: d.id, ...d.data() })); S[c]._ok = true;
      render();
    }, err => { if (err.code !== 'permission-denied') setSync('同步中斷'); }));
  }
  window.addEventListener('online', syncLabel); window.addEventListener('offline', syncLabel);
  sub(doc(fs, 'meta', 'settings'), snap => { if (snap.exists()) S.settings = { locations: [], absentDeducts: true, ...snap.data() }; render(); });
  if (isAdmin()) sub(doc(fs, 'meta', 'rates'), snap => { S.rates = snap.exists() ? snap.data() : {}; render(); });
  renderTabs(); render();
}

/* ---------- 計算 ---------- */
const stuById = id => S.students.find(s => s.id === id);
const clsById = id => S.classes.find(c => c.id === id);
const today = () => ymd(new Date());
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5);
const periodsOf = s => (s && Array.isArray(s.periods)) ? s.periods : [];
const inPeriod = (s, date) => periodsOf(s).some(p => p.start <= date && date <= p.end);
const periodEnd = s => { const ps = periodsOf(s); return ps.length ? ps.map(p => p.end).sort().pop() : null; };
function lessonsOf(sid) {
  const s = stuById(sid); const bought = (s && +s.bought) || 0; let used = 0, attended = 0, total = 0;
  for (const ss of S.sessions) {
    if (ss.cancelled) continue;
    const st = ss.status && ss.status[sid]; if (!st) continue;
    total++; if (st === 'present') attended++;
    if ((st === 'present' || (st === 'absent' && S.settings.absentDeducts)) && !inPeriod(s, ss.date)) used++;
  }
  return { bought, used, left: bought - used, attended, total };
}
function stuState(s) {
  if (s.archived) return 'archived';
  if (s.renew) return 'renew';
  const pe = periodEnd(s), L = lessonsOf(s.id);
  if (pe && pe >= today()) return 'active';
  if (L.bought > 0 && L.left <= 0) return 'renew';
  if (pe && pe < today() && L.left <= 0) return 'renew';
  return 'active';
}
function leftPill(sid) {
  const s = stuById(sid); const pe = periodEnd(s); const t = today();
  if (pe && pe >= t) { const d = daysBetween(t, pe); return `<span class="pill ${d <= 7 ? 'warn' : 'ok'}">月費到 ${pe.slice(5).replace('-', '/')}</span>`; }
  const { bought, left } = lessonsOf(sid);
  if (!bought) return pe ? '<span class="pill bad">月費已到期</span>' : '<span class="pill info">未繳費</span>';
  const k = left <= 0 ? 'bad' : left <= 2 ? 'warn' : 'ok';
  return `<span class="pill ${k}">剩 <span class="num">${left}</span> 堂</span>`;
}
const lastAttend = sid => { let l = null; for (const ss of S.sessions) if (!ss.cancelled && ss.status && ss.status[sid] === 'present' && (!l || ss.date > l)) l = ss.date; return l; };
const sessionOf = (cid, date) => S.sessions.find(s => s.classId === cid && s.date === date);
function classesOn(date) {
  const wd = parseYmd(date).getDay();
  return S.classes.filter(c => c.date ? c.date === date : +c.weekday === wd).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}
const allTags = () => [...new Set(S.students.flatMap(s => s.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const LEAD_SRC = ['FB / IG', '朋友介紹', '路過看到', '學校 / 社團', '活動 / 營隊', 'Google 搜尋', '其他'];
const LEAD_ST = { new: ['待聯繫', 'info'], contacted: ['已聯繫', 'info'], trial: ['已約體驗', 'warn'], won: ['已報名', 'ok'], lost: ['沒報名', 'bad'] };
const leadOpen = l => ['new', 'contacted', 'trial'].includes(l.status || 'new');

/* ---------- 分頁 ---------- */
const ICON = {
  today: '<path d="M4 6h16v14H4z M4 10h16 M9 3v4 M15 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  week: '<path d="M4 5h16v15H4z M4 10h16 M10 10v10 M15 10v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  students: '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6 M16 5.5a3 3 0 010 5.6 M18 14.5c2 .8 3 2.8 3 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  pay: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18 M7 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  more: '<path d="M5 20V11 M12 20V5 M19 20v-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'
};
function tabsDef() {
  return isAdmin()
    ? [['today', '今日'], ['week', '課表'], ['students', '學員'], ['pay', '收費'], ['more', '分析']]
    : [['today', '今日'], ['week', '課表'], ['students', '學員'], ['more', '我的']];
}
function renderTabs() {
  $('#tabs').innerHTML = tabsDef().map(([k, l]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>${l}</button>`).join('');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; renderTabs(); render(); window.scrollTo(0, 0); });

function render() {
  if (!S.profile || !['admin', 'coach'].includes(S.profile.role)) return;
  if (!tabsDef().some(t => t[0] === S.tab)) { S.tab = 'today'; renderTabs(); }
  const v = { today: vToday, week: vWeek, students: vStudents, pay: vPay, more: isAdmin() ? vAdmin : vMine }[S.tab]();
  $('#main').innerHTML = v;
}
const A = isAdmin;
const seg = (act, cur, items) => `<div class="seg">${items.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;
const chips = (act, cur, items) => `<div class="chips">${items.map(([v, l]) => `<button type="button" class="chip" data-act="${act}" data-v="${esc(v)}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;

function onboarding() {
  if (!A()) return `<div class="empty"><b>目前還沒有班級或學員</b><span>管理員建立班級並把你設為教練後，你的課就會出現在這裡。</span></div>`;
  const pend = S.users.filter(u => u.role === 'pending').length;
  return `<div class="empty"><b>歡迎，${esc(S.profile.name)}！你是管理員</b>
  <span>從這幾步開始：</span>
  <ol class="steps"><li>請教練用網址登入，再到「分析 → 管理」開通${pend ? `（目前有 ${pend} 位等待中）` : ''}</li><li>到「學員」新增學員與家長聯絡方式</li><li>到「課表」建立班級、指定教練、勾選學員</li><li>到「收費」登記堂數或月費，點名就會自動扣堂</li></ol>
  <button class="btn acc" data-act="newStudent">新增第一位學員</button></div>`;
}

/* ---------- 今日 ---------- */
function weekStrip() {
  const d = parseYmd(S.day), mon = addDays(d, -((d.getDay() + 6) % 7)), t = today();
  let h = '<div class="wk">';
  for (let i = 0; i < 7; i++) {
    const x = addDays(mon, i), k = ymd(x), n = classesOn(k).length;
    h += `<button class="wk-d${k === S.day ? ' on' : ''}${k === t ? ' now' : ''}" data-act="pickDay" data-v="${k}" aria-label="${x.getMonth() + 1}月${x.getDate()}日，${n} 堂課">
      <span class="wk-w">${WD[x.getDay()]}</span><span class="wk-n num">${x.getDate()}</span><span class="wk-dots">${'<i></i>'.repeat(Math.min(n, 4))}</span></button>`;
  }
  return h + '</div>';
}
function vToday() {
  const d = parseYmd(S.day), wd = d.getDay(), isToday = S.day === today();
  let list = classesOn(S.day);
  const myCount = list.filter(c => c.coachUid === S.me.uid).length;
  if (S.mine && !A()) list = list.filter(c => c.coachUid === S.me.uid);
  let h = `<div class="daybar"><button class="round" data-act="wkPrev" aria-label="上一週">‹</button>
    <div class="d"><div class="big">${d.getMonth() + 1}/${d.getDate()}</div><div class="sub">星期${WD[wd]}${isToday ? ' · 今天' : ''}</div></div>
    <button class="round" data-act="wkNext" aria-label="下一週">›</button></div>${weekStrip()}`;
  if (!isToday) h += `<button class="btn ghost sm" data-act="dayToday" style="align-self:center">回到今天</button>`;
  if (!A()) h += seg('mine', S.mine ? '1' : '0', [['1', `我的課（${myCount}）`], ['0', '全部班級']]);
  if (!S.students.length && !S.classes.length) return `<div class="view">${h}${onboarding()}</div>`;
  if (!list.length) h += `<div class="empty"><b>${S.mine && !A() ? '你' : ''}星期${WD[wd]}沒有課</b>${A() ? `<button class="btn sm" data-act="newClass" data-wd="${wd}">新增班級或補課</button>` : ''}</div>`;
  else h += list.map(c => {
    const ss = sessionOf(c.id, S.day); const n = (c.studentIds || []).length;
    const p = ss && ss.status ? Object.values(ss.status).filter(x => x === 'present').length : 0;
    const pill = ss && ss.cancelled ? '<span class="pill bad">停課</span>' : ss ? `<span class="pill ok">已點名 <span class="num">${p}/${n}</span></span>` : `<span class="pill info"><span class="num">${n}</span> 人 · 點名</span>`;
    return `<button class="cls ${ss && !ss.cancelled ? 'done' : ''}${ss && ss.cancelled ? ' off' : ''}" data-act="attend" data-id="${c.id}">
      <div class="time">${esc(c.start)}<small>${esc(endTime(c.start, c.duration))}</small></div>
      <div style="min-width:0"><div class="name">${esc(c.name)}${c.date ? ' <span class="pill warn">單次</span>' : ''}</div><div class="meta">${esc([userName(c.coachUid), c.location].filter(Boolean).join(' · '))}</div></div>
      <div>${pill}</div></button>`;
  }).join('');
  const trials = S.leads.filter(l => l.trialDate === S.day && leadOpen(l));
  if (trials.length) h += `<div class="sec-h"><h3>今天的體驗課</h3><span class="sub">${trials.length} 位</span></div>
    <div class="list">${trials.map(l => `<div class="item"><div class="grow"><div class="t">${esc(l.name)} ${l.trialTime ? `<span class="num">${esc(l.trialTime)}</span>` : ''}</div><div class="s">${esc([l.parent, l.phone, l.source].filter(Boolean).join(' · '))}</div></div>
      <button class="btn sm" data-act="leadWon" data-id="${l.id}">報名了</button><button class="btn ghost sm" data-act="lead" data-id="${l.id}">詳細</button></div>`).join('')}</div>`;
  const act = S.students.filter(s => !s.archived);
  const low = act.filter(s => { const pe = periodEnd(s); if (pe && pe >= today()) return false; const l = lessonsOf(s.id); return l.bought > 0 && l.left <= 2; });
  const exp = act.filter(s => { const pe = periodEnd(s); return pe && pe >= today() && daysBetween(today(), pe) <= 7; });
  if (low.length || exp.length) h += `<div class="sec-h"><h3>該續約了</h3><span class="sub">${low.length + exp.length} 位，記得通知家長</span></div>
    <div class="list">${[...exp, ...low.sort((a, b) => lessonsOf(a.id).left - lessonsOf(b.id).left)].slice(0, 10).map(stuItem).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}

/* ---------- 課表 ---------- */
function vWeek() {
  let h = `<div class="row"><h2 class="vt grow">每週課表</h2>${A() ? '<button class="btn acc sm" data-act="newClass">＋ 班級 / 補課</button>' : ''}</div>`;
  const weekly = S.classes.filter(c => !c.date);
  const oneoff = S.classes.filter(c => c.date && c.date >= today()).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!S.classes.length) return `<div class="view">${h}<div class="empty"><b>還沒有班級</b>${A() ? '<span>每週固定的班級會自動出現在「今日」；單次的補課或加課也可以在這裡建立。</span><button class="btn" data-act="newClass">建立第一個班級</button>' : '<span>等管理員建立班級。</span>'}</div></div>`;
  const item = c => `<button class="item" data-act="${A() ? 'editClass' : 'viewClass'}" data-id="${c.id}">
      <span class="num" style="font-size:19px;font-weight:700;width:52px">${esc(c.start)}</span>
      <div class="grow"><div class="t">${esc(c.name)} ${c.level ? `<span class="pill info">${esc(c.level)}</span>` : ''}${c.coachUid === S.me.uid ? ' <span class="pill ok">我的</span>' : ''}</div><div class="s">${esc([c.date ? c.date.slice(5).replace('-', '/') + ' 週' + WD[parseYmd(c.date).getDay()] : '', userName(c.coachUid) || '未指定教練', c.location, (c.studentIds || []).length + ' 位學員'].filter(Boolean).join(' · '))}</div></div><span class="chev">›</span></button>`;
  for (const wd of [1, 2, 3, 4, 5, 6, 0]) {
    const list = weekly.filter(c => +c.weekday === wd).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    if (list.length) h += `<div class="wd">星期${WD[wd]}</div><div class="list">${list.map(item).join('')}</div>`;
  }
  if (oneoff.length) h += `<div class="sec-h"><h3>單次課程（補課、加課）</h3><span class="sub">${oneoff.length} 堂</span></div><div class="list">${oneoff.map(item).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}

/* ---------- 學員 ---------- */
function stuItem(s) {
  const cls = S.classes.filter(c => !c.date && (c.studentIds || []).includes(s.id)).map(c => c.name).join('、');
  const la = lastAttend(s.id); const idle = la ? daysBetween(la, today()) : null;
  const st = stuState(s);
  const flags = (s.tags || []).map(t => `<span class="pill tag">${esc(t)}</span>`).join('') +
    (st === 'renew' ? '<span class="pill warn">待續約</span>' : '') + (st === 'archived' ? '<span class="pill">封存</span>' : '') +
    (idle != null && idle > 21 && st !== 'archived' ? `<span class="pill bad">${idle} 天沒來</span>` : '');
  return `<button class="item" data-act="student" data-id="${s.id}"><div class="grow"><div class="t">${esc(s.name)} ${s.level ? `<span class="pill info">${esc(s.level)}</span>` : ''}${flags}</div>
  <div class="s">${esc(cls || '尚未加入班級')}${s.parent ? ' · ' + esc(s.parent) : ''}</div></div>${leftPill(s.id)}</button>`;
}
function vStudents() {
  let h = seg('stuTab', S.stuTab, [['students', `學員（${S.students.filter(s => !s.archived).length}）`], ['leads', `招生名單（${S.leads.filter(leadOpen).length}）`]]);
  return `<div class="view">${h}${S.stuTab === 'leads' ? vLeads() : vStuList()}</div>`;
}
function vStuList() {
  let h = `<div class="row"><h2 class="vt grow">學員</h2>${A() ? '<button class="btn acc sm" data-act="newStudent">＋ 學員</button>' : ''}</div>`;
  if (!S.students.length) return h + onboarding();
  const cnt = k => S.students.filter(s => stuState(s) === k).length;
  h += chips('stFilter', S.stFilter, [['active', `在檔 ${cnt('active') + cnt('renew')}`], ['renew', `待續約 ${cnt('renew')}`], ['archived', `封存 ${cnt('archived')}`]]);
  const tags = allTags();
  if (tags.length) h += chips('tag', S.tag, [['', '全部標籤'], ...tags.map(t => [t, t])]);
  h += `<input class="search" id="q" type="search" placeholder="搜尋姓名、家長、電話" value="${esc(S.q)}">`;
  const q = S.q.trim().toLowerCase();
  const list = S.students.filter(s => {
    const st = stuState(s);
    if (S.stFilter === 'active' && st === 'archived') return false;
    if (S.stFilter === 'renew' && st !== 'renew') return false;
    if (S.stFilter === 'archived' && st !== 'archived') return false;
    if (S.tag && !(s.tags || []).includes(S.tag)) return false;
    return !q || [s.name, s.parent, s.phone].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => lessonsOf(a.id).left - lessonsOf(b.id).left || (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  h += list.length ? `<div class="list">${list.map(stuItem).join('')}</div>` : `<div class="empty">沒有符合的學員</div>`;
  return h;
}

/* ---------- 招生名單 ---------- */
function vLeads() {
  const all = S.leads, won = all.filter(l => l.status === 'won').length, closed = all.filter(l => !leadOpen(l)).length;
  const m = today().slice(0, 7), newM = all.filter(l => (l.createdDate || '').startsWith(m)).length;
  let h = `<div class="row"><h2 class="vt grow">招生名單</h2><button class="btn acc sm" data-act="newLead">＋ 名單</button></div>`;
  if (!all.length) return h + `<div class="empty"><b>還沒有名單</b><span>有人來詢問、看到你們練習留下電話、或報名體驗課，都可以記在這裡。追蹤到報名後，一鍵轉成正式學員。</span><button class="btn" data-act="newLead">新增第一筆名單</button></div>`;
  h += `<div class="stats"><div class="stat"><div class="k">追蹤中</div><div class="v">${all.length - closed}<small>位</small></div></div>
    <div class="stat"><div class="k">成交率</div><div class="v">${closed ? Math.round(won / closed * 100) : 0}<small>%</small></div></div>
    <div class="stat"><div class="k">本月新名單</div><div class="v">${newM}<small>位</small></div></div></div>`;
  const src = {};
  for (const l of all) { const k = l.source || '其他'; src[k] = src[k] || { n: 0, w: 0, c: 0 }; src[k].n++; if (l.status === 'won') src[k].w++; if (!leadOpen(l)) src[k].c++; }
  h += `<div class="card"><div class="sub" style="margin-bottom:6px">各來源成交率（已有結果的名單）</div>${Object.entries(src).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => {
    const r = v.c ? Math.round(v.w / v.c * 100) : 0;
    return `<div class="hbar"><span class="hbar-l">${esc(k)}</span><span class="hbar-t"><i style="width:${r}%"></i></span><span class="hbar-v num">${v.c ? r + '%' : '—'} <small>${v.w}/${v.c}</small></span></div>`;
  }).join('')}</div>`;
  h += chips('leadFilter', S.leadFilter, [['open', '追蹤中'], ['won', '已報名'], ['lost', '沒報名'], ['all', '全部']]);
  const list = all.filter(l => S.leadFilter === 'all' || (S.leadFilter === 'open' ? leadOpen(l) : l.status === S.leadFilter))
    .sort((a, b) => (a.trialDate || '9') .localeCompare(b.trialDate || '9') || (b.createdAt || 0) - (a.createdAt || 0));
  h += list.length ? `<div class="list">${list.map(l => { const [t, k] = LEAD_ST[l.status || 'new']; return `<button class="item" data-act="lead" data-id="${l.id}"><div class="grow"><div class="t">${esc(l.name)} <span class="pill ${k}">${t}</span></div>
    <div class="s">${esc([l.source, l.trialDate ? '體驗 ' + l.trialDate.slice(5).replace('-', '/') + (l.trialTime ? ' ' + l.trialTime : '') : '', l.note].filter(Boolean).join(' · '))}</div></div><span class="chev">›</span></button>`; }).join('')}</div>` : '<div class="empty">沒有符合的名單</div>';
  return h;
}
function leadForm(l) {
  l = l || { status: 'new', source: LEAD_SRC[0] };
  openSheet(l.id ? l.name : '新增名單', `<form class="form" id="f">
    <div class="two"><div class="field"><label for="l-name">小朋友姓名</label><input id="l-name" name="name" required value="${esc(l.name)}" placeholder="陳小翔"></div>
    <div class="field"><label for="l-birth">出生年</label><input id="l-birth" name="birth" inputmode="numeric" value="${esc(l.birth)}" placeholder="2018"></div></div>
    <div class="two"><div class="field"><label for="l-parent">家長</label><input id="l-parent" name="parent" value="${esc(l.parent)}" placeholder="陳爸爸"></div>
    <div class="field"><label for="l-phone">電話 / LINE</label><input id="l-phone" name="phone" value="${esc(l.phone)}"></div></div>
    <div class="two"><div class="field"><label for="l-src">從哪裡知道我們</label><select id="l-src" name="source">${opts(LEAD_SRC, l.source)}</select></div>
    <div class="field"><label for="l-st">目前狀態</label><select id="l-st" name="status">${Object.entries(LEAD_ST).map(([v, [t]]) => `<option value="${v}" ${(l.status || 'new') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div></div>
    <div class="two"><div class="field"><label for="l-td">體驗課日期</label><input id="l-td" name="trialDate" type="date" value="${esc(l.trialDate)}"></div>
    <div class="field"><label for="l-tt">時間</label><input id="l-tt" name="trialTime" type="time" value="${esc(l.trialTime)}"></div></div>
    <div class="field"><label for="l-note">備註</label><textarea id="l-note" name="note" placeholder="想上週六班、怕摔、哥哥已經在上…">${esc(l.note)}</textarea></div>
    <button class="btn" type="submit">${l.id ? '儲存' : '新增名單'}</button>
    ${l.id && A() && l.status !== 'won' ? `<button class="btn acc" type="button" data-act="convertLead" data-id="${l.id}">轉成正式學員</button>` : ''}
    ${l.studentId && stuById(l.studentId) ? `<button class="btn ghost" type="button" data-act="student" data-id="${l.studentId}">查看學員資料</button>` : ''}
    ${l.id && A() ? delBlock('leads', l.id, '這筆名單') : ''}</form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); fd.name = fd.name.trim(); if (!fd.name) return;
      if (fd.trialDate && fd.status === 'new') fd.status = 'trial';
      const d = { ...l, ...fd, createdAt: l.createdAt || Date.now(), createdDate: l.createdDate || today(), by: l.by || S.me.uid };
      if (fd.status !== l.status && !leadOpen(fd)) d.closedDate = today();
      delete d.id;
      if (await save('leads', l.id, d)) { toast(l.id ? '已儲存' : '已新增 ' + fd.name); closeSheet(); }
    };
  });
}
async function convertLead(id) {
  const l = S.leads.find(x => x.id === id); if (!l) return;
  const sid = newId();
  try {
    const b = writeBatch(fs);
    b.set(doc(fs, 'students', sid), { name: l.name, parent: l.parent || '', phone: l.phone || '', birth: l.birth || '', note: l.note || '', source: l.source || '', joined: today(), bought: 0, createdAt: Date.now() });
    b.update(doc(fs, 'leads', id), { status: 'won', studentId: sid, closedDate: today() });
    await b.commit(); toast(l.name + ' 已轉成正式學員'); closeSheet();
    setTimeout(() => { S.tab = 'students'; S.stuTab = 'students'; renderTabs(); render(); studentForm(stuById(sid) || { id: sid, name: l.name }); }, 400);
  } catch (e) { toast(fbErr(e)); }
}

/* ---------- 收費 ---------- */
function monthBar() {
  const [y, mm] = S.month.split('-').map(Number);
  return `<div class="daybar"><button class="round" data-act="mPrev" aria-label="上個月">‹</button><div class="d"><div class="big">${y} / ${mm}</div><div class="sub">月份</div></div><button class="round" data-act="mNext" aria-label="下個月">›</button></div>`;
}
const payDesc = p => p.type === 'period' ? `${(p.start || '').slice(5).replace('-', '/')}–${(p.end || '').slice(5).replace('-', '/')}` : `${+p.lessons || 0} 堂`;
function vPay() {
  const list = S.payments.filter(p => (p.date || '').startsWith(S.month)).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = list.reduce((a, p) => a + (+p.amount || 0), 0), lessons = list.reduce((a, p) => a + (p.type === 'period' ? 0 : +p.lessons || 0), 0);
  let h = `<div class="row"><h2 class="vt grow">收費紀錄</h2><button class="btn acc sm" data-act="newPay" ${S.students.length ? '' : 'disabled'}>＋ 收費</button></div>${monthBar()}
  <div class="stats"><div class="stat"><div class="k">本月收入</div><div class="v">${Math.round(total / 100) / 10}<small>千</small></div></div>
  <div class="stat"><div class="k">售出堂數</div><div class="v">${lessons}<small>堂</small></div></div>
  <div class="stat"><div class="k">筆數</div><div class="v">${list.length}<small>筆</small></div></div></div>`;
  if (!S.students.length) h += `<div class="empty"><b>先新增學員</b><span>收費要記在學員名下，堂數才會跟著點名扣。</span><button class="btn" data-act="newStudent">新增學員</button></div>`;
  else if (!list.length) h += `<div class="empty"><b>這個月還沒有收費紀錄</b><span>學員繳費時按「＋ 收費」，可以登記堂數制或月費制。</span></div>`;
  else h += `<div class="list">${list.map(p => { const s = stuById(p.studentId); return `<button class="item" data-act="editPay" data-id="${p.id}">
    <div class="grow"><div class="t">${esc(s ? s.name : '（已刪除學員）')}</div><div class="s">${esc(p.date)} · ${esc(p.plan || '課程')} · ${esc(payDesc(p))}${p.method ? ' · ' + esc(p.method) : ''}</div></div>
    <span class="money">${money(p.amount)}</span></button>`; }).join('')}</div>`;
  return `<div class="view">${h}</div>`;
}

/* ---------- 我的（教練） ---------- */
function monthSessions(uid) { return S.sessions.filter(s => !s.cancelled && (s.date || '').startsWith(S.month) && (!uid || s.coachUid === uid)); }
function attStats(ses) { let p = 0, l = 0, a = 0; for (const s of ses) for (const v of Object.values(s.status || {})) { if (v === 'present') p++; else if (v === 'leave') l++; else if (v === 'absent') a++; } return { p, l, a, t: p + l + a }; }
function vMine() {
  const ses = monthSessions(S.me.uid); const st = attStats(ses);
  return `<div class="view"><h2 class="vt">${esc(S.profile.name)} <span class="pill info role">教練</span></h2>${monthBar()}
  <div class="stats"><div class="stat"><div class="k">本月上課</div><div class="v">${ses.length}<small>堂</small></div></div>
  <div class="stat"><div class="k">帶過人次</div><div class="v">${st.p}</div></div>
  <div class="stat"><div class="k">出席率</div><div class="v">${st.t ? Math.round(st.p / st.t * 100) : 0}<small>%</small></div></div></div>
  <div class="sec-h"><h3>本月點名紀錄</h3></div>
  ${ses.length ? `<div class="list">${ses.sort((a, b) => b.date.localeCompare(a.date)).map(s => { const c = clsById(s.classId); const x = attStats([s]); return `<div class="item"><div class="grow"><div class="t">${esc(s.date)} · ${esc(c ? c.name : '（已刪除班級）')}</div><div class="s">出席 ${x.p} · 請假 ${x.l} · 缺席 ${x.a}</div></div></div>`; }).join('')}</div>` : '<div class="empty">這個月還沒有點名紀錄。</div>'}
  <div class="card row wrap"><div class="grow sub">${esc(S.me.email)}</div><button class="btn ghost sm" data-act="logout">登出</button></div></div>`;
}

/* ---------- 分析（管理員） ---------- */
function vAdmin() {
  const pend = S.users.filter(u => u.role === 'pending');
  let h = seg('moreTab', S.moreTab, [['stats', '分析報表'], ['manage', `管理${pend.length ? `（${pend.length}）` : ''}`]]);
  return `<div class="view">${h}${S.moreTab === 'manage' ? vManage() : vStats()}</div>`;
}
function vStats() {
  const y = String(S.year);
  const ses = S.sessions.filter(s => !s.cancelled && (s.date || '').startsWith(y));
  const pays = S.payments.filter(p => (p.date || '').startsWith(y));
  const income = pays.reduce((a, p) => a + (+p.amount || 0), 0);
  const active = S.students.filter(s => stuState(s) !== 'archived');
  const lessonPays = S.payments.filter(p => p.type !== 'period' && +p.lessons);
  const avgBuy = lessonPays.length ? Math.round(lessonPays.reduce((a, p) => a + (+p.lessons || 0), 0) / lessonPays.length) : 0;
  const payCnt = {}; for (const p of S.payments) payCnt[p.studentId] = (payCnt[p.studentId] || 0) + 1;
  const buyers = Object.values(payCnt), renewRate = buyers.length ? Math.round(buyers.filter(n => n >= 2).length / buyers.length * 100) : 0;
  let h = `<div class="daybar"><button class="round" data-act="yPrev" aria-label="前一年">‹</button><div class="d"><div class="big">${y}</div><div class="sub">年度</div></div><button class="round" data-act="yNext" aria-label="下一年">›</button></div>
  <div class="stats four"><div class="stat"><div class="k">在檔學員</div><div class="v">${active.length}<small>位</small></div></div>
  <div class="stat"><div class="k">${y} 收入</div><div class="v">${Math.round(income / 1000)}<small>千</small></div></div>
  <div class="stat"><div class="k">平均購買</div><div class="v">${avgBuy}<small>堂</small></div></div>
  <div class="stat"><div class="k">續約率</div><div class="v">${renewRate}<small>%</small></div></div></div>`;
  // 每月
  const mons = Array.from({ length: 12 }, (_, i) => { const k = y + '-' + pad(i + 1); return { m: i + 1, n: ses.filter(s => s.date.startsWith(k)).length, $: pays.filter(p => p.date.startsWith(k)).reduce((a, p) => a + (+p.amount || 0), 0) }; });
  const maxN = Math.max(1, ...mons.map(x => x.n)), max$ = Math.max(1, ...mons.map(x => x.$));
  const busiest = mons.reduce((a, b) => b.n > a.n ? b : a, mons[0]), worked = mons.filter(x => x.n);
  h += `<div class="sec-h"><h3>每月開課與收入</h3><span class="sub">${worked.length ? `最忙 ${busiest.m} 月 · 平均每月 ${Math.round(worked.reduce((a, x) => a + x.n, 0) / worked.length)} 堂` : '這一年還沒有資料'}</span></div>
  <div class="card"><div class="mbars" role="img" aria-label="${y} 年每月開課堂數與收入">${mons.map(x => `<div class="mb"><div class="mb-col"><i class="b1" style="height:${x.n / maxN * 100}%"></i><i class="b2" style="height:${x.$ / max$ * 100}%"></i></div><span class="mb-v num">${x.n || ''}</span><span class="mb-m">${x.m}月</span></div>`).join('')}</div>
  <div class="legend"><span><i class="b1"></i>開課堂數</span><span><i class="b2"></i>收入</span></div></div>`;
  // 排行榜
  const att = {}, tot = {}, spent = {};
  for (const s of ses) for (const [sid, v] of Object.entries(s.status || {})) { tot[sid] = (tot[sid] || 0) + 1; if (v === 'present') att[sid] = (att[sid] || 0) + 1; }
  for (const p of pays) spent[p.studentId] = (spent[p.studentId] || 0) + (+p.amount || 0);
  const nm = id => { const s = stuById(id); return s ? s.name : '（已刪除）'; };
  const rank = (obj, fmt, filter) => { const e = Object.entries(obj).filter(filter || (() => true)).sort((a, b) => b[1] - a[1]).slice(0, 5); return e.length ? `<ol class="rank">${e.map(([id, v], i) => `<li><span class="rk num">${i + 1}</span><span class="grow">${esc(nm(id))}</span><span class="num">${fmt(v, id)}</span></li>`).join('')}</ol>` : '<div class="sub">還沒有資料</div>'; };
  const rate = {}; for (const id in tot) if (tot[id] >= 4) rate[id] = (att[id] || 0) / tot[id];
  h += `<div class="sec-h"><h3>${y} 排行榜</h3></div><div class="grid2">
    <div class="card"><div class="sub">上課最多</div>${rank(att, v => v + ' 堂')}</div>
    <div class="card"><div class="sub">出席率最高（至少 4 堂）</div>${rank(rate, v => Math.round(v * 100) + '%')}</div>
    <div class="card"><div class="sub">消費最多</div>${rank(spent, v => money(v))}</div></div>`;
  // 客群
  const ages = { '6 歲以下': 0, '7–9 歲': 0, '10–12 歲': 0, '13–15 歲': 0, '16 歲以上': 0, '未填': 0 }, nowY = new Date().getFullYear();
  for (const s of active) { const b = +s.birth; if (!b || b < 1900) { ages['未填']++; continue; } const a = nowY - b; ages[a <= 6 ? '6 歲以下' : a <= 9 ? '7–9 歲' : a <= 12 ? '10–12 歲' : a <= 15 ? '13–15 歲' : '16 歲以上']++; }
  const lv = {}; for (const s of active) { const k = s.level || '未填'; lv[k] = (lv[k] || 0) + 1; }
  const dist = (o) => { const t = Object.values(o).reduce((a, b) => a + b, 0) || 1; return Object.entries(o).filter(([, v]) => v).map(([k, v]) => `<div class="hbar"><span class="hbar-l">${esc(k)}</span><span class="hbar-t"><i style="width:${v / t * 100}%"></i></span><span class="hbar-v num">${v} <small>${Math.round(v / t * 100)}%</small></span></div>`).join('') || '<div class="sub">還沒有資料</div>'; };
  h += `<div class="sec-h"><h3>學員組成</h3><span class="sub">在檔 ${active.length} 位</span></div><div class="grid2">
    <div class="card"><div class="sub" style="margin-bottom:6px">年齡（依出生年）</div>${dist(ages)}</div>
    <div class="card"><div class="sub" style="margin-bottom:6px">程度</div>${dist(lv)}</div></div>`;
  return h;
}
function vManage() {
  const ses = monthSessions(); const st = attStats(ses);
  const by = {}; for (const s of ses) { const k = s.coachUid || ''; by[k] = by[k] || { n: 0, p: 0 }; by[k].n++; by[k].p += attStats([s]).p; }
  const pend = S.users.filter(u => u.role === 'pending');
  let h = '';
  if (pend.length) h += `<div class="banner">有 ${pend.length} 位教練等待開通：${esc(pend.map(u => u.name || u.email).join('、'))}</div>`;
  h += monthBar() + `<div class="stats"><div class="stat"><div class="k">開課堂數</div><div class="v">${ses.length}</div></div>
  <div class="stat"><div class="k">出席率</div><div class="v">${st.t ? Math.round(st.p / st.t * 100) : 0}<small>%</small></div></div>
  <div class="stat"><div class="k">請假 / 缺席</div><div class="v">${st.l}<small>/</small>${st.a}</div></div></div>
  <div class="sec-h"><h3>教練鐘點試算</h3><span class="sub">點名堂數 × 每堂鐘點費</span></div>`;
  const ks = Object.keys(by);
  h += ks.length ? `<div class="list">${ks.map(k => { const r = +S.rates[k] || 0; return `<div class="item"><div class="grow"><div class="t">${esc(userName(k) || '未指定')}</div><div class="s">${by[k].n} 堂 · ${by[k].p} 人次 · 每堂 ${r ? money(r) : '未設定'}</div></div><span class="money">${r ? money(r * by[k].n) : '—'}</span></div>`; }).join('')}</div>` : '<div class="empty">這個月還沒有點名紀錄。</div>';
  h += `<div class="sec-h"><h3>教練帳號</h3><span class="sub">請教練用網址自行登入</span></div>
  <div class="list">${[...S.users].sort((a, b) => (a.role === 'pending' ? -1 : 0) - (b.role === 'pending' ? -1 : 0)).map(u => {
    const lbl = { admin: ['管理員', 'ok'], coach: ['教練', 'info'], pending: ['等待開通', 'warn'], disabled: ['已停用', 'bad'] }[u.role] || ['?', 'info'];
    return `<button class="item" data-act="member" data-id="${u.id}"><div class="grow"><div class="t">${esc(u.name || u.email)}${u.id === S.me.uid ? '（你）' : ''}</div><div class="s">${esc(u.email)}${S.rates[u.id] ? ' · 每堂 ' + money(S.rates[u.id]) : ''}</div></div><span class="pill ${lbl[1]}">${lbl[0]}</span></button>`;
  }).join('')}</div>
  <div class="sec-h"><h3>設定</h3></div>
  <div class="list"><button class="item" data-act="settings"><div class="grow"><div class="t">上課場地與扣堂規則</div><div class="s">${esc((S.settings.locations || []).join('、') || '尚未設定場地')} · 未請假缺席${S.settings.absentDeducts ? '扣堂' : '不扣堂'}</div></div><span class="chev">›</span></button></div>
  <div class="card row wrap"><div class="grow sub">匯出所有資料成 JSON 檔備份。</div><button class="btn ghost sm" data-act="backup">匯出備份</button></div>
  <div class="card row wrap"><div class="grow sub">${esc(S.me.email)} · 管理員</div><button class="btn ghost sm" data-act="logout">登出</button></div>`;
  return h;
}

/* ---------- 底部視窗 ---------- */
function openSheet(title, body, onReady) {
  $('#layer').innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
  <div class="sheet-h"><h3>${esc(title)}</h3><button class="btn ghost sm" data-act="close">關閉</button></div>${body}</div></div>`;
  document.body.style.overflow = 'hidden';
  onReady && onReady($('#layer .sheet'));
}
function closeSheet() { $('#layer').innerHTML = ''; document.body.style.overflow = ''; }
$('#layer').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });
const opts = (arr, sel) => arr.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
const dataList = (id, arr) => `<datalist id="${id}">${arr.map(v => `<option value="${esc(v)}"></option>`).join('')}</datalist>`;
const delBlock = (kind, id, label) => `<div><button type="button" class="btn danger" data-act="askDel">刪除${label}</button>
  <div class="confirm" id="delconf" hidden>確定刪除？無法復原。<span class="grow"></span><button type="button" class="btn ghost sm" data-act="cancelDel">取消</button><button type="button" class="btn sm" style="background:var(--bad)" data-act="doDel" data-kind="${kind}" data-id="${id}">刪除</button></div></div>`;

async function save(col, id, data) {
  try { await setDoc(doc(fs, col, id || newId()), data); return true; }
  catch (e) { toast(fbErr(e)); return false; }
}
async function del(col, id) {
  try {
    if (col === 'students') {
      const b = writeBatch(fs);
      for (const c of S.classes.filter(c => (c.studentIds || []).includes(id))) b.update(doc(fs, 'classes', c.id), { studentIds: c.studentIds.filter(x => x !== id) });
      b.delete(doc(fs, 'students', id)); await b.commit();
    } else if (col === 'payments') {
      const p = S.payments.find(x => x.id === id);
      await deleteDoc(doc(fs, 'payments', id));
      if (p) await syncBought(p.studentId, id, null);
    } else await deleteDoc(doc(fs, col, id));
    return true;
  } catch (e) { toast(fbErr(e)); return false; }
}
// 學員的「已購堂數、月費期間、繳費次數」存在學員資料上，教練看不到金額也能算剩餘堂數
async function syncBought(sid, changedId, changed) {
  if (!sid || !stuById(sid)) return;
  const list = S.payments.filter(p => p.studentId === sid && p.id !== changedId);
  if (changed) list.push(changed);
  const bought = list.filter(p => p.type !== 'period').reduce((a, p) => a + (+p.lessons || 0), 0);
  const periods = list.filter(p => p.type === 'period' && p.start && p.end).map(p => ({ start: p.start, end: p.end })).sort((a, b) => a.start.localeCompare(b.start));
  await updateDoc(doc(fs, 'students', sid), { bought, periods, payCount: list.length, renew: false });
}

function studentForm(s) {
  s = s || {};
  openSheet(s.id ? '編輯學員' : '新增學員', `<form class="form" id="f">
    <div class="field"><label for="f-name">學員姓名</label><input id="f-name" name="name" required value="${esc(s.name)}" placeholder="王小鷹"></div>
    <div class="two"><div class="field"><label for="f-level">程度</label><select id="f-level" name="level"><option value="">—</option>${opts(LEVELS, s.level)}</select></div>
    <div class="field"><label for="f-birth">出生年</label><input id="f-birth" name="birth" inputmode="numeric" value="${esc(s.birth)}" placeholder="2017"></div></div>
    <div class="two"><div class="field"><label for="f-parent">家長</label><input id="f-parent" name="parent" value="${esc(s.parent)}" placeholder="王媽媽"></div>
    <div class="field"><label for="f-phone">電話 / LINE</label><input id="f-phone" name="phone" value="${esc(s.phone)}" placeholder="0912-345-678"></div></div>
    <div class="field"><label for="f-tags">標籤（用逗號分隔）</label><input id="f-tags" name="tags" list="dl-tags" value="${esc((s.tags || []).join(', '))}" placeholder="兄弟姊妹, 比賽組, 學校社團">${dataList('dl-tags', allTags())}</div>
    <div class="two"><div class="field"><label for="f-shoe">鞋號</label><input id="f-shoe" name="shoe" value="${esc(s.shoe)}" placeholder="32"></div>
    <div class="field"><label for="f-joined">入學日</label><input id="f-joined" name="joined" type="date" value="${esc(s.joined || today())}"></div></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note" name="note" placeholder="過敏、護具、學習狀況…">${esc(s.note)}</textarea></div>
    <button class="btn" type="submit">${s.id && stuById(s.id) ? '儲存' : '新增學員'}</button>
    ${s.id && stuById(s.id) ? delBlock('students', s.id, '學員') : ''}</form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); fd.name = fd.name.trim(); if (!fd.name) return;
      fd.tags = fd.tags.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      const id = s.id || newId(); const cur = stuById(id) || {};
      const d = { ...cur, ...fd, bought: +cur.bought || 0, createdAt: cur.createdAt || Date.now() }; delete d.id;
      if (await save('students', id, d)) { toast(cur.name ? '已儲存' : '已新增 ' + fd.name); cur.name ? openStudent(id) : closeSheet(); }
    };
  });
}
function openStudent(id) {
  const s = stuById(id); if (!s) return closeSheet();
  const L = lessonsOf(id), pe = periodEnd(s), st = stuState(s);
  const pays = A() ? S.payments.filter(p => p.studentId === id).sort((a, b) => (b.date || '').localeCompare(a.date || '')) : [];
  const spent = pays.reduce((a, p) => a + (+p.amount || 0), 0);
  const hist = S.sessions.filter(ss => ss.status && ss.status[id]).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  const cls = S.classes.filter(c => !c.date && (c.studentIds || []).includes(id));
  const lbl = { present: ['出席', 'ok'], leave: ['請假', 'warn'], absent: ['缺席', 'bad'] };
  const col = L.bought && L.left <= 0 ? 'bad' : L.bought && L.left <= 2 ? 'warn' : 'fg';
  const levels = (s.levels || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const periodOn = pe && pe >= today();
  openSheet(s.name, `
    <div class="card row"><div class="grow">${periodOn ? `<div class="sub">月費期間</div><div class="big-left"><span class="v" style="font-size:30px">到 ${pe.slice(5).replace('-', '/')}</span><span class="sub">還有 ${daysBetween(today(), pe)} 天</span></div>` : `<div class="sub">剩餘堂數</div><div class="big-left"><span class="v" style="color:var(--${col})">${L.left}</span><span class="sub">堂（買 ${L.bought}、用 ${L.used}）</span></div>`}</div>
    ${A() ? `<button class="btn acc" data-act="renew" data-sid="${id}">續約</button>` : ''}</div>
    <div class="stats four"><div class="stat"><div class="k">已上</div><div class="v">${L.attended}<small>堂</small></div></div>
    <div class="stat"><div class="k">出席率</div><div class="v">${L.total ? Math.round(L.attended / L.total * 100) : 0}<small>%</small></div></div>
    <div class="stat"><div class="k">續約</div><div class="v">${Math.max(0, (+s.payCount || 0) - 1)}<small>次</small></div></div>
    ${A() ? `<div class="stat"><div class="k">累計消費</div><div class="v">${Math.round(spent / 100) / 10}<small>千</small></div></div>` : `<div class="stat"><div class="k">程度</div><div class="v" style="font-size:20px">${esc(s.level || '—')}</div></div>`}</div>
    ${A() ? `<div class="row wrap"><button class="btn ghost sm" data-act="levelUp" data-sid="${id}">＋ 晉級 / 檢定</button>
      <button class="btn ghost sm" data-act="toggleRenew" data-sid="${id}">${s.renew ? '取消待續約' : '標為待續約'}</button>
      <button class="btn ghost sm" data-act="toggleArchive" data-sid="${id}">${s.archived ? '恢復在檔' : '封存（不再上課）'}</button></div>` : ''}
    <div class="card"><dl class="kv">
      <dt>狀態</dt><dd>${{ active: '在檔', renew: '待續約', archived: '封存' }[st]}</dd>
      <dt>程度</dt><dd>${esc(s.level || '—')}</dd><dt>班級</dt><dd>${esc(cls.map(c => c.name + '（週' + WD[c.weekday] + ' ' + c.start + '）').join('、') || '尚未加入')}</dd>
      ${(s.tags || []).length ? `<dt>標籤</dt><dd>${s.tags.map(t => `<span class="pill tag">${esc(t)}</span>`).join(' ')}</dd>` : ''}
      <dt>家長</dt><dd>${esc(s.parent || '—')}</dd><dt>聯絡</dt><dd>${s.phone ? `<a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a>` : '—'}</dd>
      ${s.birth ? `<dt>出生年</dt><dd>${esc(s.birth)}（${new Date().getFullYear() - +s.birth} 歲）</dd>` : ''}${s.shoe ? `<dt>鞋號</dt><dd>${esc(s.shoe)}</dd>` : ''}
      ${s.joined ? `<dt>入學</dt><dd>${esc(s.joined)}</dd>` : ''}${s.source ? `<dt>來源</dt><dd>${esc(s.source)}</dd>` : ''}${s.note ? `<dt>備註</dt><dd>${esc(s.note)}</dd>` : ''}
    </dl></div>
    ${levels.length ? `<div class="sec-h"><h3>晉級 / 檢定紀錄</h3></div><div class="list">${levels.map((v, i) => `<div class="item"><div class="grow"><div class="t">${esc(v.level)}</div><div class="s">${esc(v.date)}${v.note ? ' · ' + esc(v.note) : ''}</div></div>${A() ? `<button class="btn ghost sm" data-act="delLevel" data-sid="${id}" data-i="${(s.levels || []).indexOf(v)}">刪除</button>` : ''}</div>`).join('')}</div>` : ''}
    ${A() ? `<div class="sec-h"><h3>收費紀錄</h3></div>${pays.length ? `<div class="list">${pays.map(p => `<button class="item" data-act="editPay" data-id="${p.id}"><div class="grow"><div class="t">${esc(p.plan || '課程')} · ${esc(payDesc(p))}</div><div class="s">${esc(p.date)}${p.method ? ' · ' + esc(p.method) : ''}</div></div><span class="money">${money(p.amount)}</span></button>`).join('')}</div>` : '<div class="empty">還沒有收費紀錄</div>'}` : ''}
    <div class="sec-h"><h3>最近上課</h3></div>
    ${hist.length ? `<div class="list">${hist.map(ss => { const c = clsById(ss.classId); const [t, k] = ss.cancelled ? ['停課', 'info'] : (lbl[ss.status[id]] || ['?', 'info']); return `<div class="item"><div class="grow"><div class="t">${esc(ss.date)}${inPeriod(s, ss.date) ? ' <span class="pill tag">月費</span>' : ''}</div><div class="s">${esc(c ? c.name : '（已刪除班級）')}${ss.note ? ' · ' + esc(ss.note) : ''}</div></div><span class="pill ${k}">${t}</span></div>`; }).join('')}</div>` : '<div class="empty">還沒有點名紀錄</div>'}
    ${A() ? `<button class="btn ghost" data-act="editStudent" data-id="${id}">編輯學員資料</button>` : ''}`);
}
function levelForm(sid) {
  const s = stuById(sid); if (!s) return;
  const next = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(s.level) + 1)] || LEVELS[0];
  openSheet('晉級 / 檢定 · ' + s.name, `<form class="form" id="f">
    <div class="two"><div class="field"><label for="v-date">日期</label><input id="v-date" type="date" required value="${today()}"></div>
    <div class="field"><label for="v-level">新程度</label><select id="v-level">${opts(LEVELS, next)}</select></div></div>
    <div class="field"><label for="v-note">備註</label><input id="v-note" placeholder="通過協會初級檢定、學會交叉步…"></div>
    <button class="btn" type="submit">儲存紀錄</button></form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const rec = { date: $('#v-date', sh).value, level: $('#v-level', sh).value, note: $('#v-note', sh).value.trim() };
      try { await updateDoc(doc(fs, 'students', sid), { level: rec.level, levels: [...(s.levels || []), rec] }); toast(s.name + ' 晉級到 ' + rec.level); openStudent(sid); }
      catch (err) { toast(fbErr(err)); }
    };
  });
}
function coachOptions(sel) { return '<option value="">未指定</option>' + coaches().map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join(''); }
function classForm(c, wd) {
  c = c || { weekday: wd != null ? wd : new Date().getDay(), start: '18:00', duration: 60 };
  const once = !!c.date || c._once;
  const sel = new Set(c.studentIds || []);
  const studs = S.students.filter(s => !s.archived || sel.has(s.id)).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  openSheet(c.id ? '編輯班級' : '新增班級 / 補課', `<form class="form" id="f">
    ${c.id ? '' : seg('classKind', once ? 'once' : 'weekly', [['weekly', '每週固定班'], ['once', '單次（補課、加課）']])}
    <div class="field"><label for="c-name">名稱</label><input id="c-name" name="name" required value="${esc(c.name)}" placeholder="${once ? '颱風補課、比賽集訓' : '週六初級班'}"></div>
    <div class="two">${once ? `<div class="field"><label for="c-date">日期</label><input id="c-date" name="date" type="date" required value="${esc(c.date || S.day)}"></div>` : `<div class="field"><label for="c-wd">星期</label><select id="c-wd" name="weekday">${[1, 2, 3, 4, 5, 6, 0].map(i => `<option value="${i}" ${+c.weekday === i ? 'selected' : ''}>星期${WD[i]}</option>`).join('')}</select></div>`}
    <div class="field"><label for="c-level">程度</label><select id="c-level" name="level"><option value="">—</option>${opts(LEVELS, c.level)}</select></div></div>
    <div class="two"><div class="field"><label for="c-start">開始時間</label><input id="c-start" name="start" type="time" required value="${esc(c.start)}"></div>
    <div class="field"><label for="c-dur">每堂分鐘</label><input id="c-dur" name="duration" type="number" inputmode="numeric" min="15" step="15" value="${esc(c.duration)}"></div></div>
    <div class="two"><div class="field"><label for="c-coach">教練</label><select id="c-coach" name="coachUid">${coachOptions(c.coachUid)}</select></div>
    <div class="field"><label for="c-loc">場地</label><input id="c-loc" name="location" list="dl-loc" value="${esc(c.location)}" placeholder="板橋第一運動場">${dataList('dl-loc', S.settings.locations || [])}</div></div>
    <div class="field"><label>上課學員（已選 ${sel.size} 位）</label>
    ${studs.length ? `<div class="chk">${studs.map(s => `<label><input type="checkbox" name="sid" value="${s.id}" ${sel.has(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')}</div>` : '<div class="sub">先到「學員」新增學員，再回來勾選。</div>'}</div>
    <button class="btn" type="submit">${c.id ? '儲存' : once ? '建立單次課程' : '建立班級'}</button>
    ${c.id ? delBlock('classes', c.id, '班級') : ''}</form>`, sh => {
    sh.querySelectorAll('[data-act="classKind"]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const fd = new FormData($('#f', sh)); classForm({ ...c, name: fd.get('name'), level: fd.get('level'), start: fd.get('start'), duration: fd.get('duration'), coachUid: fd.get('coachUid'), location: fd.get('location'), studentIds: fd.getAll('sid'), _once: b.dataset.v === 'once' }, wd); });
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const d = { name: fd.get('name').trim(), level: fd.get('level'), start: fd.get('start'), duration: +fd.get('duration') || 60,
        coachUid: fd.get('coachUid'), location: fd.get('location').trim(), studentIds: fd.getAll('sid'), createdAt: c.createdAt || Date.now() };
      if (once) d.date = fd.get('date'); else d.weekday = +fd.get('weekday');
      if (!d.name) return;
      if (await save('classes', c.id, d)) {
        const locs = S.settings.locations || [];
        if (d.location && !locs.includes(d.location)) await setDoc(doc(fs, 'meta', 'settings'), { ...S.settings, locations: [...locs, d.location] }).catch(() => {});
        toast(c.id ? '已儲存' : '已建立 ' + d.name); closeSheet();
      }
    };
  });
}
function viewClass(cid) {
  const c = clsById(cid); if (!c) return;
  const studs = (c.studentIds || []).map(stuById).filter(Boolean);
  openSheet(c.name, `<div class="card"><dl class="kv"><dt>時間</dt><dd>${c.date ? esc(c.date) : '星期' + WD[c.weekday]} ${esc(c.start)}–${esc(endTime(c.start, c.duration))}</dd>
    <dt>教練</dt><dd>${esc(userName(c.coachUid) || '未指定')}</dd><dt>場地</dt><dd>${esc(c.location || '—')}</dd><dt>程度</dt><dd>${esc(c.level || '—')}</dd></dl></div>
    <div class="sec-h"><h3>學員 ${studs.length} 位</h3></div>
    ${studs.length ? `<div class="list">${studs.map(stuItem).join('')}</div>` : '<div class="empty">還沒有學員</div>'}`);
}
function addMonth(dateStr) { const d = parseYmd(dateStr); const x = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()); return ymd(addDays(x, -1)); }
function payForm(p, sid, opt = {}) {
  const s0 = stuById(sid || (p && p.studentId));
  if (!p) {
    const last = sid ? S.payments.filter(x => x.studentId === sid).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] : null;
    p = last && opt.renew ? { studentId: sid, type: last.type || 'lessons', plan: last.plan, lessons: last.lessons, amount: last.amount, method: last.method, date: today() }
      : { studentId: sid || '', type: 'lessons', date: today(), lessons: 8, plan: '8 堂課程', method: '現金' };
    if (p.type === 'period') { const pe = periodEnd(s0); p.start = pe && pe >= today() ? ymd(addDays(parseYmd(pe), 1)) : today(); p.end = addMonth(p.start); }
  }
  const type = opt.type || p.type || 'lessons';
  const studs = S.students.filter(s => !s.archived || s.id === p.studentId).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-Hant'));
  const start = p.start || today(), end = p.end || addMonth(start);
  openSheet(p.id ? '編輯收費' : opt.renew ? '續約 · ' + (s0 ? s0.name : '') : '登記收費', `<form class="form" id="f">
    ${opt.renew && s0 ? `<div class="banner" style="background:var(--info-bg);color:var(--fg)">${type === 'period' ? `目前月費到 ${esc(periodEnd(s0) || '—')}，新的期間接在後面。` : `目前剩 ${lessonsOf(s0.id).left} 堂，會跟新買的堂數加在一起。`}已帶入上次的方案，可以直接改。</div>` : ''}
    ${seg('payType', type, [['lessons', '堂數制'], ['period', '月費制（期間內不扣堂）']])}
    <div class="field"><label for="p-stu">學員</label><select id="p-stu" name="studentId" required><option value="">選擇學員</option>${studs.map(s => `<option value="${s.id}" ${p.studentId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="p-plan">方案</label><input id="p-plan" name="plan" list="dl-plan" value="${esc(p.plan || (type === 'period' ? '月費' : ''))}">${dataList('dl-plan', type === 'period' ? ['月費', '季費（3 個月）', '暑期營隊', '寒假營隊'] : ['4 堂課程', '8 堂課程', '12 堂課程', '單堂', '檢定報名'])}</div>
    ${type === 'period' ? `<div class="two"><div class="field"><label for="p-start">開始日</label><input id="p-start" name="start" type="date" required value="${esc(start)}"></div>
      <div class="field"><label for="p-end">到期日</label><input id="p-end" name="end" type="date" required value="${esc(end)}"></div></div>`
      : `<div class="field"><label for="p-les">堂數</label><input id="p-les" name="lessons" type="number" inputmode="numeric" min="0" value="${esc(p.lessons)}"></div>`}
    <div class="two"><div class="field"><label for="p-amt">金額（NT$）</label><input id="p-amt" name="amount" type="number" inputmode="numeric" min="0" required value="${esc(p.amount)}" placeholder="3200"></div>
    <div class="field"><label for="p-meth">付款方式</label><select id="p-meth" name="method">${opts(['現金', '轉帳', 'LINE Pay', '街口', '其他'], p.method)}</select></div></div>
    <div class="field"><label for="p-date">收款日</label><input id="p-date" name="date" type="date" required value="${esc(p.date)}"></div>
    <div class="field"><label for="p-note">備註</label><input id="p-note" name="note" value="${esc(p.note)}" placeholder="兄弟姊妹優惠、含護具…"></div>
    <button class="btn" type="submit">${p.id ? '儲存' : opt.renew ? '確認續約' : '登記收費'}</button>
    ${p.id ? delBlock('payments', p.id, '這筆收費') : ''}</form>`, sh => {
    const stuSel = $('#p-stu', sh);
    sh.querySelectorAll('[data-act="payType"]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const fd = Object.fromEntries(new FormData($('#f', sh))); payForm({ ...p, ...fd, plan: '', type: b.dataset.v }, sid, { ...opt, type: b.dataset.v }); });
    const st = $('#p-start', sh); if (st) st.onchange = () => { $('#p-end', sh).value = addMonth(st.value); };
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target)); if (!fd.studentId) return;
      fd.type = type; fd.amount = +fd.amount || 0; fd.createdAt = p.createdAt || Date.now(); fd.by = S.me.uid;
      if (type === 'period') { fd.lessons = 0; if (fd.end < fd.start) { toast('到期日要在開始日之後'); return; } } else { fd.lessons = +fd.lessons || 0; delete fd.start; delete fd.end; }
      const id = p.id || newId();
      if (await save('payments', id, fd)) {
        try { await syncBought(fd.studentId, id, { ...fd, id }); if (p.studentId && p.studentId !== fd.studentId) await syncBought(p.studentId, id, null); } catch (err) { toast(fbErr(err)); }
        toast((opt.renew ? '續約完成 ' : '已登記 ') + money(fd.amount)); (sid || opt.renew) ? openStudent(fd.studentId) : closeSheet();
      }
    };
  });
}
function attendSheet(cid) {
  const c = clsById(cid); if (!c) return;
  const ss = sessionOf(cid, S.day);
  const status = { ...(ss && ss.status || {}) };
  const studs = (c.studentIds || []).map(stuById).filter(s => s && (!s.archived || status[s.id]));
  if (!ss) studs.forEach(s => status[s.id] = 'present');
  const draw = () => studs.map(s => { const v = status[s.id]; const L = lessonsOf(s.id); const per = inPeriod(s, S.day); return `<div class="att"><div class="grow"><div class="nm">${esc(s.name)}</div><div class="sub">${per ? '月費期間，不扣堂' : '剩 ' + L.left + ' 堂'}</div></div>
    <div class="tri" data-sid="${s.id}"><button type="button" class="p" aria-pressed="${v === 'present'}" data-v="present">出席</button><button type="button" class="l" aria-pressed="${v === 'leave'}" data-v="leave">請假</button><button type="button" class="a" aria-pressed="${v === 'absent'}" data-v="absent">缺席</button></div></div>`; }).join('');
  const title = `${c.name} · ${S.day.slice(5).replace('-', '/')}`;
  if (ss && ss.cancelled) return openSheet(title, `<div class="empty"><b>這堂已停課</b><span>${esc(ss.reason || '')}</span><span>停課不會扣任何人的堂數。</span>
    <button class="btn" id="a-undo">恢復這堂課</button></div>`, sh => { $('#a-undo', sh).onclick = async () => { if (await del('sessions', cid + '_' + S.day)) { toast('已恢復'); closeSheet(); } }; });
  openSheet(title, `
    <div class="sub">${esc([c.start + '–' + endTime(c.start, c.duration), userName(c.coachUid), c.location].filter(Boolean).join(' · '))}</div>
    ${studs.length ? `<div class="list" id="attl">${draw()}</div>
    <div class="field"><label for="a-coach">本堂教練</label><select id="a-coach">${coachOptions((ss && ss.coachUid) || c.coachUid || S.me.uid)}</select></div>
    <div class="field"><label for="a-note">課堂紀錄</label><textarea id="a-note" placeholder="今天練了交叉步、T 字煞車…">${esc(ss && ss.note)}</textarea></div>
    <button class="btn" id="a-save">${ss ? '更新點名' : '完成點名'}</button>
    ${ss ? '<button class="btn ghost" id="a-clear">取消這堂點名（退回堂數）</button>' : ''}`
    : `<div class="empty"><b>這個班還沒有學員</b>${A() ? `<button class="btn sm" data-act="editClass" data-id="${cid}">編輯班級、勾選學員</button>` : '<span>請管理員把學員加進這個班。</span>'}</div>`}
    <details class="card"><summary><b>整堂停課</b>（颱風、下雨、場地不能用）</summary>
      <div class="form" style="margin-top:10px"><div class="field"><label for="a-reason">停課原因</label><input id="a-reason" placeholder="颱風停課"></div>
      <button class="btn danger" id="a-cancel" type="button">確定停課，不扣任何人的堂數</button></div></details>`, sh => {
    $('#a-cancel', sh).onclick = async () => {
      const d = { classId: cid, date: S.day, cancelled: true, reason: $('#a-reason', sh).value.trim(), status: {}, coachUid: c.coachUid || '', updatedBy: S.me.uid, updatedAt: Date.now() };
      if (await save('sessions', cid + '_' + S.day, d)) { toast('已停課'); closeSheet(); }
    };
    const l = $('#attl', sh); if (!l) return;
    l.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; status[b.parentElement.dataset.sid] = b.dataset.v; l.innerHTML = draw(); });
    $('#a-save', sh).onclick = async () => {
      const d = { classId: cid, date: S.day, status, coachUid: $('#a-coach', sh).value, note: $('#a-note', sh).value, updatedBy: S.me.uid, updatedAt: Date.now() };
      if (await save('sessions', cid + '_' + S.day, d)) { toast('點名完成'); closeSheet(); }
    };
    const cl = $('#a-clear', sh); if (cl) cl.onclick = async () => { if (await del('sessions', cid + '_' + S.day)) { toast('已取消點名'); closeSheet(); } };
  });
}
function memberSheet(uid) {
  const u = S.users.find(x => x.id === uid); if (!u) return;
  const self = uid === S.me.uid;
  openSheet(u.name || u.email, `<form class="form" id="f">
    <div class="sub">${esc(u.email)}</div>
    <div class="field"><label for="m-name">顯示名稱</label><input id="m-name" value="${esc(u.name)}"></div>
    <div class="field"><label for="m-role">身分</label><select id="m-role" ${self ? 'disabled' : ''}>
      ${[['coach', '教練'], ['admin', '管理員'], ['pending', '等待開通'], ['disabled', '停用']].map(([v, t]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${self ? '<span class="sub">不能變更自己的身分，避免沒有管理員。</span>' : ''}</div>
    <div class="field"><label for="m-rate">每堂鐘點費（NT$，只有管理員看得到）</label><input id="m-rate" type="number" inputmode="numeric" min="0" value="${esc(S.rates[uid] || '')}" placeholder="800"></div>
    ${u.role === 'pending' ? '<button class="btn acc" type="button" id="m-approve">開通為教練</button>' : ''}
    <button class="btn" type="submit">儲存</button></form>`, sh => {
    const doSave = async role => {
      try {
        await updateDoc(doc(fs, 'users', uid), { name: $('#m-name', sh).value.trim() || u.email, role: self ? u.role : role });
        await setDoc(doc(fs, 'meta', 'rates'), { ...S.rates, [uid]: +$('#m-rate', sh).value || 0 });
        toast('已儲存'); closeSheet();
      } catch (e) { toast(fbErr(e)); }
    };
    const ap = $('#m-approve', sh); if (ap) ap.onclick = () => doSave('coach');
    $('#f', sh).onsubmit = e => { e.preventDefault(); doSave($('#m-role', sh).value); };
  });
}
function settingsSheet() {
  const st = S.settings;
  openSheet('場地與扣堂規則', `<form class="form" id="f">
    <div class="field"><label for="s-loc">上課場地（一行一個）</label><textarea id="s-loc" placeholder="板橋第一運動場&#10;新莊體育館">${esc((st.locations || []).join('\n'))}</textarea></div>
    <div class="field"><label for="s-abs">未請假缺席</label><select id="s-abs"><option value="1" ${st.absentDeducts ? 'selected' : ''}>扣堂</option><option value="0" ${st.absentDeducts ? '' : 'selected'}>不扣堂</option></select></div>
    <button class="btn" type="submit">儲存設定</button></form>`, sh => {
    $('#f', sh).onsubmit = async e => {
      e.preventDefault();
      const locations = $('#s-loc', sh).value.split(/[\n,，、]/).map(x => x.trim()).filter(Boolean);
      try { await setDoc(doc(fs, 'meta', 'settings'), { locations, absentDeducts: $('#s-abs', sh).value === '1' }); toast('設定已儲存'); closeSheet(); } catch (err) { toast(fbErr(err)); }
    };
  });
}
function backup() {
  const data = JSON.stringify({ app: '菁鷹直排輪', exportedAt: new Date().toISOString(), settings: S.settings, rates: S.rates, users: S.users, students: S.students, classes: S.classes, payments: S.payments, sessions: S.sessions, leads: S.leads }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = '菁鷹備份-' + today() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('備份已下載');
}

/* ---------- 按鈕事件 ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id, v = b.dataset.v, sid = b.dataset.sid;
  switch (a) {
    case 'close': closeSheet(); break;
    case 'pickDay': S.day = v; render(); break;
    case 'wkPrev': S.day = ymd(addDays(parseYmd(S.day), -7)); render(); break;
    case 'wkNext': S.day = ymd(addDays(parseYmd(S.day), 7)); render(); break;
    case 'dayToday': S.day = today(); render(); break;
    case 'mine': S.mine = v === '1'; render(); break;
    case 'stuTab': S.stuTab = v; render(); break;
    case 'stFilter': S.stFilter = v; render(); break;
    case 'tag': S.tag = v; render(); break;
    case 'leadFilter': S.leadFilter = v; render(); break;
    case 'moreTab': S.moreTab = v; render(); break;
    case 'yPrev': S.year--; render(); break;
    case 'yNext': S.year++; render(); break;
    case 'mPrev': case 'mNext': { const [y, m] = S.month.split('-').map(Number); const d = new Date(y, m - 1 + (a === 'mNext' ? 1 : -1), 1); S.month = d.getFullYear() + '-' + pad(d.getMonth() + 1); render(); break; }
    case 'newStudent': if (A()) studentForm(); break;
    case 'editStudent': if (A()) studentForm(stuById(id)); break;
    case 'student': openStudent(id); break;
    case 'renew': if (A()) payForm(null, sid, { renew: true }); break;
    case 'levelUp': if (A()) levelForm(sid); break;
    case 'delLevel': if (A()) { const s = stuById(sid); const lv = (s.levels || []).filter((_, i) => i !== +b.dataset.i); try { await updateDoc(doc(fs, 'students', sid), { levels: lv }); openStudent(sid); } catch (err) { toast(fbErr(err)); } } break;
    case 'toggleRenew': if (A()) { const s = stuById(sid); try { await updateDoc(doc(fs, 'students', sid), { renew: !s.renew }); toast(s.renew ? '已取消待續約' : '已標為待續約'); setTimeout(() => openStudent(sid), 200); } catch (err) { toast(fbErr(err)); } } break;
    case 'toggleArchive': if (A()) { const s = stuById(sid); try { await updateDoc(doc(fs, 'students', sid), { archived: !s.archived }); toast(s.archived ? '已恢復在檔' : '已封存'); setTimeout(() => openStudent(sid), 200); } catch (err) { toast(fbErr(err)); } } break;
    case 'newClass': if (A()) classForm(null, b.dataset.wd != null ? +b.dataset.wd : null); break;
    case 'editClass': if (A()) classForm(clsById(id)); break;
    case 'viewClass': viewClass(id); break;
    case 'attend': attendSheet(id); break;
    case 'newPay': payForm(null, sid); break;
    case 'editPay': payForm(S.payments.find(p => p.id === id)); break;
    case 'newLead': leadForm(); break;
    case 'lead': leadForm(S.leads.find(l => l.id === id)); break;
    case 'leadWon': { const l = S.leads.find(x => x.id === id); if (A()) convertLead(id); else if (l) { try { await updateDoc(doc(fs, 'leads', id), { status: 'won', closedDate: today() }); toast('已標記報名，請管理員建立學員資料'); } catch (err) { toast(fbErr(err)); } } break; }
    case 'convertLead': if (A()) convertLead(id); break;
    case 'member': memberSheet(id); break;
    case 'settings': settingsSheet(); break;
    case 'backup': backup(); break;
    case 'logout': closeSheet(); await signOut(auth); break;
    case 'askDel': $('#delconf').hidden = false; b.hidden = true; break;
    case 'cancelDel': $('#delconf').hidden = true; $('[data-act="askDel"]').hidden = false; break;
    case 'doDel': if (await del(b.dataset.kind, id)) { toast('已刪除'); closeSheet(); } break;
  }
});
document.addEventListener('input', e => {
  if (e.target.id !== 'q') return;
  S.q = e.target.value; const pos = e.target.selectionStart; render();
  const q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (_) {} }
});
