// Discord UT Verification Bot — Cloudflare Worker

import * as XLSX from 'xlsx';

const MYUT_API_URL = 'https://api-sia.ut.ac.id/backend-sia/api/graphql';
const MYUT_URL_PATTERN = /^https:\/\/myut\.ut\.ac\.id\/e\/[a-f0-9]{32}$/;
const OLD_UT_QR_PATTERN = /^https?:\/\/webservice\.ut\.web\.id\/dp\.php\?id=\d+$/;
const SESSION_EXPIRE_MINUTES = 10;
const RATE_COOLDOWN_3RD = 5 * 60 * 1000; // 5 min
const RATE_COOLDOWN_OVER = 60 * 60 * 1000; // 1 hour

// ── Discord signature verification ──

async function verifyDiscordSignature(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const body = await request.clone().text();

  if (!signature || !timestamp) return false;

  const encoder = new TextEncoder();
  const data = encoder.encode(timestamp + body);

  const key = await crypto.subtle.importKey(
    'raw',
    fromHex(publicKey),
    { name: 'Ed25519', namedCurve: 'Ed25519' },
    true,
    ['verify']
  );

  return crypto.subtle.verify('Ed25519', key, fromHex(signature), data);
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

// ── Discord REST API helpers ──

function discordAPI(path, method, token, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`https://discord.com/api/v10${path}`, opts);
}

async function assignRole(guildId, userId, roleId, token) {
  const res = await discordAPI(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, 'PUT', token);
  return res.ok;
}

async function removeRole(guildId, userId, roleId, token) {
  const res = await discordAPI(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, 'DELETE', token);
  return res.ok;
}

async function getRolesToRemove(db, discordId, verifiedRoleId) {
  const rolesToRemove = [verifiedRoleId];

  const { results: userAttempts } = await db.prepare(
    "SELECT DISTINCT study_program FROM verify_attempts WHERE discord_id = ? AND study_program IS NOT NULL AND status = 'approved'"
  ).bind(discordId).all();

  if (userAttempts.length > 0) {
    const placeholders = userAttempts.map(() => '?').join(',');
    const { results: tagRoles } = await db.prepare(
      `SELECT DISTINCT mt.discord_role_id FROM major_tag_members mtm
       JOIN major_tags mt ON mtm.tag_id = mt.id
       WHERE mtm.study_program IN (${placeholders})`
    ).bind(...userAttempts.map(a => a.study_program)).all();

    for (const r of tagRoles) {
      if (!rolesToRemove.includes(r.discord_role_id)) {
        rolesToRemove.push(r.discord_role_id);
      }
    }
  }

  return rolesToRemove;
}

async function removeAllMemberRoles(guildId, userId, roleIds, token) {
  await Promise.all(roleIds.map(roleId => removeRole(guildId, userId, roleId, token)));
}

async function sendDM(userId, content, token) {
  const channelRes = await discordAPI('/users/@me/channels', 'POST', token, { recipient_id: userId });
  if (!channelRes.ok) return false;
  const channel = await channelRes.json();
  const msgRes = await discordAPI(`/channels/${channel.id}/messages`, 'POST', token, { content });
  return msgRes.ok;
}

async function sendFollowup(token, appId, content, ephemeral = true) {
  return fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, flags: ephemeral ? 64 : 0 }),
  });
}

// ── UUID generation ──

function uuid() {
  return crypto.randomUUID();
}

// ── Rate limiting ──

async function checkRateLimit(db, discordId) {
  const { results } = await db.prepare(
    "SELECT created_at FROM verify_attempts WHERE discord_id = ? AND created_at > datetime('now', '-1 hour') ORDER BY created_at DESC"
  ).bind(discordId).all();

  const count = results.length;
  if (count < 2) return { allowed: true };

  const lastAttempt = new Date(results[0].created_at).getTime();
  const now = Date.now();

  if (count === 2) {
    if (now - lastAttempt < RATE_COOLDOWN_3RD) {
      return { allowed: false, message: 'Silakan tunggu 5 menit sebelum mencoba verifikasi berikutnya.' };
    }
    return { allowed: true };
  }

  if (now - lastAttempt < RATE_COOLDOWN_OVER) {
    return { allowed: false, message: 'Terlalu banyak percobaan. Silakan tunggu 1 jam sebelum mencoba lagi, atau hubungi admin untuk persetujuan manual.' };
  }
  return { allowed: true };
}

// ── Myut API ──

async function fetchStudentData(myutUrl) {
  const match = myutUrl.match(/\/e\/([a-f0-9]{32})$/);
  if (!match) throw new Error('Invalid myut URL format');

  const query = `query getEktmPublic($idEktm: String!) {
    getEktmPublic(idEktm: $idEktm) {
      nim
      namaMahasiswa
      namaProgramStudi
      namaUpbjj
      masaRegistrasi
    }
  }`;

  const res = await fetch(MYUT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://myut.ut.ac.id',
      'Referer': 'https://myut.ut.ac.id/',
    },
    body: JSON.stringify({ query, variables: { idEktm: match[1] } }),
  });

  if (!res.ok) throw new Error(`myut API returned ${res.status}`);

  const json = await res.json();
  if (!json.data?.getEktmPublic) throw new Error('No student data returned from myut API');

  const d = json.data.getEktmPublic;
  return {
    nim: d.nim,
    nama: d.namaMahasiswa,
    studyProgram: d.namaProgramStudi,
    utRegion: d.namaUpbjj,
    classOf: d.masaRegistrasi,
  };
}

// ── R2 uploads ──

async function uploadToTemp(r2Temp, webpBuffer, id) {
  const key = `${id}.webp`;
  await r2Temp.put(key, webpBuffer, { httpMetadata: { contentType: 'image/webp' } });
  return key;
}

async function uploadToPerm(r2Perm, webpBuffer, nim) {
  const key = `ektm/${nim}.webp`;
  await r2Perm.put(key, webpBuffer, { httpMetadata: { contentType: 'image/webp' } });
  return key;
}

// ── Route handlers ──

async function handleInteraction(request, env) {
  const isValid = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY);
  if (!isValid) return new Response('Invalid signature', { status: 401 });

  const interaction = await request.json();

  // PING
  if (interaction.type === 1) {
    return Response.json({ type: 1 });
  }

  // Slash command
  if (interaction.type === 2) {
    const { name } = interaction.data;
    const discordId = interaction.member?.user?.id;
    const discordUsername = interaction.member?.user?.username;
    const hostname = new URL(request.url).hostname;

    if (name === 'verify') {
      return handleVerifyCommand(interaction, env, discordId, discordUsername, hostname);
    }

    if (name === 'status') {
      return handleStatusCommand(interaction, env, discordId);
    }
  }

  return Response.json({ type: 4, data: { content: 'Unknown command.', flags: 64 } });
}

async function handleVerifyCommand(interaction, env, discordId, discordUsername, hostname) {
  // Check if already verified
  const existing = await env.DB.prepare(
    "SELECT nim, nama FROM verify_attempts WHERE discord_id = ? AND status = 'approved' LIMIT 1"
  ).bind(discordId).first();

  if (existing) {
    return Response.json({
      type: 4,
      data: {
        content: `Anda sudah terverifikasi! NIM: ${existing.nim}, Nama: ${existing.nama}`,
        flags: 64,
      },
    });
  }

  // Check rate limit
  const rateLimit = await checkRateLimit(env.DB, discordId);
  if (!rateLimit.allowed) {
    return Response.json({
      type: 4,
      data: { content: rateLimit.message, flags: 64 },
    });
  }

  // Create session
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRE_MINUTES * 60 * 1000).toISOString();

  await env.DB.prepare(
    'INSERT INTO sessions (id, discord_id, discord_username, status, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(sessionId, discordId, discordUsername, 'active', expiresAt).run();

  const verifyUrl = `https://${hostname}/v/${sessionId}`;

  return Response.json({
    type: 4,
    data: {
      content: `Verifikasi identitas mahasiswa UT Anda dengan membuka tautan ini:\n${verifyUrl}\n\nTautan ini kadaluarsa dalam ${SESSION_EXPIRE_MINUTES} menit.`,
      flags: 64,
    },
  });
}

async function handleStatusCommand(interaction, env, discordId) {
  const attempt = await env.DB.prepare(
    "SELECT nim, nama, study_program, ut_region, class_of, status, verified_at FROM verify_attempts WHERE discord_id = ? AND status = 'approved' ORDER BY verified_at DESC LIMIT 1"
  ).bind(discordId).first();

  if (!attempt) {
    return Response.json({
      type: 4,
      data: { content: 'Anda belum terverifikasi. Jalankan `/verify` untuk memulai.', flags: 64 },
    });
  }

  return Response.json({
    type: 4,
    data: {
      content: `**Terverifikasi** ✓\nNIM: ${attempt.nim}\nNama: ${attempt.nama}\nProgram Studi: ${attempt.study_program}\nUPBJJ: ${attempt.ut_region}\nMasa Registrasi: ${attempt.class_of}\nDiverifikasi pada: ${attempt.verified_at}`,
      flags: 64,
    },
  });
}

