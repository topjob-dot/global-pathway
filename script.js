import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, onSnapshot,
  collection, query, where, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
  getStorage, ref as sRef, uploadBytesResumable, getDownloadURL
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";

/* ===================== FIREBASE CONFIG ===================== */
const firebaseConfig = {
  apiKey: "AIzaSyB7SFf4VfxrPPyZVBKk_R0e4JNpI7GAjjQ",
  authDomain: "global-pathway-304ca.firebaseapp.com",
  projectId: "global-pathway-304ca",
  storageBucket: "global-pathway-304ca.firebasestorage.app",
  messagingSenderId: "232962659696",
  appId: "1:232962659696:web:893b959db425108219abb5"
};
const ADMIN_UIDS = [];  // agency owner pastes their account ID here

/* ===================== AGENCY PAYMENT SETTINGS (edit only this block) ===================== */
const AGENCY = {
  feeLabel: "Processing Fee", fee: 250, currency: "USD",
  deadline: "Pay within 5 business days of registering.",
  note: "Use your Reference ID as the payment narration, then submit your transaction reference.",
  contact: { email: "support@globalpathway.example", phone: "+254 700 000 000", hours: "Mon-Fri, 9:00 AM - 5:00 PM (EAT)" },
  methods: [
    { name: "Bank Transfer", fields: [["Bank Name", "Example Bank Ltd"], ["Account Name", "Global Pathway Ltd"], ["Account Number", "0123456789"], ["SWIFT / BIC", "EXAMKENX"]] },
    { name: "Mobile Money", fields: [["Provider", "M-Pesa"], ["Number / Paybill", "123456"], ["Account Name", "Global Pathway Ltd"]] }
  ]
};