async function handleVerificationPage(sessionId, env) {
  // Validate session
  const session = await env.DB.prepare(
    "SELECT * FROM sessions WHERE id = ? AND status = 'active'"
  ).bind(sessionId).first();

  if (!session) {
    return new Response('Sesi tidak ditemukan atau kadaluarsa. Silakan jalankan /verify lagi.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").bind(sessionId).run();
    return new Response('Sesi kadaluarsa. Silakan jalankan /verify lagi.', { status: 410, headers: { 'Content-Type': 'text/plain' } });
  }

  const html = getVerificationHTML(sessionId);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function processVerification(sessionId, request, env, ctx) {
  // Validate session
  const session = await env.DB.prepare(
    "SELECT * FROM sessions WHERE id = ? AND status = 'active'"
  ).bind(sessionId).first();

  if (!session) {
    return Response.json({ error: 'Sesi tidak ditemukan atau kadaluarsa. Silakan jalankan /verify lagi.' }, { status: 404 });
  }

  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare("UPDATE sessions SET status = 'expired' WHERE id = ?").bind(sessionId).run();
    return Response.json({ error: 'Sesi kadaluarsa. Silakan jalankan /verify lagi.' }, { status: 410 });
  }

  // Parse form data
  const formData = await request.formData();
  const myutUrl = formData.get('myutUrl');
  const imageFile = formData.get('image');

  if (!myutUrl || !imageFile) {
    return Response.json({ error: 'myutUrl atau gambar tidak ada.' }, { status: 400 });
  }

  // Validate myut URL
  if (!MYUT_URL_PATTERN.test(myutUrl)) {
    if (OLD_UT_QR_PATTERN.test(myutUrl)) {
      return Response.json({ error: 'Kode QR tersebut berasal dari kartu mahasiswa fisik, yang tidak didukung. Silakan unggah screenshot eKTM digital dari myut.ut.ac.id sebagai gantinya.' }, { status: 400 });
    }
    return Response.json({ error: 'URL myut tidak valid. Kode QR tidak berisi tautan myut.ut.ac.id yang valid.' }, { status: 400 });
  }

  // Check rate limit
  const rateLimit = await checkRateLimit(env.DB, session.discord_id);
  if (!rateLimit.allowed) {
    return Response.json({ error: rateLimit.message }, { status: 429 });
  }

  // Check if blocked by discord_id
  const isDiscordBlocked = await isBlocked(env.DB, session.discord_id, null);
  if (isDiscordBlocked) {
    return Response.json({ error: 'Akses ditolak. Akun Discord Anda diblokir oleh admin.' }, { status: 403 });
  }

  // Check if NIM already verified by different discord account
  const nimCheck = await env.DB.prepare(
    "SELECT discord_id FROM verify_attempts WHERE nim = (SELECT nim FROM verify_attempts WHERE myut_url = ? LIMIT 1) AND status = 'approved' AND discord_id != ? LIMIT 1"
  ).bind(myutUrl, session.discord_id).first();

  const imageBuffer = await imageFile.arrayBuffer();

  // Generate temp image ID
  const tempImageId = uuid();

  // Upload to temp R2
  await uploadToTemp(env.R2_TEMP, imageBuffer, tempImageId);

  try {
    // Fetch student data from myut API
    const studentData = await fetchStudentData(myutUrl);

    // Check NIM uniqueness
    const nimExists = await env.DB.prepare(
      "SELECT discord_id FROM verify_attempts WHERE nim = ? AND status = 'approved' AND discord_id != ? LIMIT 1"
    ).bind(studentData.nim, session.discord_id).first();

    if (nimExists) {
      // Save failed attempt
      await env.DB.prepare(
        "INSERT INTO verify_attempts (id, discord_id, discord_username, status, temp_image_id, nim, nama, study_program, ut_region, class_of, myut_url) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)"
      ).bind(uuid(), session.discord_id, session.discord_username, tempImageId, studentData.nim, studentData.nama, studentData.studyProgram, studentData.utRegion, studentData.classOf, myutUrl).run();

      return Response.json({ error: 'NIM ini sudah terhubung dengan akun terverifikasi lain.' }, { status: 409 });
    }

    // Check if blocked by NIM
    const isNimBlocked = await isBlocked(env.DB, null, studentData.nim);
    if (isNimBlocked) {
      // Save failed attempt
      await env.DB.prepare(
        "INSERT INTO verify_attempts (id, discord_id, discord_username, status, temp_image_id, nim, nama, study_program, ut_region, class_of, myut_url) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?)"
      ).bind(uuid(), session.discord_id, session.discord_username, tempImageId, studentData.nim, studentData.nama, studentData.studyProgram, studentData.utRegion, studentData.classOf, myutUrl).run();

      return Response.json({ error: 'Akses ditolak. NIM ini diblokir oleh admin.' }, { status: 403 });
    }

    // Upload to permanent R2
    const permKey = await uploadToPerm(env.R2_PERM, imageBuffer, studentData.nim);

    // Save approved attempt
    const attemptId = uuid();
    await env.DB.prepare(
      "INSERT INTO verify_attempts (id, discord_id, discord_username, status, temp_image_id, nim, nama, study_program, ut_region, class_of, myut_url, ektm_image_url, verified_at) VALUES (?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(attemptId, session.discord_id, session.discord_username, tempImageId, studentData.nim, studentData.nama, studentData.studyProgram, studentData.utRegion, studentData.classOf, myutUrl, permKey).run();

    // Mark session as used
    await env.DB.prepare("UPDATE sessions SET status = 'used' WHERE id = ?").bind(sessionId).run();

    // Assign role + send DM (fire and forget — don't block response)
    const token = env.DISCORD_BOT_TOKEN;
    const guildId = env.DISCORD_GUILD_ID;
    const roleId = env.VERIFIED_ROLE_ID;

    ctx.waitUntil(
      (async () => {
        await assignRole(guildId, session.discord_id, roleId, token);
        await assignMajorRoles(guildId, session.discord_id, studentData.studyProgram, token, env.DB);
        await sendDM(session.discord_id, `✓ Verifikasi Berhasil!

Selamat, ${studentData.nama}!

Anda telah terverifikasi sebagai mahasiswa Universitas Terbuka.

NIM: ${studentData.nim}
Program Studi: ${studentData.studyProgram}
UPBJJ: ${studentData.utRegion}
Masa Registrasi: ${studentData.classOf}

Role "Verified" telah diberikan. Selamat bergabung! 🎉`, token);
      })()
    );

    return Response.json({
      success: true,
      data: studentData,
    });

  } catch (error) {
    // Save failed attempt
    await env.DB.prepare(
      "INSERT INTO verify_attempts (id, discord_id, discord_username, status, temp_image_id, myut_url) VALUES (?, ?, ?, 'failed', ?, ?)"
    ).bind(uuid(), session.discord_id, session.discord_username, tempImageId, myutUrl).run();

    return Response.json({ error: `Gagal memverifikasi: ${error.message}` }, { status: 500 });
  }
}

async function handleRegisterCommands(request, env) {
  const commands = [
    { name: 'verify', description: 'Verifikasi identitas mahasiswa UT Anda' },
    { name: 'status', description: 'Cek status verifikasi Anda' },
  ];

  const res = await discordAPI(`/applications/${env.DISCORD_APPLICATION_ID}/commands`, 'PUT', env.DISCORD_BOT_TOKEN, commands);
  const data = await res.json();
  return Response.json(data);
}

// ── Verification page HTML ──

function getVerificationHTML(sessionId) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verifikasi Mahasiswa UT</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.container { max-width: 480px; width: 100%; padding: 24px; }
h1 { font-size: 1.5rem; margin-bottom: 8px; }
p { color: #aaa; margin-bottom: 24px; font-size: 0.9rem; line-height: 1.5; }
.upload-area { border: 2px dashed #444; border-radius: 12px; padding: 40px 20px; text-align: center; cursor: pointer; transition: border-color 0.2s; }
.upload-area:hover, .upload-area.dragover { border-color: #5865F2; }
.upload-area svg { width: 48px; height: 48px; margin-bottom: 12px; fill: #5865F2; }
.upload-area .label { font-size: 1rem; margin-bottom: 4px; }
.upload-area .hint { font-size: 0.8rem; color: #666; }
input[type="file"] { display: none; }
.btn { display: block; width: 100%; padding: 14px; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 16px; }
.btn-primary { background: #5865F2; color: #fff; }
.btn-primary:disabled { background: #333; color: #666; cursor: not-allowed; }
.status { margin-top: 20px; padding: 16px; border-radius: 8px; display: none; }
.status.success { display: block; background: #1a3a1a; border: 1px solid #2d5a2d; }
.status.error { display: block; background: #3a1a1a; border: 1px solid #5a2d2d; }
.status h3 { margin-bottom: 8px; }
.student-data { margin-top: 12px; }
.student-data div { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #333; font-size: 0.9rem; }
.student-data .label { color: #888; }
.preview { max-width: 200px; max-height: 200px; margin: 16px auto 0; border-radius: 8px; display: none; }
.loading { display: none; text-align: center; margin-top: 16px; }
.loading.show { display: block; }
.spinner { border: 3px solid #333; border-top: 3px solid #5865F2; border-radius: 50%; width: 32px; height: 32px; animation: spin 1s linear infinite; margin: 0 auto 8px; }
@keyframes spin { to { transform: rotate(360deg); } }
.status-success-welcome { margin-bottom: 16px; color: #eee; }
.status-success-footer { margin-top: 16px; color: #888; font-size: 0.85rem; }
</style>
</head>
<body>
<div class="container">
  <h1>Verifikasi Mahasiswa UT</h1>
  <p>Unggah screenshot eKTM digital Anda dari myut.ut.ac.id. Kode QR akan dibaca untuk memverifikasi identitas Anda.</p>

  <div class="upload-area" id="uploadArea">
    <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    <div class="label">Klik atau seret untuk mengunggah gambar eKTM</div>
    <div class="hint">Menerima PNG, JPG, atau WebP</div>
  </div>
  <input type="file" id="fileInput" accept="image/*">

  <img class="preview" id="preview" alt="Preview">

  <button class="btn btn-primary" id="verifyBtn" disabled>Verifikasi</button>

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <div>Memproses verifikasi...</div>
  </div>

  <div class="status" id="status"></div>
</div>

<script>
const sessionId = '${sessionId}';
const MYUT_PATTERN = /^https:\\/\\/myut\\.ut\\.ac\\.id\\/e\\/[a-f0-9]{32}$/;
const OLD_PATTERN = /^https?:\\/\\/webservice\\.ut\\.web\\.id\\/dp\\.php\\?id=\\d+$/;

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const preview = document.getElementById('preview');
const verifyBtn = document.getElementById('verifyBtn');
const loading = document.getElementById('loading');
const status = document.getElementById('status');

let myutUrl = null;
let webpBlob = null;

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

async function handleFile(file) {
  status.className = 'status';
  status.style.display = 'none';
  myutUrl = null;
  webpBlob = null;
  verifyBtn.disabled = true;

  // Show preview
  const img = new Image();
  img.onload = async () => {
    preview.src = img.src;
    preview.style.display = 'block';

    // Decode QR
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);

    if (!code) {
      showError('Tidak dapat membaca kode QR dari gambar. Pastikan kode QR terlihat jelas.');
      return;
    }

    const decoded = code.data.trim();

    if (MYUT_PATTERN.test(decoded)) {
      myutUrl = decoded;
    } else if (OLD_PATTERN.test(decoded)) {
      showError('Kode QR tersebut berasal dari kartu mahasiswa fisik, yang tidak didukung. Silakan unggah screenshot eKTM digital dari myut.ut.ac.id sebagai gantinya.');
      return;
    } else {
      showError('Kode QR tidak valid. Kode QR tidak berisi tautan myut.ut.ac.id yang valid.');
      return;
    }

    // Convert to WebP
    const maxSize = 1200;
    let w = img.width, h = img.height;
    if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; }

    const webpCanvas = document.createElement('canvas');
    webpCanvas.width = w;
    webpCanvas.height = h;
    const webpCtx = webpCanvas.getContext('2d');
    webpCtx.drawImage(img, 0, 0, w, h);

    webpCanvas.toBlob((blob) => {
      webpBlob = blob || new Blob([], { type: 'image/webp' });
      verifyBtn.disabled = false;
    }, 'image/webp', 0.7);
  };
  img.src = URL.createObjectURL(file);
}

verifyBtn.addEventListener('click', async () => {
  if (!myutUrl || !webpBlob) return;

  verifyBtn.disabled = true;
  loading.classList.add('show');
  status.className = 'status';
  status.style.display = 'none';

  const formData = new FormData();
  formData.append('myutUrl', myutUrl);
  formData.append('image', webpBlob, 'ektm.webp');

  try {
    const res = await fetch('/v/' + sessionId, { method: 'POST', body: formData });
    const data = await res.json();

    loading.classList.remove('show');

    if (data.success) {
      status.className = 'status success';
      status.style.display = 'block';
      status.innerHTML =
        '<h3>Verifikasi Berhasil! ✓</h3>' +
        '<p class="status-success-welcome">Selamat! Anda telah terverifikasi sebagai mahasiswa Universitas Terbuka.</p>' +
        '<div class="student-data">' +
        '<div><span class="label">NIM</span><span>' + data.data.nim + '</span></div>' +
        '<div><span class="label">Nama</span><span>' + data.data.nama + '</span></div>' +
        '<div><span class="label">Program Studi</span><span>' + data.data.studyProgram + '</span></div>' +
        '<div><span class="label">UPBJJ</span><span>' + data.data.utRegion + '</span></div>' +
        '<div><span class="label">Masa Registrasi</span><span>' + data.data.classOf + '</span></div>' +
        '</div>' +
        '<p class="status-success-footer">' +
        'Role "Verified" telah diberikan di Discord. ' +
        'Anda juga akan menerima DM konfirmasi dari bot. ' +
        'Selamat bergabung!</p>';
      uploadArea.style.display = 'none';
      preview.style.display = 'none';
      verifyBtn.style.display = 'none';
    } else {
      showError(data.error || 'Verifikasi gagal.');
    }
  } catch (e) {
    loading.classList.remove('show');
    showError('Terjadi kesalahan jaringan. Silakan coba lagi.');
  }
});

function showError(msg) {
  status.className = 'status error';
  status.style.display = 'block';
  status.innerHTML = '<h3>Verifikasi Gagal</h3><p>' + msg + '</p>';
  verifyBtn.disabled = false;
}
</script>
<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"></script>
</body>
</html>`;
}

// ── Admin auth helpers ──

const JWT_SECRET_KEY = 'JWT_SECRET'; // env key name

async function createAdminJWT(email, env) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ email, exp: Date.now() + 86400000 }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `${header}.${payload}.${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

async function verifyAdminJWT(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, data);
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp < Date.now()) return null;
    return payload.email;
  } catch { return null; }
}

async function isAdmin(email, db) {
  const admin = await db.prepare('SELECT email FROM admins WHERE email = ?').bind(email.toLowerCase()).first();
  return !!admin;
}

function getAdminToken(request) {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// ── Password hashing (PBKDF2) ──

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT_LEN = 16;
const PBKDF2_KEY_LEN = 32;

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0)).buffer;
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return toBase64(hashBuffer);
}

const TOKEN_EXPIRE_HOURS = 24;
const MAILGUN_DOMAIN = 'mg.kris.my.id';
const MAILGUN_API_BASE = 'https://api.eu.mailgun.net/v3';
const MAIL_FROM = 'lexcriminalis@mg.kris.my.id';

async function sendMail(env, to, subject, html, text) {
  const apiKey = env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.log('[Mailgun] Error: MAILGUN_API_KEY not configured');
    return { ok: false, error: 'MAILGUN_API_KEY not configured' };
  }

  const formData = new FormData();
  formData.append('from', MAIL_FROM);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);
  formData.append('text', text);

  const url = `${MAILGUN_API_BASE}/${MAILGUN_DOMAIN}/messages`;
  const credentials = btoa(`api:${apiKey}`);

  console.log(`[Mailgun] Sending to ${to}, URL: ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
    },
    body: formData,
  });

  console.log(`[Mailgun] Response status: ${res.status}`);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log(`[Mailgun] Error response: ${errText}`);
    return { ok: false, error: `Mailgun API ${res.status}: ${errText}` };
  }

  const responseBody = await res.text().catch(() => '');
  console.log(`[Mailgun] Success response: ${responseBody}`);

  return { ok: true };
}

async function generateAdminToken(db, adminEmail, tokenType) {
  const rawTokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = toHex(rawTokenBytes);
  const tokenHash = await sha256(rawToken);

  const id = uuid();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRE_HOURS * 60 * 60 * 1000).toISOString();

  await db.prepare(
    'INSERT INTO admin_tokens (id, admin_email, token_hash, token_type, used, expires_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).bind(id, adminEmail, tokenHash, tokenType, expiresAt).run();

  return rawToken;
}

async function redeemAdminToken(db, rawToken) {
  const tokenHash = await sha256(rawToken);

  const token = await db.prepare(
    "SELECT id, admin_email, token_type, used, expires_at FROM admin_tokens WHERE token_hash = ? AND used = 0 AND datetime('now') < datetime(expires_at) LIMIT 1"
  ).bind(tokenHash).first();

  if (!token) return null;

  await db.prepare("UPDATE admin_tokens SET used = 1 WHERE id = ?").bind(token.id).run();

  return { adminEmail: token.admin_email, tokenType: token.token_type };
}

function makeEmailHtml(heading, message, link, buttonText) {
  return `<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; padding: 40px 20px;">
  <div style="max-width: 480px; background: #fff; padding: 40px; border-radius: 12px; margin: 0 auto;">
    <h2 style="margin: 0 0 16px 0; font-size: 1.4rem; color: #18181b;">${heading}</h2>
    <p style="margin: 0 0 24px 0; color: #52525b; line-height: 1.5;">${message}</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${link}" style="display: inline-block; padding: 14px 32px; background: #5865F2; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">${buttonText}</a>
    </div>
    <p style="margin: 16px 0 0 0; color: #a1a1aa; font-size: 0.85rem; line-height: 1.4;">
      Or copy and paste this link:<br>
      <span style="word-break: break-all;">${link}</span>
    </p>
    <p style="margin: 24px 0 0 0; color: #a1a1aa; font-size: 0.8rem;">
      This link expires in ${TOKEN_EXPIRE_HOURS} hours.<br>
      Lex Studyhub Admin
    </p>
  </div>
</body></html>`;
}

function makeEmailText(heading, message, link, buttonText) {
  return `${heading}

${message}

${buttonText}: ${link}

This link expires in ${TOKEN_EXPIRE_HOURS} hours.

Lex Studyhub Admin
`;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LEN));
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    passwordKey, PBKDF2_KEY_LEN * 8
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toBase64(salt)}:${toBase64(hashBuffer)}`;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1]);
  const salt = fromBase64(parts[2]);
  const expectedHash = fromBase64(parts[3]);
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password),
    { name: 'PBKDF2' }, false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    passwordKey, PBKDF2_KEY_LEN * 8
  );
  const a = new Uint8Array(hashBuffer);
  const b = new Uint8Array(expectedHash);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Admin route handlers ──

async function handleAdminLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return Response.json({ error: 'Email and password required' }, { status: 400 });

  const normalized = email.toLowerCase().trim();
  const admin = await env.DB.prepare(
    'SELECT password_hash FROM admins WHERE email = ?'
  ).bind(normalized).first();

  if (!admin) {
    return Response.json({ error: 'Invalid credentials' }, { status: 403 });
  }

  if (!admin.password_hash) {
    return Response.json({ error: 'Password not set for this admin. Contact the administrator.' }, { status: 403 });
  }

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) {
    return Response.json({ error: 'Invalid credentials' }, { status: 403 });
  }

  const token = await createAdminJWT(normalized, env);
  return Response.json({ token });
}

async function handleAdminHashPassword(request, env) {
  const url = new URL(request.url);
  const password = url.searchParams.get('pwd');
  if (!password) return Response.json({ error: 'pwd parameter required' }, { status: 400 });
  const hash = await hashPassword(password);
  return Response.json({ hash });
}

async function handleAdminChangePassword(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { currentPassword, newPassword } = await request.json();
  if (!currentPassword || !newPassword) {
    return Response.json({ error: 'currentPassword and newPassword required' }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return Response.json({ error: 'New password must be at least 8 characters' }, { status: 400 });
  }

  const admin = await env.DB.prepare(
    'SELECT password_hash FROM admins WHERE email = ?'
  ).bind(email).first();

  if (admin.password_hash) {
    const valid = await verifyPassword(currentPassword, admin.password_hash);
    if (!valid) {
      return Response.json({ error: 'Current password is incorrect' }, { status: 403 });
    }
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE admins SET password_hash = ? WHERE email = ?'
  ).bind(newHash, email).run();

  return Response.json({ success: true });
}

async function handleAdminMe(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json({ email });
}

async function handleAdminListAdmins(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { results } = await env.DB.prepare('SELECT email, invited_by, created_at FROM admins ORDER BY created_at').all();
  return Response.json({ admins: results });
}

async function handleAdminInviteAdmin(request, env, ctx) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { inviteEmail } = await request.json();
  if (!inviteEmail) return Response.json({ error: 'Email required' }, { status: 400 });

  const normalized = inviteEmail.toLowerCase().trim();
  const existing = await env.DB.prepare('SELECT email FROM admins WHERE email = ?').bind(normalized).first();
  if (existing) return Response.json({ error: 'Already an admin' }, { status: 409 });

  await env.DB.prepare('INSERT INTO admins (id, email, invited_by) VALUES (?, ?, ?)').bind(uuid(), normalized, email).run();

  const token = await generateAdminToken(env.DB, normalized, 'invite');
  const reqUrl = new URL(request.url);
  const setPasswordUrl = `${reqUrl.protocol}//${reqUrl.host}/admin/set-password?token=${token}`;

  const subject = 'You\'ve been invited as an admin';
  const heading = 'You\'re invited!';
  const message = `You've been invited to administer the UT Verification Discord bot. Click the button below to set your password.`;
  const buttonText = 'Set Your Password';
  const html = makeEmailHtml(heading, message, setPasswordUrl, buttonText);
  const text = makeEmailText(heading, message, setPasswordUrl, buttonText);

  const mailResult = await sendMail(env, normalized, subject, html, text);

  return Response.json({
    success: true,
    email: normalized,
    emailSent: mailResult.ok,
    emailError: mailResult.error || null,
  });
}

async function handleAdminForgotPassword(request, env) {
  const { email } = await request.json();
  if (!email) return Response.json({ error: 'Email required' }, { status: 400 });

  const normalized = email.toLowerCase().trim();
  const admin = await env.DB.prepare('SELECT email FROM admins WHERE email = ?').bind(normalized).first();

  if (!admin) {
    return Response.json({ success: true, emailSent: false, reason: 'No such admin' });
  }

  const token = await generateAdminToken(env.DB, normalized, 'reset');
  const reqUrl = new URL(request.url);
  const resetUrl = `${reqUrl.protocol}//${reqUrl.host}/admin/set-password?token=${token}`;

  const subject = 'Reset your admin password';
  const heading = 'Password Reset';
  const message = 'Click the button below to reset your admin password. If you didn\'t request this, you can safely ignore this email.';
  const buttonText = 'Reset Password';
  const html = makeEmailHtml(heading, message, resetUrl, buttonText);
  const text = makeEmailText(heading, message, resetUrl, buttonText);

  const mailResult = await sendMail(env, normalized, subject, html, text);

  return Response.json({
    success: true,
    emailSent: mailResult.ok,
    emailError: mailResult.error || null,
  });
}

async function handleAdminSetPasswordPage(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response('Invalid or missing token.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  const html = getSetPasswordHTML(token);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleAdminSetPassword(request, env) {
  const { token, newPassword } = await request.json();
  if (!token || !newPassword) {
    return Response.json({ error: 'Token and newPassword required' }, { status: 400 });
  }

  if (newPassword.length < 8) {
    return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }

  const redemption = await redeemAdminToken(env.DB, token);
  if (!redemption) {
    return Response.json({ error: 'Invalid or expired token' }, { status: 400 });
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare(
    'UPDATE admins SET password_hash = ? WHERE email = ?'
  ).bind(newHash, redemption.adminEmail).run();

  return Response.json({ success: true, tokenType: redemption.tokenType });
}

function getSetPasswordHTML(token) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Set Admin Password</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#eee;min-height:100vh;display:flex;align-items:center;justify-content:center}
.login{max-width:400px;padding:32px;background:#1a1a2e;border-radius:12px;text-align:center}
.login h2{margin-bottom:8px}
.login p{color:#888;font-size:0.9rem;margin-bottom:20px}
.login input{width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:1rem;margin-bottom:12px}
.login button{width:100%;padding:12px;background:#5865F2;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
.login button:disabled{background:#333;color:#666;cursor:not-allowed}
.login .error{color:#f44;margin-top:12px;font-size:0.9rem;display:none}
.login .success{color:#4a4;margin-top:12px;font-size:0.9rem;display:none}
.login .link{margin-top:16px}
.login .link a{color:#5865F2;text-decoration:none}
</style>
</head>
<body>

<div class="login" id="setPasswordPage">
  <h2>Set Your Password</h2>
  <p>Choose a new password for your admin account.</p>
  <input type="password" id="newPwd" placeholder="New Password (min 8 chars)">
  <input type="password" id="confirmPwd" placeholder="Confirm New Password">
  <button id="setPwdBtn" onclick="doSetPassword()">Set Password</button>
  <div class="error" id="pwdError"></div>
  <div class="success" id="pwdSuccess"></div>
  <div class="link" id="loginLink" style="display:none">
    <a href="/admin">← Back to Login</a>
  </div>
</div>

<script>
const token = '${token.replace(/'/g, "\\'")}';

async function doSetPassword() {
  const newPwd = document.getElementById('newPwd').value;
  const confirmPwd = document.getElementById('confirmPwd').value;
  const errEl = document.getElementById('pwdError');
  const okEl = document.getElementById('pwdSuccess');
  const btn = document.getElementById('setPwdBtn');

  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if (!newPwd || !confirmPwd) {
    errEl.textContent = 'Please fill in both password fields.';
    errEl.style.display = 'block';
    return;
  }

  if (newPwd.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters.';
    errEl.style.display = 'block';
    return;
  }

  if (newPwd !== confirmPwd) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled = true;

  try {
    const res = await fetch('/admin/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: newPwd })
    });
    const data = await res.json();

    if (data.success) {
      okEl.textContent = 'Password set successfully!';
      okEl.style.display = 'block';
      document.getElementById('setPwdBtn').style.display = 'none';
      document.getElementById('newPwd').style.display = 'none';
      document.getElementById('confirmPwd').style.display = 'none';
      document.getElementById('loginLink').style.display = 'block';
    } else {
      errEl.textContent = data.error || 'Failed to set password.';
      errEl.style.display = 'block';
      btn.disabled = false;
    }
  } catch (e) {
    errEl.textContent = 'Network error.';
    errEl.style.display = 'block';
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;
}

async function handleAdminDeleteAdmin(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { deleteEmail } = await request.json();
  if (!deleteEmail) return Response.json({ error: 'Email required' }, { status: 400 });

  const normalized = deleteEmail.toLowerCase().trim();
  if (normalized === email) return Response.json({ error: 'Cannot delete yourself' }, { status: 400 });
  if (normalized === 'krismyid@gmail.com') return Response.json({ error: 'Cannot delete default admin' }, { status: 400 });

  const result = await env.DB.prepare('DELETE FROM admins WHERE email = ?').bind(normalized).run();
  if (!result.meta.changes) return Response.json({ error: 'Admin not found' }, { status: 404 });
  return Response.json({ success: true });
}

async function handleAdminListAttempts(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const search = url.searchParams.get('search') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const perPage = Math.min(200, Math.max(10, parseInt(url.searchParams.get('perPage') || '50')));

  // Build WHERE clause
  const whereParts = [];
  const whereBindings = [];

  if (filter === 'mtd') {
    whereParts.push("verified_at >= datetime('now', 'start of month')");
  } else if (filter === 'month') {
    whereParts.push("verified_at >= datetime('now', '-30 days')");
  } else if (filter === 'year') {
    whereParts.push("verified_at >= datetime('now', '-365 days')");
  }

  if (search.trim()) {
    const pattern = '%' + search.trim() + '%';
    whereParts.push('(nama LIKE ? OR discord_username LIKE ? OR nim LIKE ? OR discord_id = ?)');
    whereBindings.push(pattern, pattern, pattern, search.trim());
  }

  let whereClause = '';
  if (whereParts.length > 0) {
    whereClause = 'WHERE ' + whereParts.join(' AND ');
  }

  // Count total first
  const countQuery = `SELECT COUNT(*) as total FROM verify_attempts ${whereClause}`;
  const { results: countResults } = await env.DB.prepare(countQuery).bind(...whereBindings).all();
  const total = countResults[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const actualPage = Math.min(page, totalPages);
  const offset = (actualPage - 1) * perPage;

  // Get paginated results
  const { results } = await env.DB.prepare(
    `SELECT id, discord_id, discord_username, status, nim, nama, study_program, ut_region, class_of, myut_url, temp_image_id, ektm_image_url, created_at, verified_at
     FROM verify_attempts ${whereClause}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...whereBindings, perPage, offset).all();

  // Get all active blocks and build lookup sets
  const { results: blocks } = await env.DB.prepare(
    `SELECT discord_id, nim FROM blocked_members WHERE expires_at IS NULL OR datetime('now') < datetime(expires_at)`
  ).all();

  const blockedDiscordIds = new Set();
  const blockedNims = new Set();
  for (const b of blocks) {
    if (b.discord_id) blockedDiscordIds.add(b.discord_id);
    if (b.nim) blockedNims.add(b.nim);
  }

  // Augment each attempt
  const attempts = results.map(a => ({
    ...a,
    is_blocked: (a.discord_id && blockedDiscordIds.has(a.discord_id)) || (a.nim && blockedNims.has(a.nim)),
  }));

  return Response.json({
    attempts,
    pagination: {
      page: actualPage,
      perPage,
      total,
      totalPages,
    }
  });
}

async function handleAdminExportExcel(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  let whereClause = '';

  if (filter === 'mtd') {
    whereClause = "WHERE verified_at >= datetime('now', 'start of month')";
  } else if (filter === 'month') {
    whereClause = "WHERE verified_at >= datetime('now', '-30 days')";
  } else if (filter === 'year') {
    whereClause = "WHERE verified_at >= datetime('now', '-365 days')";
  }

  const { results } = await env.DB.prepare(
    `SELECT discord_id, discord_username, status, nim, nama, study_program, ut_region, class_of, myut_url, created_at, verified_at FROM verify_attempts ${whereClause} ORDER BY created_at DESC`
  ).all();

  const headers = ['Discord ID', 'Discord Username', 'Status', 'NIM', 'Nama', 'Study Program', 'UT Region', 'Class Of', 'MyUT URL', 'Created At', 'Verified At'];
  const data = [headers, ...results.map(r => [r.discord_id || '', r.discord_username || '', r.status || '', r.nim || '', r.nama || '', r.study_program || '', r.ut_region || '', r.class_of || '', r.myut_url || '', r.created_at || '', r.verified_at || ''])];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Verify Attempts');

  const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  return new Response(xlsxBuffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="verify-export-${filter}.xlsx"`,
    },
  });
}

async function handleAdminSignedImageUrl(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return Response.json({ error: 'key parameter required' }, { status: 400 });

  // Get the object from R2 permanent bucket
  const object = await env.R2_PERM.get(key);
  if (!object) return Response.json({ error: 'Image not found' }, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/webp');
  headers.set('Cache-Control', 'private, max-age=300');

  return new Response(object.body, { headers });
}

// ── Major-role mapping handlers ──

async function assignMajorRoles(guildId, discordId, studyProgram, token, db) {
  if (!studyProgram) return;
  const { results } = await db.prepare(
    'SELECT mt.discord_role_id FROM major_tag_members mtm JOIN major_tags mt ON mtm.tag_id = mt.id WHERE mtm.study_program = ?'
  ).bind(studyProgram).all();
  for (const row of results) {
    await assignRole(guildId, discordId, row.discord_role_id, token);
  }
}

async function handleAdminListMajorTags(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const [tagsResult, membersResult] = await Promise.all([
    env.DB.prepare('SELECT id, name, discord_role_id, created_at FROM major_tags ORDER BY created_at').all(),
    env.DB.prepare('SELECT tag_id, study_program FROM major_tag_members').all(),
  ]);
  const tags = tagsResult.results;
  const members = membersResult.results;

  const tagMap = {};
  for (const t of tags) {
    tagMap[t.id] = { ...t, members: [] };
  }
  for (const m of members) {
    if (tagMap[m.tag_id]) tagMap[m.tag_id].members.push(m.study_program);
  }

  return Response.json({ tags: Object.values(tagMap) });
}

async function handleAdminCreateMajorTag(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, discordRoleId } = await request.json();
  if (!name || !discordRoleId) return Response.json({ error: 'name and discordRoleId required' }, { status: 400 });

  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO major_tags (id, name, discord_role_id) VALUES (?, ?, ?)'
  ).bind(id, name, discordRoleId).run();

  return Response.json({ success: true, id, name, discordRoleId });
}

async function handleAdminDeleteMajorTag(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await request.json();
  if (!id) return Response.json({ error: 'id required' }, { status: 400 });

  // D1 doesn't enforce FOREIGN KEY ON DELETE CASCADE, so delete members manually
  await env.DB.prepare('DELETE FROM major_tag_members WHERE tag_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM major_tags WHERE id = ?').bind(id).run();

  return Response.json({ success: true });
}

async function handleAdminAddMajorMember(request, env, ctx) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { tagId, studyProgram } = await request.json();
  if (!tagId || !studyProgram) return Response.json({ error: 'tagId and studyProgram required' }, { status: 400 });

  const tag = await env.DB.prepare('SELECT discord_role_id FROM major_tags WHERE id = ?').bind(tagId).first();
  if (!tag) return Response.json({ error: 'Tag not found' }, { status: 404 });

  await env.DB.prepare(
    'INSERT OR IGNORE INTO major_tag_members (tag_id, study_program) VALUES (?, ?)'
  ).bind(tagId, studyProgram).run();

  // Retroactive role assignment
  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const roleId = tag.discord_role_id;

  ctx.waitUntil(
    (async () => {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT discord_id FROM verify_attempts WHERE study_program = ? AND status = 'approved'"
      ).bind(studyProgram).all();
      for (const row of results) {
        await assignRole(guildId, row.discord_id, roleId, token);
      }
    })()
  );

  return Response.json({ success: true });
}

async function handleAdminRemoveMajorMember(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { tagId, studyProgram } = await request.json();
  if (!tagId || !studyProgram) return Response.json({ error: 'tagId and studyProgram required' }, { status: 400 });

  await env.DB.prepare(
    'DELETE FROM major_tag_members WHERE tag_id = ? AND study_program = ?'
  ).bind(tagId, studyProgram).run();

  return Response.json({ success: true });
}

async function handleAdminUnmappedMajors(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { results } = await env.DB.prepare(
    "SELECT study_program, COUNT(*) as count FROM verify_attempts WHERE study_program IS NOT NULL AND status = 'approved' AND study_program NOT IN (SELECT study_program FROM major_tag_members) GROUP BY study_program ORDER BY count DESC"
  ).all();

  return Response.json({ majors: results });
}

// ── Member management (Drop, Block, Unblock) ──

async function isBlocked(db, discordId, nim) {
  const conditions = [];
  const bindings = [];

  if (discordId) {
    conditions.push('discord_id = ?');
    bindings.push(discordId);
  }
  if (nim) {
    conditions.push('nim = ?');
    bindings.push(nim);
  }

  if (!conditions.length) return false;

  const where = `(${conditions.join(' OR ')}) AND (expires_at IS NULL OR datetime('now') < datetime(expires_at))`;
  const query = `SELECT id FROM blocked_members WHERE ${where} LIMIT 1`;

  const { results } = await db.prepare(query).bind(...bindings).all();
  return results.length > 0;
}

async function handleAdminDropMember(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { discordId } = await request.json();
  if (!discordId) return Response.json({ error: 'discordId required' }, { status: 400 });

  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const verifiedRoleId = env.VERIFIED_ROLE_ID;

  const rolesToRemove = await getRolesToRemove(env.DB, discordId, verifiedRoleId);
  await removeAllMemberRoles(guildId, discordId, rolesToRemove, token);

  return Response.json({ success: true, discordId, rolesRemoved: rolesToRemove.length });
}

async function handleAdminBlockMember(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { discordId, nim, durationDays, alsoDrop, reason } = await request.json();
  if (!discordId && !nim) return Response.json({ error: 'At least one of discordId or nim required' }, { status: 400 });

  // Optional: drop roles first
  let dropResult = null;
  if (alsoDrop && discordId) {
    const token = env.DISCORD_BOT_TOKEN;
    const guildId = env.DISCORD_GUILD_ID;
    const verifiedRoleId = env.VERIFIED_ROLE_ID;

    const rolesToRemove = await getRolesToRemove(env.DB, discordId, verifiedRoleId);
    await removeAllMemberRoles(guildId, discordId, rolesToRemove, token);
    dropResult = { rolesRemoved: rolesToRemove.length };
  }

  // Calculate expires_at
  let expiresAt = null;
  const actualDurationDays = durationDays || 0;
  if (actualDurationDays > 0) {
    expiresAt = new Date(Date.now() + actualDurationDays * 24 * 60 * 60 * 1000).toISOString();
  }

  // Insert block entry
  await env.DB.prepare(
    `INSERT INTO blocked_members (id, discord_id, nim, reason, expires_at, blocked_by_email)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    uuid(),
    discordId || null,
    nim || null,
    reason || null,
    expiresAt,
    email
  ).run();

  return Response.json({
    success: true,
    discordId: discordId || null,
    nim: nim || null,
    durationDays: actualDurationDays,
    dropResult,
  });
}

async function handleAdminUnblockMember(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { discordId, nim } = await request.json();
  if (!discordId && !nim) return Response.json({ error: 'At least one of discordId or nim required' }, { status: 400 });

  // Find and mark as expired OR delete
  // Simpler: delete any matching active block entries
  const conditions = [];
  const bindings = [];

  if (discordId) {
    conditions.push('discord_id = ?');
    bindings.push(discordId);
  }
  if (nim) {
    conditions.push('nim = ?');
    bindings.push(nim);
  }

  const where = `(${conditions.join(' OR ')}) AND (expires_at IS NULL OR datetime('now') < datetime(expires_at))`;

  const result = await env.DB.prepare(`DELETE FROM blocked_members WHERE ${where}`).bind(...bindings).run();

  return Response.json({
    success: true,
    entriesRemoved: result.meta.changes,
  });
}

async function handleAdminListBlocked(request, env) {
  const email = await verifyAdminJWT(getAdminToken(request), env);
  if (!email) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { results } = await env.DB.prepare(
    `SELECT id, discord_id, nim, reason, blocked_at, expires_at, blocked_by_email,
            CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END as is_permanent,
            CASE WHEN expires_at IS NOT NULL AND datetime('now') >= datetime(expires_at) THEN 1 ELSE 0 END as is_expired
     FROM blocked_members
     ORDER BY blocked_at DESC
     LIMIT 500`
  ).all();

  return Response.json({ blocked: results });
}

// ── Admin dashboard HTML ──

function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UT Verify Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f1a;color:#eee;min-height:100vh}
.nav{background:#1a1a2e;padding:16px 24px;display:flex;align-items:center;gap:16px;border-bottom:1px solid #2a2a4a}
.nav h1{font-size:1.1rem;font-weight:600}
.nav .email{margin-left:auto;color:#888;font-size:0.85rem}
.nav button{background:#333;border:none;color:#ccc;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.85rem}
.nav button:hover{background:#444}
.main{max-width:1200px;margin:0 auto;padding:24px}
.login{max-width:400px;margin:100px auto;padding:32px;background:#1a1a2e;border-radius:12px;text-align:center}
.login h2{margin-bottom:8px}
.login p{color:#888;font-size:0.9rem;margin-bottom:20px}
.login input{width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:1rem;margin-bottom:12px}
.login button{width:100%;padding:12px;background:#5865F2;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
.login .error{color:#f44;margin-top:12px;font-size:0.9rem;display:none}
.login .success{color:#4a4;margin-top:12px;font-size:0.9rem;display:none}
.tabs{display:flex;gap:8px;margin-bottom:24px}
.tab{padding:8px 16px;border:1px solid #333;border-radius:8px;cursor:pointer;font-size:0.9rem;background:transparent;color:#aaa}
.tab.active{background:#5865F2;color:#fff;border-color:#5865F2}
.panel{display:none}
.panel.active{display:block}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter{padding:6px 14px;border:1px solid #333;border-radius:6px;cursor:pointer;font-size:0.85rem;background:transparent;color:#aaa}
.filter.active{background:#2d2d5a;color:#eee;border-color:#5865F2}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #1a1a2e}
th{color:#888;font-weight:500;position:sticky;top:0;background:#0f0f1a}
tr:hover{background:#1a1a2e}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600}
.badge.approved{background:#1a3a1a;color:#4a4}
.badge.failed{background:#3a1a1a;color:#a44}
.badge.expired{background:#2a2a1a;color:#aa4}
.view-btn{background:transparent;border:1px solid #5865F2;color:#5865F2;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem}
.view-btn:hover{background:#5865F2;color:#fff}
.export-btn{padding:8px 16px;background:#2d5a2d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;margin-left:auto}
.export-btn:hover{background:#3a7a3a}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px}
.admin-card{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1a1a2e;border-radius:8px;margin-bottom:8px}
.admin-card .email{font-size:0.95rem}
.admin-card .meta{color:#666;font-size:0.8rem}
.admin-card .del-btn{background:transparent;border:1px solid #a44;color:#a44;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem}
.admin-card .del-btn:hover{background:#a44;color:#fff}
.admin-card .del-btn:disabled{opacity:0.3;cursor:not-allowed}
.invite-row{display:flex;gap:8px;margin-bottom:16px}
.invite-row input{flex:1;padding:10px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:0.9rem}
.invite-row button{padding:10px 20px;background:#5865F2;color:#fff;border:none;border-radius:8px;cursor:pointer}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:100;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#1a1a2e;padding:24px;border-radius:12px;max-width:500px;width:90%}
.modal img{width:100%;border-radius:8px}
.modal .close{background:transparent;border:none;color:#888;font-size:1.5rem;cursor:pointer;float:right}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.stat{background:#1a1a2e;padding:16px;border-radius:8px;text-align:center}
.stat .num{font-size:1.8rem;font-weight:700;color:#5865F2}
.stat .lbl{font-size:0.8rem;color:#888;margin-top:4px}
.tag-card{background:#1a1a2e;padding:16px;border-radius:8px;margin-bottom:12px}
.tag-card .tag-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.tag-card .tag-name{font-size:1.05rem;font-weight:600}
.tag-card .tag-role{color:#5865F2;font-size:0.85rem;margin-top:2px}
.tag-card .del-tag-btn{background:transparent;border:1px solid #a44;color:#a44;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem}
.tag-card .del-tag-btn:hover{background:#a44;color:#fff}
.tag-card .member{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:#0f0f1a;border-radius:4px;margin-bottom:4px;font-size:0.85rem}
.tag-card .member .remove-member{background:transparent;border:1px solid #666;color:#888;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:0.75rem}
.tag-card .member .remove-member:hover{border-color:#a44;color:#a44}
.add-member-row{display:flex;gap:6px;margin-top:10px}
.add-member-row input{flex:1;padding:8px;border:1px solid #333;border-radius:6px;background:#0f0f1a;color:#eee;font-size:0.85rem}
.add-member-row button{padding:8px 14px;background:#5865F2;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem}
.create-tag-form{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.create-tag-form input{flex:1;min-width:150px;padding:10px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:0.9rem}
.create-tag-form button{padding:10px 20px;background:#5865F2;color:#fff;border:none;border-radius:8px;cursor:pointer}
.unmapped-section{margin-top:24px}
.unmapped-section h3{font-size:1rem;margin-bottom:12px;color:#aaa}
.unmapped-item{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#1a1a2e;border-radius:6px;margin-bottom:6px;font-size:0.9rem}
.unmapped-item .major-name{flex:1}
.unmapped-item .major-count{color:#888;font-size:0.8rem;margin-left:8px;margin-right:12px}
.unmapped-item select{padding:4px 8px;border:1px solid #333;border-radius:4px;background:#0f0f1a;color:#eee;font-size:0.8rem;margin-right:6px}
.unmapped-item .assign-btn{background:#2d5a2d;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.8rem}
.unmapped-item .assign-btn:hover{background:#3a7a3a}
.unmapped-item .assign-btn:disabled{opacity:0.3;cursor:not-allowed}
</style>
</head>
<body>

<div class="login" id="loginPage">
  <div id="loginForm">
    <h2>Admin Login</h2>
    <p>Enter your admin credentials</p>
    <input type="email" id="loginEmail" placeholder="admin@example.com">
    <input type="password" id="loginPassword" placeholder="Password">
    <button onclick="doLogin()">Login</button>
    <div style="margin-top:16px">
      <a href="#" onclick="toggleForgotPassword(); return false;" style="color:#5865F2;text-decoration:none;font-size:0.85rem">Forgot Password?</a>
    </div>
    <div class="error" id="loginError"></div>
  </div>
  <div id="forgotPasswordForm" style="display:none">
    <h2>Reset Password</h2>
    <p style="margin-bottom:16px">Enter your email address and we'll send you a link to reset your password.</p>
    <input type="email" id="forgotEmail" placeholder="admin@example.com">
    <button onclick="doForgotPassword()">Send Reset Link</button>
    <div style="margin-top:16px">
      <a href="#" onclick="toggleForgotPassword(); return false;" style="color:#5865F2;text-decoration:none;font-size:0.85rem">← Back to Login</a>
    </div>
    <div class="error" id="forgotError"></div>
    <div class="success" id="forgotSuccess" style="margin-top:12px;color:#4a4;display:none"></div>
  </div>
</div>

<div id="appPage" style="display:none">
  <div class="nav">
    <h1>UT Verify Admin</h1>
    <span class="email" id="adminEmail"></span>
    <button onclick="doLogout()">Logout</button>
  </div>
  <div class="main">
    <div class="tabs">
      <div class="tab active" data-tab="dashboard" onclick="switchTab(this)">Dashboard</div>
      <div class="tab" data-tab="attempts" onclick="switchTab(this)">Verify Attempts</div>
      <div class="tab" data-tab="admins" onclick="switchTab(this)">Admins</div>
      <div class="tab" data-tab="password" onclick="switchTab(this)">Change Password</div>
      <div class="tab" data-tab="majors" onclick="switchTab(this)">Major Roles</div>
    </div>

    <div class="panel active" id="panel-dashboard">
      <div class="stats" id="statsGrid"></div>
    </div>

    <div class="panel" id="panel-attempts">
      <div class="toolbar">
        <div class="filters">
          <div class="filter active" data-filter="all" onclick="setFilter(this)">All</div>
          <div class="filter" data-filter="mtd" onclick="setFilter(this)">Month-to-Date</div>
          <div class="filter" data-filter="month" onclick="setFilter(this)">Last 30 Days</div>
          <div class="filter" data-filter="year" onclick="setFilter(this)">Last Year</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="searchInput" placeholder="Search by name, Discord, or NIM..." style="padding:8px 12px;border:1px solid #333;border-radius:6px;background:#0f0f1a;color:#eee;font-size:0.9rem;width:280px" onkeydown="if(event.key==='Enter')doSearch()">
          <button class="export-btn" onclick="doSearch()">Search</button>
          <button class="export-btn" data-action="export">Export</button>
        </div>
      </div>
      <table>
        <thead><tr><th>NIM</th><th>Nama</th><th>Study Program</th><th>Discord</th><th>Status</th><th>Verified At</th><th>eKTM</th><th>Actions</th></tr></thead>
        <tbody id="attemptsBody"></tbody>
      </table>
      <div id="pagination" style="margin-top:16px;display:flex;gap:12px;align-items:center;justify-content:space-between;color:#888;font-size:0.9rem">
        <div id="pageInfo">Page 1 of 1</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="view-btn" onclick="goToPage(currentPage-1)" disabled id="prevBtn">Prev</button>
          <div id="pageNumbers" style="display:flex;gap:4px"></div>
          <button class="view-btn" onclick="goToPage(currentPage+1)" disabled id="nextBtn">Next</button>
          <span style="margin-left:8px">Go to:</span>
          <input type="number" id="jumpToPage" min="1" style="width:60px;padding:4px 8px;border:1px solid #333;border-radius:4px;background:#0f0f1a;color:#eee;text-align:center">
          <button class="view-btn" onclick="goToPage(parseInt(document.getElementById('jumpToPage').value))">Go</button>
        </div>
      </div>
    </div>

    <div class="panel" id="panel-admins">
      <div class="invite-row">
        <input type="email" id="inviteEmail" placeholder="Email to invite">
        <button onclick="inviteAdmin()">Invite</button>
      </div>
      <div id="adminsList"></div>
    </div>

    <div class="panel" id="panel-password">
      <div style="max-width:400px">
        <p style="color:#888;margin-bottom:16px;font-size:0.9rem">Change your admin account password.</p>
        <div style="margin-bottom:12px">
          <input type="password" id="currentPwd" placeholder="Current Password" style="width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:1rem;margin-bottom:12px">
        </div>
        <div style="margin-bottom:12px">
          <input type="password" id="newPwd" placeholder="New Password (min 8 chars)" style="width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:1rem;margin-bottom:12px">
        </div>
        <div style="margin-bottom:16px">
          <input type="password" id="confirmPwd" placeholder="Confirm New Password" style="width:100%;padding:12px;border:1px solid #333;border-radius:8px;background:#0f0f1a;color:#eee;font-size:1rem">
        </div>
        <button onclick="changePassword()" class="btn" style="width:100%;padding:12px;background:#5865F2;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer">Update Password</button>
        <div id="pwdStatus" style="margin-top:16px;padding:12px;border-radius:8px;display:none"></div>
      </div>
    </div>

    <div class="panel" id="panel-majors">
      <h3 style="margin-bottom:12px;font-size:1rem">Create Tag</h3>
      <div class="create-tag-form">
        <input type="text" id="tagName" placeholder="Tag name (e.g. Sistem Informasi)">
        <input type="text" id="tagRoleId" placeholder="Discord Role ID">
        <button onclick="createMajorTag()">Create</button>
      </div>
      <h3 style="margin-bottom:12px;font-size:1rem">Tags</h3>
      <div id="majorTagsList"></div>
      <div class="unmapped-section">
        <h3>Discovered Majors (unassigned)</h3>
        <div id="unmappedMajorsList"></div>
      </div>
    </div>
  </div>
</div>

<div class="modal-overlay" id="imageModal" onclick="this.classList.remove('show')">
  <div class="modal">
    <button class="close" onclick="document.getElementById('imageModal').classList.remove('show')">&times;</button>
    <img id="modalImage" alt="eKTM">
  </div>
</div>

<script>
let token = localStorage.getItem('admin_token');
let currentFilter = 'all';
let currentPage = 1;
let currentSearch = '';

// Delegated click handlers for dynamic buttons
document.addEventListener('click', function(e) {
  const viewBtn = e.target.closest('.view-btn');
  if (viewBtn && viewBtn.dataset.ektmKey) {
    viewImage(viewBtn.dataset.ektmKey);
  }
  const delBtn = e.target.closest('.del-btn');
  if (delBtn && delBtn.dataset.email && !delBtn.disabled) {
    deleteAdmin(delBtn.dataset.email);
  }
  const exportBtn = e.target.closest('[data-action="export"]');
  if (exportBtn) {
    exportCSV();
  }
});

if (token) showApp();

async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  err.style.display = 'none';
  try {
    const res = await fetch('/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email, password}) });
    const data = await res.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('admin_token', token);
      showApp();
    } else {
      err.textContent = data.error || 'Login failed';
      err.style.display = 'block';
    }
  } catch(e) { err.textContent = 'Network error'; err.style.display = 'block'; }
}

function doLogout() {
  token = null;
  localStorage.removeItem('admin_token');
  document.getElementById('appPage').style.display = 'none';
  document.getElementById('loginPage').style.display = 'block';
  document.getElementById('loginForm').style.display = 'block';
  document.getElementById('forgotPasswordForm').style.display = 'none';
}

function toggleForgotPassword() {
  const loginForm = document.getElementById('loginForm');
  const forgotForm = document.getElementById('forgotPasswordForm');
  const loginErr = document.getElementById('loginError');
  const forgotErr = document.getElementById('forgotError');
  const forgotOk = document.getElementById('forgotSuccess');

  loginErr.style.display = 'none';
  forgotErr.style.display = 'none';
  forgotOk.style.display = 'none';

  if (loginForm.style.display === 'none') {
    loginForm.style.display = 'block';
    forgotForm.style.display = 'none';
  } else {
    loginForm.style.display = 'none';
    forgotForm.style.display = 'block';
  }
}

async function doForgotPassword() {
  const email = document.getElementById('forgotEmail').value;
  const errEl = document.getElementById('forgotError');
  const okEl = document.getElementById('forgotSuccess');
  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if (!email) {
    errEl.textContent = 'Please enter your email address.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/admin/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();

    if (data.success) {
      okEl.textContent = 'If this email is registered, you will receive a password reset link shortly.';
      okEl.style.display = 'block';
    } else {
      errEl.textContent = data.error || 'Failed to request reset.';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Network error.';
    errEl.style.display = 'block';
  }
}

function showApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appPage').style.display = 'block';
  fetch('/admin/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(d => { if (d.email) { document.getElementById('adminEmail').textContent = d.email; loadDashboard(); } else doLogout(); });
}

function switchTab(el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('panel-' + el.dataset.tab).classList.add('active');
  if (el.dataset.tab === 'dashboard') loadDashboard();
  if (el.dataset.tab === 'attempts') loadAttempts();
  if (el.dataset.tab === 'admins') loadAdmins();
  if (el.dataset.tab === 'majors') { loadMajorTags(); }
}

function setFilter(el) {
  document.querySelectorAll('.filter').forEach(f => f.classList.remove('active'));
  el.classList.add('active');
  currentFilter = el.dataset.filter;
  currentPage = 1;
  loadAttempts();
}

function doSearch() {
  const q = document.getElementById('searchInput').value.trim();
  currentSearch = q;
  currentPage = 1;
  loadAttempts();
}

function goToPage(p) {
  if (p < 1) return;
  currentPage = p;
  loadAttempts();
}

async function loadDashboard() {
  try {
    const res = await fetch('/admin/attempts?filter=all', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const attempts = data.attempts || [];
    const approved = attempts.filter(a => a.status === 'approved');
    const thisMonth = approved.filter(a => a.verified_at && new Date(a.verified_at) >= new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    document.getElementById('statsGrid').innerHTML =
      '<div class="stat"><div class="num">' + attempts.length + '</div><div class="lbl">Total Attempts</div></div>' +
      '<div class="stat"><div class="num">' + approved.length + '</div><div class="lbl">Verified</div></div>' +
      '<div class="stat"><div class="num">' + thisMonth.length + '</div><div class="lbl">This Month</div></div>' +
      '<div class="stat"><div class="num">' + attempts.filter(a => a.status === 'failed').length + '</div><div class="lbl">Failed</div></div>';
  } catch(e) {}
}

function esc(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

async function loadAttempts() {
  try {
    let url = '/admin/attempts?filter=' + encodeURIComponent(currentFilter) + '&page=' + currentPage;
    if (currentSearch) {
      url += '&search=' + encodeURIComponent(currentSearch);
    }

    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const tbody = document.getElementById('attemptsBody');
    const attempts = data.attempts || [];
    const pag = data.pagination || { page: 1, total: 0, totalPages: 1 };

    // Update currentPage to actual returned page
    currentPage = pag.page;

    tbody.innerHTML = attempts.map(a => {
      const isApproved = a.status === 'approved';
      let actions = '-';
      if (isApproved) {
        const jsonData = JSON.stringify({
          discord_id: a.discord_id,
          nim: a.nim,
        }).replace(/"/g, '&quot;');

        if (a.is_blocked) {
          actions =
            '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
            '<span class="badge failed" style="padding:4px 8px">Blocked</span>' +
            '<button class="view-btn" data-member="' + jsonData + '" onclick="unblockMember(this)">Unblock</button>' +
            '</div>';
        } else {
          actions =
            '<div style="display:flex;gap:4px;flex-wrap:wrap">' +
            '<button class="view-btn" data-member="' + jsonData + '" onclick="dropMember(this)">Drop</button>' +
            '<select class="block-select" data-member="' + jsonData + '" style="padding:4px 8px;border:1px solid #333;border-radius:4px;background:#0f0f1a;color:#eee;font-size:0.8rem">' +
              '<option value="">Block...</option>' +
              '<option value="3">3d</option>' +
              '<option value="7">7d</option>' +
              '<option value="14">14d</option>' +
              '<option value="30">30d</option>' +
              '<option value="90">90d</option>' +
              '<option value="0">Forever</option>' +
            '</select>' +
            '</div>';
        }
      }
      return (
        '<tr>' +
        '<td>' + (a.nim || '-') + '</td>' +
        '<td>' + (a.nama || '-') + '</td>' +
        '<td>' + (a.study_program || '-') + '</td>' +
        '<td>' + a.discord_username + '</td>' +
        '<td><span class="badge ' + a.status + '">' + a.status + '</span></td>' +
        '<td>' + (a.verified_at || '-') + '</td>' +
        '<td>' + (a.ektm_image_url ? '<button class="view-btn" data-ektm-key="' + a.ektm_image_url + '">View</button>' : '-') + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>'
      );
    }).join('');

    // Attach change handlers to block selects
    document.querySelectorAll('.block-select').forEach(sel => {
      sel.onchange = async function() {
        if (sel.value) {
          await blockMember(sel);
        }
      };
    });

    // Update pagination UI
    document.getElementById('pageInfo').textContent =
      'Page ' + pag.page + ' of ' + pag.totalPages + ' (' + pag.total + ' total records)';

    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const jumpInput = document.getElementById('jumpToPage');

    prevBtn.disabled = pag.page <= 1;
    nextBtn.disabled = pag.page >= pag.totalPages;
    jumpInput.max = pag.totalPages;

    // Render page numbers (show up to 7 pages around current)
    const container = document.getElementById('pageNumbers');
    const pages = [];

    // First page
    if (pag.totalPages >= 1) pages.push(1);

    // Pages around current
    const rangeStart = Math.max(2, pag.page - 2);
    const rangeEnd = Math.min(pag.totalPages - 1, pag.page + 2);

    if (rangeStart <= rangeEnd) {
      const last = pages[pages.length - 1];
      if (last && last !== rangeStart - 1 && last !== '...') pages.push('...');
      for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
    }

    // Last page
    if (pag.totalPages > 1) {
      const last = pages[pages.length - 1];
      if (last && last !== pag.totalPages - 1 && last !== '...') pages.push('...');
      pages.push(pag.totalPages);
    }

    container.innerHTML = pages.map(p => {
      if (p === '...') return '<span style="padding:4px 8px;color:#666">...</span>';
      const isActive = p === pag.page;
      const style = isActive
        ? 'background:#5865F2;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:0.9rem;text-decoration:none'
        : 'background:#1a1a2e;color:#888;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:0.9rem;text-decoration:none';
      return '<span style="' + style + '" onclick="goToPage(' + p + ')">' + p + '</span>';
    }).join('');
  } catch(e) {}
}

async function dropMember(btn) {
  const data = JSON.parse(btn.getAttribute('data-member').replace(/&quot;/g, '"'));
  const discordId = data.discord_id;
  if (!discordId) return;
  if (!confirm('Remove ALL roles (Verified + major roles) from this member?')) return;

  try {
    const res = await fetch('/admin/members/drop', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId })
    });
    const result = await res.json();
    if (result.success) {
      alert('Roles removed: ' + result.rolesRemoved + ' role(s)');
    } else {
      alert('Failed: ' + (result.error || 'unknown'));
    }
  } catch(e) { alert('Network error'); }
}

async function blockMember(sel) {
  const data = JSON.parse(sel.getAttribute('data-member').replace(/&quot;/g, '"'));
  const durationDays = parseInt(sel.value);
  const discordId = data.discord_id;
  const nim = data.nim;

  if (!discordId && !nim) { alert('No identifiers available'); sel.value = ''; return; }

  const durationLabel = durationDays === 0 ? 'Forever' : (durationDays + ' day' + (durationDays > 1 ? 's' : ''));
  const alsoDrop = confirm('Block this member for ' + durationLabel + '?\n\nAlso drop all their roles now?\n(Cancel = block but keep roles)');

  try {
    const res = await fetch('/admin/members/block', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId, nim, durationDays, alsoDrop })
    });
    const result = await res.json();
    if (result.success) {
      const msg = 'Member blocked' + (result.dropResult ? ' (' + result.dropResult.rolesRemoved + ' roles removed)' : '');
      alert(msg);
      loadAttempts();
    } else {
      alert('Failed: ' + (result.error || 'unknown'));
    }
  } catch(e) { alert('Network error'); }

  sel.value = '';
}

async function unblockMember(btn) {
  const data = JSON.parse(btn.getAttribute('data-member').replace(/&quot;/g, '"'));
  const discordId = data.discord_id;
  const nim = data.nim;

  if (!confirm('Unblock this member?')) return;

  try {
    const res = await fetch('/admin/members/unblock', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId, nim })
    });
    const result = await res.json();
    if (result.success) {
      alert('Unblocked. Removed ' + result.entriesRemoved + ' block entry(ies).');
      loadAttempts();
    } else {
      alert('Failed: ' + (result.error || 'unknown'));
    }
  } catch(e) { alert('Network error'); }
}

async function loadAdmins() {
  try {
    const res = await fetch('/admin/admins', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const me = document.getElementById('adminEmail').textContent;
    document.getElementById('adminsList').innerHTML = (data.admins || []).map(a =>
      '<div class="admin-card">' +
      '<div><div class="email">' + a.email + '</div>' +
      (a.invited_by ? '<div class="meta">Invited by ' + a.invited_by + '</div>' : '<div class="meta">Default admin</div>') +
      '</div>' +
      '<button class="del-btn" data-email="' + a.email + '"' +
      (a.email === me || a.email === 'krismyid@gmail.com' ? ' disabled' : '') +
      '>Delete</button>' +
      '</div>'
    ).join('');
  } catch(e) {}
}

async function inviteAdmin() {
  const email = document.getElementById('inviteEmail').value;
  if (!email) return;
  try {
    const res = await fetch('/admin/invite', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteEmail: email }) });
    const data = await res.json();
    if (data.success) {
      document.getElementById('inviteEmail').value = '';
      loadAdmins();
      if (data.emailSent) {
        alert('Admin invited! Invitation email sent to ' + data.email);
      } else {
        alert('Admin created, but email failed to send. The user will need a password reset link. Error: ' + (data.emailError || 'unknown'));
      }
    }
    else alert(data.error || 'Failed to invite');
  } catch(e) { alert('Network error'); }
}

async function deleteAdmin(email) {
  if (!confirm('Remove admin ' + email + '?')) return;
  try {
    const res = await fetch('/admin/delete', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteEmail: email }) });
    const data = await res.json();
    if (data.success) loadAdmins();
    else alert(data.error || 'Failed to delete');
  } catch(e) { alert('Network error'); }
}

async function viewImage(key) {
  try {
    const res = await fetch('/admin/image?key=' + encodeURIComponent(key), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('Image not found');
    const blob = await res.blob();
    document.getElementById('modalImage').src = URL.createObjectURL(blob);
    document.getElementById('imageModal').classList.add('show');
  } catch(e) {
    alert('Failed to load image');
  }
}

async function changePassword() {
  const current = document.getElementById('currentPwd').value;
  const newPwd = document.getElementById('newPwd').value;
  const confirm = document.getElementById('confirmPwd').value;
  const status = document.getElementById('pwdStatus');
  status.style.display = 'none';
  if (!current || !newPwd || !confirm) {
    status.style.display = 'block';
    status.style.background = '#3a1a1a';
    status.style.border = '1px solid #5a2d2d';
    status.textContent = 'Please fill in all fields.';
    return;
  }
  if (newPwd.length < 8) {
    status.style.display = 'block';
    status.style.background = '#3a1a1a';
    status.style.border = '1px solid #5a2d2d';
    status.textContent = 'New password must be at least 8 characters.';
    return;
  }
  if (newPwd !== confirm) {
    status.style.display = 'block';
    status.style.background = '#3a1a1a';
    status.style.border = '1px solid #5a2d2d';
    status.textContent = 'New passwords do not match.';
    return;
  }
  try {
    const res = await fetch('/admin/change-password', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPwd })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('currentPwd').value = '';
      document.getElementById('newPwd').value = '';
      document.getElementById('confirmPwd').value = '';
      status.style.display = 'block';
      status.style.background = '#1a3a1a';
      status.style.border = '1px solid #2d5a2d';
      status.textContent = 'Password updated successfully!';
    } else {
      status.style.display = 'block';
      status.style.background = '#3a1a1a';
      status.style.border = '1px solid #5a2d2d';
      status.textContent = data.error || 'Failed to update password.';
    }
  } catch(e) {
    status.style.display = 'block';
    status.style.background = '#3a1a1a';
    status.style.border = '1px solid #5a2d2d';
    status.textContent = 'Network error.';
  }
}

async function exportCSV() {
  try {
    const res = await fetch('/admin/export?filter=' + currentFilter, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'verify-export-' + currentFilter + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch(e) {
    alert('Failed to export CSV');
  }
}

let majorTagsCache = [];

async function loadMajorTags() {
  try {
    const res = await fetch('/admin/major-tags', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    majorTagsCache = data.tags || [];
    renderMajorTags();
    loadUnmappedMajors();
  } catch(e) {}
}

function renderMajorTags() {
  const container = document.getElementById('majorTagsList');
  if (!majorTagsCache.length) {
    container.innerHTML = '<p style="color:#666;font-size:0.9rem">No tags created yet.</p>';
    return;
  }
  container.innerHTML = majorTagsCache.map(t =>
    '<div class="tag-card" data-tag-id="' + t.id + '">' +
    '<div class="tag-header">' +
    '<div><div class="tag-name">' + esc(t.name) + '</div><div class="tag-role">Role: ' + esc(t.discord_role_id) + '</div></div>' +
    '<button class="del-tag-btn" onclick="deleteMajorTag(\\'' + t.id + '\\')">Delete</button>' +
    '</div>' +
    (t.members.length ? t.members.map(m =>
      '<div class="member"><span>' + esc(m) + '</span><button class="remove-member" onclick="removeMajorMember(\\'' + t.id + '\\',\\'' + esc(m) + '\\')">Remove</button></div>'
    ).join('') : '<div style="color:#666;font-size:0.85rem;margin-bottom:8px">No majors assigned</div>') +
    '<div class="add-member-row">' +
    '<input type="text" id="addMajor-' + t.id + '" placeholder="Study program name">' +
    '<button onclick="addMajorMember(\\'' + t.id + '\\')">Add</button>' +
    '</div>' +
    '</div>'
  ).join('');
}

async function createMajorTag() {
  const name = document.getElementById('tagName').value.trim();
  const roleId = document.getElementById('tagRoleId').value.trim();
  if (!name || !roleId) { alert('Tag name and Discord Role ID are required.'); return; }
  try {
    const res = await fetch('/admin/major-tags', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, discordRoleId: roleId })
    });
    const data = await res.json();
    if (data.success) { document.getElementById('tagName').value = ''; document.getElementById('tagRoleId').value = ''; loadMajorTags(); }
    else alert(data.error || 'Failed to create tag');
  } catch(e) { alert('Network error'); }
}

async function deleteMajorTag(id) {
  if (!confirm('Delete this tag and all its major assignments?')) return;
  try {
    const res = await fetch('/admin/major-tags', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) { loadMajorTags(); }
    else alert(data.error || 'Failed to delete tag');
  } catch(e) { alert('Network error'); }
}

async function addMajorMember(tagId) {
  const input = document.getElementById('addMajor-' + tagId);
  const studyProgram = input.value.trim();
  if (!studyProgram) return;
  try {
    const res = await fetch('/admin/major-tags/members', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId, studyProgram })
    });
    const data = await res.json();
    if (data.success) { loadMajorTags(); }
    else alert(data.error || 'Failed to add major');
  } catch(e) { alert('Network error'); }
}

async function removeMajorMember(tagId, studyProgram) {
  try {
    const res = await fetch('/admin/major-tags/members', {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId, studyProgram })
    });
    const data = await res.json();
    if (data.success) { loadMajorTags(); }
    else alert(data.error || 'Failed to remove major');
  } catch(e) { alert('Network error'); }
}

async function loadUnmappedMajors() {
  try {
    const res = await fetch('/admin/unmapped-majors', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json();
    const majors = data.majors || [];
    const container = document.getElementById('unmappedMajorsList');
    if (!majors.length) {
      container.innerHTML = '<p style="color:#666;font-size:0.9rem">All discovered majors are assigned to tags.</p>';
      return;
    }
    const tagOptions = majorTagsCache.map(t => '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>').join('');
    container.innerHTML = majors.map(m =>
      '<div class="unmapped-item">' +
      '<span class="major-name">' + esc(m.study_program) + '</span>' +
      '<span class="major-count">' + m.count + ' student' + (m.count > 1 ? 's' : '') + '</span>' +
      (tagOptions ?
        '<select id="assign-' + esc(m.study_program).replace(/[^a-zA-Z0-9]/g,'_') + '">' + tagOptions + '</select>' +
        '<button class="assign-btn" onclick="quickAssignMajor(\\'' + esc(m.study_program).replace(/'/g,"\\\\'") + '\\')">Assign</button>'
        : '<span style="color:#666;font-size:0.8rem">No tags</span>') +
      '</div>'
    ).join('');
  } catch(e) {}
}

async function quickAssignMajor(studyProgram) {
  const selectId = 'assign-' + studyProgram.replace(/[^a-zA-Z0-9]/g,'_');
  const select = document.getElementById(selectId);
  if (!select) return;
  const tagId = select.value;
  try {
    const res = await fetch('/admin/major-tags/members', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId, studyProgram })
    });
    const data = await res.json();
    if (data.success) { loadMajorTags(); }
    else alert(data.error || 'Failed to assign');
  } catch(e) { alert('Network error'); }
}
</script>
</body>
</html>`;
}

// ── Main router ──

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Discord Interactions
    if (request.method === 'POST' && path === '/interactions') {
      return handleInteraction(request, env);
    }

    // Register slash commands (one-time setup)
    if (request.method === 'POST' && path === '/register-commands') {
      return handleRegisterCommands(request, env);
    }

    // Admin dashboard
    if (path === '/admin' || path === '/admin/') {
      return new Response(getAdminHTML(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Admin API routes
    if (path === '/admin/login' && request.method === 'POST') {
      return handleAdminLogin(request, env);
    }
    if (path === '/admin/me' && request.method === 'GET') {
      return handleAdminMe(request, env);
    }
    if (path === '/admin/admins' && request.method === 'GET') {
      return handleAdminListAdmins(request, env);
    }
    if (path === '/admin/invite' && request.method === 'POST') {
      return handleAdminInviteAdmin(request, env, ctx);
    }
    if (path === '/admin/forgot-password' && request.method === 'POST') {
      return handleAdminForgotPassword(request, env);
    }
    if (path === '/admin/set-password' && request.method === 'GET') {
      return handleAdminSetPasswordPage(request, env);
    }
    if (path === '/admin/set-password' && request.method === 'POST') {
      return handleAdminSetPassword(request, env);
    }
    if (path === '/admin/delete' && request.method === 'POST') {
      return handleAdminDeleteAdmin(request, env);
    }
    if (path === '/admin/attempts' && request.method === 'GET') {
      return handleAdminListAttempts(request, env);
    }
    if (path === '/admin/export' && request.method === 'GET') {
      return handleAdminExportExcel(request, env);
    }
    if (path === '/admin/image' && request.method === 'GET') {
      return handleAdminSignedImageUrl(request, env);
    }
    if (path === '/admin/hash-password' && request.method === 'GET') {
      return handleAdminHashPassword(request, env);
    }
    if (path === '/admin/change-password' && request.method === 'POST') {
      return handleAdminChangePassword(request, env);
    }
    if (path === '/admin/major-tags' && request.method === 'GET') {
      return handleAdminListMajorTags(request, env);
    }
    if (path === '/admin/major-tags' && request.method === 'POST') {
      return handleAdminCreateMajorTag(request, env);
    }
    if (path === '/admin/major-tags' && request.method === 'DELETE') {
      return handleAdminDeleteMajorTag(request, env);
    }
    if (path === '/admin/major-tags/members' && request.method === 'POST') {
      return handleAdminAddMajorMember(request, env, ctx);
    }
    if (path === '/admin/major-tags/members' && request.method === 'DELETE') {
      return handleAdminRemoveMajorMember(request, env);
    }
    if (path === '/admin/unmapped-majors' && request.method === 'GET') {
      return handleAdminUnmappedMajors(request, env);
    }
    if (path === '/admin/members/drop' && request.method === 'POST') {
      return handleAdminDropMember(request, env);
    }
    if (path === '/admin/members/block' && request.method === 'POST') {
      return handleAdminBlockMember(request, env);
    }
    if (path === '/admin/members/unblock' && request.method === 'POST') {
      return handleAdminUnblockMember(request, env);
    }
    if (path === '/admin/members/blocked' && request.method === 'GET') {
      return handleAdminListBlocked(request, env);
    }

    // Verification page
    const verifyMatch = path.match(/^\/v\/([a-f0-9-]+)$/);
    if (verifyMatch) {
      if (request.method === 'GET') {
        return handleVerificationPage(verifyMatch[1], env);
      }
      if (request.method === 'POST') {
        return processVerification(verifyMatch[1], request, env, ctx);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