/* ===================== HELPERS ===================== */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ms = v => (v && typeof v.toMillis === "function") ? v.toMillis() : (typeof v === "number" ? v : 0);
const fmtDate = t => t ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "just now";
const fmt = (a, c) => `${c} ${Number(a).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const maskName = n => {
  const p = String(n || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "Applicant";
  if (p.length === 1) return p[0];
  return `${p[0]} ${p[p.length - 1][0].toUpperCase()}.`;
};
const badge = s => {
  const t = String(s || "");
  const cls = /approved|confirmed|complete|received/i.test(t) && !/application received/i.test(t) ? "ok"
    : /reject|fail/i.test(t) ? "bad"
    : /pending|awaiting/i.test(t) ? "warn" : "info";
  return `<span class="badge ${cls}">${esc(t)}</span>`;
};

function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

const ERR = {
  "auth/configuration-not-found": "Authentication not enabled. Enable Email/Password sign-in in the Firebase console.",
  "auth/operation-not-allowed": "Authentication not enabled. Enable Email/Password sign-in in the Firebase console.",
  "auth/email-already-in-use": "That email is already registered. Try logging in instead.",
  "auth/weak-password": "Password is too weak. Use at least 6 characters.",
  "auth/invalid-credential": "Incorrect email or password.",
  "auth/wrong-password": "Incorrect email or password.",
  "auth/user-not-found": "Incorrect email or password.",
  "auth/invalid-email": "That email address is not valid.",
  "auth/unauthorized-domain": "This website's domain is not authorised in Firebase Authentication settings.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "permission-denied": "Firestore rules blocked this.",
  "storage/unauthorized": "Storage rules blocked this upload.",
  "unavailable": "Service temporarily unavailable. Please try again."
};
const friendly = e => ERR[e?.code] || e?.message || "Something went wrong.";
const fail = e => { console.error(e); toast(friendly(e), "error"); };

/* ===================== FIREBASE INIT ===================== */
let app, auth, db, storage;
try {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app);
} catch (e) { console.error(e); toast("Could not start Firebase: " + friendly(e), "error"); }

/* ===================== STATE ===================== */
const STAGES = ["Registered", "Documents", "Payment Sent", "Payment Confirmed", "Approved"];
const DOCS = [["passport", "Passport", true], ["academic", "Academic Credentials", true], ["photo", "Passport Photo", false], ["support", "Supporting Document", false]];
const docLabel = k => (DOCS.find(d => d[0] === k) || [k, k])[1];
let me = null, userData = null, appData = null;
let payments = [], messages = [], adminPays = [], adminMsgs = [];
let unsubs = [], appUnsub = null, watchedRef = null;
let isAdmin = false, profileFilled = false, pendingSignup = null, replyTarget = null;
let methodIdx = 0, lastPayRef = null, lastThreadLen = -1;

/* ===================== VIEWS, MODALS, TABS ===================== */
function showView(v) {
  $("publicSite").hidden = v === "dash";
  $("dashboard").hidden = v !== "dash";
  window.scrollTo(0, 0);
}
function setNav(loggedIn) {
  $("navLogin").hidden = loggedIn;
  $("navStart").hidden = loggedIn;
  $("navDash").hidden = !loggedIn;
  $("navLogout").hidden = !loggedIn;
}
function showTab(n) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === n));
  document.querySelectorAll(".panel").forEach(p => { p.hidden = p.id !== "tab-" + n; });
}
function setAuthTab(t) {
  document.querySelectorAll("[data-authtab]").forEach(b => b.classList.toggle("active", b.dataset.authtab === t));
  $("loginForm").hidden = t !== "login";
  $("signupForm").hidden = t !== "signup";
}
function openModal(name) {
  if (name === "privacy") $("privacyModal").classList.add("open");
  else { setAuthTab(name === "signup" ? "signup" : "login"); $("authModal").classList.add("open"); }
}
function closeModals() { document.querySelectorAll(".modal").forEach(m => m.classList.remove("open")); }

document.addEventListener("click", e => {
  const open = e.target.closest("[data-open]");
  if (open) { e.preventDefault(); openModal(open.dataset.open); return; }
  if (e.target.closest("[data-close]") || e.target.classList.contains("modal")) { closeModals(); return; }
  const at = e.target.closest("[data-authtab]");
  if (at) { setAuthTab(at.dataset.authtab); return; }
  const tab = e.target.closest(".tab");
  if (tab) { showTab(tab.dataset.tab); return; }
  const go = e.target.closest("[data-goto]");
  if (go) { showTab(go.dataset.goto); window.scrollTo(0, 0); return; }
  const cp = e.target.closest("[data-copy]");
  if (cp) { copyText(cp.dataset.copy); return; }
  const mt = e.target.closest("[data-method]");
  if (mt) { methodIdx = Number(mt.dataset.method) || 0; renderPayInstr(); return; }
  const nav = e.target.closest("#navLinks a[href^='#']");
  if (nav && nav.getAttribute("href") !== "#" && !$("dashboard").hidden) showView("public");
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModals(); });
$("navDash").addEventListener("click", e => { e.preventDefault(); showView("dash"); });
$("navLogout").addEventListener("click", async e => { e.preventDefault(); try { await signOut(auth); toast("Logged out.", "success"); } catch (err) { fail(err); } });
$("navLogin").addEventListener("click", e => e.preventDefault());
$("navStart").addEventListener("click", e => e.preventDefault());

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast("Copied to clipboard", "success"); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied to clipboard", "success"); } catch { toast("Copy failed", "error"); }
    ta.remove();
  }
}

/* ===================== PUBLIC VERIFY ===================== */
$("verifyForm").addEventListener("submit", async e => {
  e.preventDefault();
  const out = $("verifyResult");
  const code = $("verifyCode").value.trim().toUpperCase();
  if (!/^REF-\d{6}$/.test(code)) { out.innerHTML = `<p class="err">Enter a code like REF-123456.</p>`; return; }
  out.innerHTML = `<p class="muted">Checking...</p>`;
  try {
    const s = await getDoc(doc(db, "applications", code));
    if (!s.exists()) { out.innerHTML = `<p class="err">No application found for ${esc(code)}.</p>`; return; }
    const a = s.data();
    out.innerHTML = `<div class="vr">
      <div><small>Applicant</small><b>${esc(a.name)}</b></div>
      <div><small>Status</small>${badge(a.status)}</div>
      <div><small>Documents</small>${badge(a.docsUploaded ? "Complete" : "Pending")}</div>
      <div><small>Payment</small>${badge(a.paymentStatus)}</div></div>`;
  } catch (err) { console.error(err); out.innerHTML = `<p class="err">${esc(friendly(err))}</p>`; }
});

/* ===================== AUTH ===================== */
async function newRef() {
  for (let i = 0; i < 8; i++) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    const r = "REF-" + String(n).padStart(6, "0");
    const s = await getDoc(doc(db, "applications", r));
    if (!s.exists()) return r;
  }
  throw new Error("Could not generate a unique Reference ID. Please try again.");
}

async function createProfile(user, f) {
  const refCode = await newRef();
  const name = (f.name || (user.email || "Client").split("@")[0]).trim();
  const b = writeBatch(db);
  b.set(doc(db, "users", user.uid), {
    name, email: user.email, refCode, phone: f.phone || "", country: f.country || "",
    destination: f.destination || "", docs: {}, status: "Application Received",
    approved: false, createdAt: serverTimestamp()
  });
  b.set(doc(db, "applications", refCode), {
    userId: user.uid, name: maskName(name), status: "Application Received",
    docsUploaded: false, paymentStatus: "Awaiting Payment"
  });
  await b.commit();
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, $("liEmail").value.trim(), $("liPass").value);
    closeModals(); e.target.reset(); toast("Welcome back!", "success");
  } catch (err) { fail(err); } finally { if (btn) btn.disabled = false; }
});

$("signupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = e.submitter; if (btn) btn.disabled = true;
  const f = {
    name: $("suName").value.trim(), phone: $("suPhone").value.trim(),
    country: $("suCountry").value.trim(), destination: $("suDest").value.trim()
  };
  const email = $("suEmail").value.trim(), pass = $("suPass").value;
  try {
    pendingSignup = (async () => {
      const c = await createUserWithEmailAndPassword(auth, email, pass);
      await createProfile(c.user, f);
    })();
    await pendingSignup;
    closeModals(); e.target.reset(); toast("Account created. Welcome to Global Pathway!", "success");
  } catch (err) { fail(err); } finally { pendingSignup = null; if (btn) btn.disabled = false; }
});

$("forgotLink").addEventListener("click", async e => {
  e.preventDefault();
  const email = $("liEmail").value.trim();
  if (!email) { toast("Type your email above first, then click Forgot password.", "error"); return; }
  try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent. Check your inbox.", "success"); }
  catch (err) { fail(err); }
});

$("resetBtn").addEventListener("click", async () => {
  if (!me?.email) return;
  try { await sendPasswordResetEmail(auth, me.email); toast("Password reset email sent to " + me.email, "success"); }
  catch (err) { fail(err); }
});

async function ensureUserDoc(user) {
  const s = await getDoc(doc(db, "users", user.uid));
  if (!s.exists()) await createProfile(user, { name: user.displayName || "" });
}

function stopListeners() {
  unsubs.forEach(u => u()); unsubs = [];
  if (appUnsub) { appUnsub(); appUnsub = null; }
  watchedRef = null;
}

function startListeners() {
  stopListeners();
  const uid = me.uid;
  unsubs.push(onSnapshot(doc(db, "users", uid), s => {
    userData = s.exists() ? s.data() : null;
    if (userData && userData.refCode !== watchedRef) {
      watchedRef = userData.refCode;
      if (appUnsub) appUnsub();
      appUnsub = onSnapshot(doc(db, "applications", watchedRef), a => { appData = a.exists() ? a.data() : null; renderAll(); }, fail);
    }
    renderAll();
  }, fail));
  unsubs.push(onSnapshot(query(collection(db, "payments"), where("uid", "==", uid)), s => {
    payments = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll();
  }, fail));
  unsubs.push(onSnapshot(query(collection(db, "messages"), where("uid", "==", uid)), s => {
    messages = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAll();
  }, fail));
  if (isAdmin) {
    unsubs.push(onSnapshot(collection(db, "payments"), s => {
      adminPays = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAdmin();
    }, fail));
    unsubs.push(onSnapshot(collection(db, "messages"), s => {
      adminMsgs = s.docs.map(d => ({ id: d.id, ...d.data() })); renderAdmin();
    }, fail));
  }
}

if (auth) onAuthStateChanged(auth, async user => {
  if (pendingSignup) { try { await pendingSignup; } catch { /* handled by signup form */ } }
  if (!user) {
    stopListeners();
    me = userData = appData = null; payments = []; messages = []; adminPays = []; adminMsgs = [];
    isAdmin = false; profileFilled = false; lastPayRef = null; lastThreadLen = -1; replyTarget = null;
    $("tabAdminBtn").hidden = true;
    setNav(false); showView("public"); showTab("overview");
    return;
  }
  me = user;
  isAdmin = ADMIN_UIDS.includes(user.uid);
  $("tabAdminBtn").hidden = !isAdmin;
  try { await ensureUserDoc(user); } catch (e) { fail(e); }
  startListeners();
  setNav(true); showView("dash");
});

/* ===================== RENDER ===================== */
function renderAll() {
  if (!me || !userData) return;
  renderHeader(); renderOverview(); renderDocs(); renderPayInstr(true);
  renderPayHistory(); renderThread(); renderProfile(); renderContact();
  if (isAdmin) renderAdmin();
}

function renderHeader() {
  $("welcome").textContent = "Welcome, " + (userData.name || "Client");
  $("refId").textContent = userData.refCode;
  $("refCopy").dataset.copy = userData.refCode;
  $("statusBadge").outerHTML = `<span id="statusBadge" class="${badge(userData.status).match(/class="([^"]+)"/)[1]}">${esc(userData.status)}</span>`;
}

function renderOverview() {
  const a = appData || {};
  const done = [true, !!a.docsUploaded, payments.length > 0, a.paymentStatus === "Confirmed", !!userData.approved];
  const cur = done.indexOf(false);
  $("progress").innerHTML = STAGES.map((s, i) =>
    `<div class="stage ${done[i] ? "done" : i === cur ? "cur" : ""}"><span>${done[i] ? "&#10003;" : i + 1}</span><p>${esc(s)}</p></div>`).join("");

  let n;
  if (userData.approved) n = { t: "Your application is approved", p: "Our team will contact you with your next steps.", b: "Contact support", g: "support" };
  else if (!a.docsUploaded) n = { t: "Upload your documents", p: "Your Passport and Academic Credentials are required.", b: "Go to Documents", g: "documents" };
  else if (!payments.length) n = { t: "Pay the processing fee", p: `Pay ${fmt(AGENCY.fee, AGENCY.currency)} and submit your transaction reference.`, b: "Go to Payment", g: "payment" };
  else if (a.paymentStatus === "Rejected") n = { t: "Payment rejected", p: "Check the details and message the agency, or submit a corrected payment.", b: "Open Payment", g: "payment" };
  else if (a.paymentStatus !== "Confirmed") n = { t: "Payment awaiting verification", p: "We are matching your transaction reference to our records.", b: "View payments", g: "payment" };
  else n = { t: "Awaiting final approval", p: "Your payment is confirmed. We are completing your application.", b: "Message the agency", g: "support" };
  $("nextStep").innerHTML = `<div><small class="muted">NEXT STEP</small><h3>${esc(n.t)}</h3><p>${esc(n.p)}</p></div><button class="btn" data-goto="${esc(n.g)}">${esc(n.b)}</button>`;

  const reqDone = ["passport", "academic"].filter(k => userData.docs && userData.docs[k]).length;
  $("stats").innerHTML = [
    ["Required documents", reqDone + " / 2"],
    ["Payments submitted", String(payments.length)],
    ["Payment status", a.paymentStatus || "Awaiting Payment"],
    ["Application status", userData.status]
  ].map(([k, v]) => `<div class="glass stat"><small>${esc(k)}</small><b>${esc(v)}</b></div>`).join("");

  const ev = [{ t: ms(userData.createdAt), x: "Account registered" }];
  Object.entries(userData.docs || {}).forEach(([k, d]) => ev.push({ t: d.uploadedAt || 0, x: "Uploaded " + docLabel(k) }));
  payments.forEach(p => ev.push({ t: ms(p.createdAt), x: `Payment ${p.reference}: ${p.status}` }));
  messages.filter(m => m.from === "agency").forEach(m => ev.push({ t: ms(m.createdAt), x: "Message from the agency" }));
  ev.sort((x, y) => y.t - x.t);
  $("activity").innerHTML = ev.slice(0, 8).map(x => `<li><span>${esc(x.x)}</span><small>${esc(fmtDate(x.t))}</small></li>`).join("");
}

function buildDocCards() {
  $("docsList").innerHTML = DOCS.map(([k, l, r]) => `
    <div class="glass doc pad" data-key="${k}">
      <div class="row"><h4>${esc(l)}</h4><span class="badge ${r ? "warn" : "info"}">${r ? "Required" : "Optional"}</span></div>
      <p class="st muted">Not uploaded</p>
      <label class="upload"><input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"><span>Choose file</span></label>
      <div class="bar"><i></i></div>
    </div>`).join("");
}

function renderDocs() {
  document.querySelectorAll("#docsList .doc").forEach(card => {
    const d = userData.docs && userData.docs[card.dataset.key];
    const st = card.querySelector(".st");
    if (d) {
      const safe = typeof d.url === "string" && d.url.startsWith("https://");
      st.innerHTML = `&#10003; ${safe ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>` : esc(d.name)}`;
      st.classList.remove("muted");
    } else { st.textContent = "Not uploaded"; st.classList.add("muted"); }
  });
}

$("docsList").addEventListener("change", e => {
  const inp = e.target;
  if (inp.type !== "file" || !inp.files[0]) return;
  const file = inp.files[0];
  const card = inp.closest(".doc");
  inp.value = "";
  upload(card.dataset.key, file, card);
});

function upload(key, file, card) {
  if (!me || !userData) return;
  const okType = ["application/pdf", "image/jpeg", "image/png"].includes(file.type) && /\.(pdf|jpe?g|png)$/i.test(file.name);
  if (!okType) { toast("Only PDF, JPG or PNG files are allowed.", "error"); return; }
  if (file.size > 10 * 1024 * 1024) { toast("File is larger than 10 MB.", "error"); return; }
  const path = `docs/${me.uid}/${key}_${Date.now()}_${file.name.replace(/[^\w.\-]/g, "_")}`;
  const bar = card.querySelector(".bar"), fill = bar.querySelector("i");
  bar.classList.add("on"); fill.style.width = "0%";
  const task = uploadBytesResumable(sRef(storage, path), file, { contentType: file.type });
  task.on("state_changed",
    s => { fill.style.width = (s.bytesTransferred / s.totalBytes * 100).toFixed(0) + "%"; },
    err => { bar.classList.remove("on"); fail(err); },
    async () => {
      try {
        const url = await getDownloadURL(task.snapshot.ref);
        const entry = { name: file.name, url, path, uploadedAt: Date.now() };
        await updateDoc(doc(db, "users", me.uid), { ["docs." + key]: entry });
        const merged = { ...(userData.docs || {}), [key]: entry };
        if (merged.passport && merged.academic) await updateDoc(doc(db, "applications", userData.refCode), { docsUploaded: true });
        toast(docLabel(key) + " uploaded.", "success");
      } catch (err) { fail(err); }
      setTimeout(() => bar.classList.remove("on"), 600);
    });
}

function renderPayInstr(onlyIfRefChanged) {
  const refCode = userData?.refCode || "";
  if (onlyIfRefChanged && refCode === lastPayRef) return;
  lastPayRef = refCode;
  const m = AGENCY.methods[methodIdx] || AGENCY.methods[0];
  $("payInstr").innerHTML = `
    <h3>Payment instructions</h3>
    <div class="fee">
      <div><small>${esc(AGENCY.feeLabel)}</small><strong>${esc(fmt(AGENCY.fee, AGENCY.currency))}</strong></div>
      <div><small>Your Reference ID (use as payment narration)</small><strong>${esc(refCode || "-")}</strong>
        <button type="button" class="chip" data-copy="${esc(refCode)}">Copy</button></div>
    </div>
    <p class="muted">${esc(AGENCY.deadline)} ${esc(AGENCY.note)}</p>
    <div class="mtabs" style="margin-top:16px">${AGENCY.methods.map((x, i) =>
      `<button type="button" class="mtab ${x === m ? "active" : ""}" data-method="${i}">${esc(x.name)}</button>`).join("")}</div>
    <dl class="fields">${m.fields.map(([k, v]) =>
      `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd><button type="button" class="chip" data-copy="${esc(v)}">Copy</button></div>`).join("")}</dl>`;
}

function renderPayHistory() {
  const list = [...payments].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  $("payHistory").innerHTML = list.length ? list.map(p => `
    <li><div><b>${esc(p.reference)}</b> &middot; ${esc(fmt(p.amount, p.currency || AGENCY.currency))}<br>
      <small>Matched to application ${esc(p.refCode)} &middot; ${esc(p.method)} &middot; ${esc(p.date)}</small></div>${badge(p.status)}</li>`).join("")
    : `<li><span class="muted">No payments submitted yet.</span></li>`;
}

function renderThread() {
  const list = [...messages].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const th = $("thread");
  th.innerHTML = list.length ? list.map(m => `
    <div class="msg ${m.from === "agency" ? "agency" : "client"}">${esc(m.text)}<small>${m.from === "agency" ? "Agency" : "You"} &middot; ${esc(fmtDate(ms(m.createdAt)))}</small></div>`).join("")
    : `<p class="muted">No messages yet. Write to us below.</p>`;
  if (list.length !== lastThreadLen) { th.scrollTop = th.scrollHeight; lastThreadLen = list.length; }
}

function renderContact() {
  const c = AGENCY.contact;
  $("contactBox").innerHTML = `<h3>Contact us</h3>
    <p>Email: <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></p>
    <p>Phone: <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></p>
    <p class="muted">${esc(c.hours)}</p>`;
}

function renderProfile() {
  $("prUid").textContent = me.uid;
  $("uidCopy").dataset.copy = me.uid;
  if (profileFilled) return;   // never overwrite what the user is typing
  $("prName").value = userData.name || "";
  $("prPhone").value = userData.phone || "";
  $("prCountry").value = userData.country || "";
  $("prDest").value = userData.destination || "";
  profileFilled = true;
}

/* ===================== PAYMENT FORM / SUPPORT / PROFILE ===================== */
function initPayForm() {
  $("pfMethod").innerHTML = [...AGENCY.methods.map(m => m.name), "Other"].map(n => `<option>${esc(n)}</option>`).join("");
  $("pfDate").value = today();
  $("pfAmount").value = AGENCY.fee;
}

$("payForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!me || !userData) return;
  const reference = $("pfRef").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const amount = parseFloat($("pfAmount").value);
  if (!reference) { toast("Enter a valid transaction reference (letters and numbers).", "error"); return; }
  if (!(amount > 0)) { toast("Enter a valid amount.", "error"); return; }
  const btn = $("pfSubmit"); btn.disabled = true;
  try {
    await setDoc(doc(db, "payments", reference), {
      uid: me.uid, refCode: userData.refCode, name: userData.name, reference, amount,
      currency: AGENCY.currency, expected: AGENCY.fee, method: $("pfMethod").value,
      date: $("pfDate").value, status: "Pending Verification", createdAt: serverTimestamp()
    });
    toast(`Payment submitted and matched to application ${userData.refCode}.`, "success");
    e.target.reset(); initPayForm();
  } catch (err) {
    console.error(err);
    toast(err.code === "permission-denied" ? "This reference was already submitted, or Firestore rules blocked it." : friendly(err), "error");
  } finally { btn.disabled = false; }
});

$("msgForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!me || !userData) return;
  const text = $("msgText").value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "messages"), {
      uid: me.uid, refCode: userData.refCode, name: userData.name, from: "client", text, createdAt: serverTimestamp()
    });
    $("msgText").value = "";
  } catch (err) { fail(err); }
});

$("profileForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!me) return;
  try {
    await updateDoc(doc(db, "users", me.uid), {
      name: $("prName").value.trim(), phone: $("prPhone").value.trim(),
      country: $("prCountry").value.trim(), destination: $("prDest").value.trim()
    });
    toast("Profile saved.", "success");
  } catch (err) { fail(err); }
});

/* ===================== ADMIN ===================== */
function renderAdmin() {
  if (!isAdmin) return;
  const pays = [...adminPays].sort((a, b) => {
    const pa = a.status === "Pending Verification" ? 0 : 1, pb = b.status === "Pending Verification" ? 0 : 1;
    return pa - pb || ms(b.createdAt) - ms(a.createdAt);
  });
  $("adminPayments").innerHTML = pays.length ? pays.map(p => {
    const exp = p.expected ?? AGENCY.fee;
    const low = Number(p.amount) < Number(exp);
    return `<li>
      <div><b>${esc(p.name)}</b> &middot; ${esc(p.refCode)}<br>
        <small>Ref ${esc(p.reference)} &middot; ${esc(fmt(p.amount, p.currency || AGENCY.currency))} (fee ${esc(fmt(exp, p.currency || AGENCY.currency))}) &middot; ${esc(p.method)} &middot; ${esc(p.date)}</small>
        ${low ? `<br><span class="flag">&#9888; Amount is below the fee</span>` : ""}</div>
      <div class="acts">${badge(p.status)}
        <button class="btn mini green" data-act="confirm" data-id="${esc(p.id)}" data-ref="${esc(p.refCode)}" data-uid="${esc(p.uid)}">Confirm</button>
        <button class="btn mini red" data-act="reject" data-id="${esc(p.id)}" data-ref="${esc(p.refCode)}" data-uid="${esc(p.uid)}">Reject</button>
        <button class="btn mini" data-act="approve" data-id="${esc(p.id)}" data-ref="${esc(p.refCode)}" data-uid="${esc(p.uid)}">Approve Application</button>
      </div></li>`;
  }).join("") : `<li><span class="muted">No payments yet.</span></li>`;

  const msgs = adminMsgs.filter(m => m.from === "client").sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  $("adminMessages").innerHTML = msgs.length ? msgs.map(m => `
    <li><div><b>${esc(m.name)}</b> &middot; ${esc(m.refCode)} <small>${esc(fmtDate(ms(m.createdAt)))}</small><br>${esc(m.text)}</div>
      <button class="btn mini" data-reply="1" data-uid="${esc(m.uid)}" data-ref="${esc(m.refCode)}" data-name="${esc(m.name)}">Reply</button></li>`).join("")
    : `<li><span class="muted">No client messages.</span></li>`;
}

$("adminPayments").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !isAdmin) return;
  const { act, id, ref, uid } = btn.dataset;
  const b = writeBatch(db);
  const pRef = doc(db, "payments", id), aRef = doc(db, "applications", ref), uRef = doc(db, "users", uid);
  if (act === "confirm") {
    b.update(pRef, { status: "Confirmed" });
    b.update(aRef, { paymentStatus: "Confirmed", status: "Payment Confirmed" });
    b.update(uRef, { status: "Payment Confirmed" });
  } else if (act === "reject") {
    b.update(pRef, { status: "Rejected" });
    b.update(aRef, { paymentStatus: "Rejected", status: "Payment Rejected" });
    b.update(uRef, { status: "Payment Rejected" });
  } else if (act === "approve") {
    b.update(aRef, { status: "Approved" });
    b.update(uRef, { status: "Approved", approved: true });
  } else return;
  btn.disabled = true;
  try { await b.commit(); toast("Updated " + ref + ".", "success"); }
  catch (err) { fail(err); } finally { btn.disabled = false; }
});

$("adminMessages").addEventListener("click", e => {
  const btn = e.target.closest("button[data-reply]");
  if (!btn) return;
  replyTarget = { uid: btn.dataset.uid, refCode: btn.dataset.ref, name: btn.dataset.name };
  $("replyTo").textContent = `${replyTarget.name} (${replyTarget.refCode})`;
  $("replyForm").hidden = false;
  $("replyText").focus();
});
$("replyCancel").addEventListener("click", () => { replyTarget = null; $("replyForm").hidden = true; $("replyText").value = ""; });
$("replyForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isAdmin || !replyTarget) return;
  const text = $("replyText").value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "messages"), { ...replyTarget, from: "agency", text, createdAt: serverTimestamp() });
    $("replyText").value = ""; $("replyForm").hidden = true; replyTarget = null;
    toast("Reply sent.", "success");
  } catch (err) { fail(err); }
});

/* ===================== INIT ===================== */
buildDocCards();
initPayForm();
showTab("overview");
