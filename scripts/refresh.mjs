// Daily jobs refresh — runs in GitHub Actions, powered by the free Gemini API.
// Fetches Israeli job boards, asks Gemini to extract relevant manager-level IS/IT roles,
// then renders a FIXED Hebrew RTL template (so column layout can never break).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Missing GEMINI_API_KEY secret'); process.exit(1); }
const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const TZ = 'Asia/Jerusalem';
const now = new Date();
const part = (t, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }).format(now);
const g = (type) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
  .formatToParts(now).find(x => x.type === type).value;
const D = `${g('day')}.${g('month')}.${g('year')}`;                          // 25.06.2026
const dFull = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now);

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
];
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Fetch a URL, retrying up to 3x with rotating User-Agents + backoff — raises the odds of getting past a board's anti-bot block.
async function fetchHtml(url) {
  for (let i = 0; i < UAS.length; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UAS[i], 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8', 'Referer': 'https://www.google.com/' }, signal: AbortSignal.timeout(25000) });
      if (r.ok) { if (i > 0) console.log(`  (${url} loaded on attempt ${i + 1})`); return await r.text(); }
    } catch {}
    if (i < UAS.length - 1) await sleep(2500 * (i + 1));
  }
  return null;
}
const BOARDS = [
  ['JobMaster', 'https://www.jobmaster.co.il/jobs/?q=מנהל מערכות מידע'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=מנהל מערכות מידע'],
  ['דרושים', 'https://www.drushim.co.il/jobs/search/מנהל מערכות מידע/'],
  ['Indeed', 'https://il.indeed.com/jobs?q=מנהל מערכות מידע&l=חיפה'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=מנהל יישומים עסקיים'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=Head of IT'],
  ['JobMaster', 'https://www.jobmaster.co.il/jobs/?q=מנהל יישומים'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=Business Application Manager'],
];

const loaded = [], blocked = [];
const realUrls = new Set();   // genuine listing URLs extracted from the board pages (so Gemini doesn't invent links)
let corpus = '';
for (const [name, url] of BOARDS) {
  const html = await fetchHtml(url);   // up to 3 attempts with rotating User-Agents
  if (!html) { blocked.push(name); continue; }
  try {
    let raw = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Keep REAL job-listing links inline as "text [URL:...]" before stripping tags.
    raw = raw.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      let abs = ''; try { abs = new URL(href, url).href; } catch {}
      const t = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (abs && /(checknum\.asp\?key=|drushim\.co\.il\/job\/\d+\/|alljobs\.co\.il\/Search\/UploadSingle|app\.civi\.co\.il\/)/i.test(abs)) {
        realUrls.add(abs);
        return ` ${t} [URL:${abs}] `;
      }
      return ' ' + t + ' ';
    });
    const txt = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    corpus += `\n\n===== ${name} (${url}) =====\n` + txt.slice(0, 14000);
    loaded.push(name);
  } catch { blocked.push(name); }
}

const PROMPT = `You extract job listings for a Hebrew job-search landing page. Return ONLY a JSON array (no markdown, no prose).

JOB SEEKER: lives in צרופה (Tzrufa), Hof HaCarmel, northern Israel (near Zichron Yaakov/Hadera). Wants MANAGER-LEVEL roles only: מנהל/ת מערכות מידע, מנמ"ר, CIO, מנהל/ת אפליקציות, מנהל/ת יישומים עסקיים, Business Applications Manager, Information System Manager, Head of Information Systems, Head of IT, IT/IS manager. Target areas: north, the Sharon, the valleys (העמקים), plus hybrid roles anywhere. DISTANCE LIMIT: EXCLUDE any job more than ~65 km from Tzrufa — i.e. central & southern Israel (Tel Aviv & south, Petah Tikva, Holon, Bat Yam, Be'er Yaakov, Yavne, Rishon, Rehovot, Ness Ziona, Gedera, Ashdod, Ashkelon, Kiryat Gat, Beer Sheva, Dimona, Jerusalem, Modiin, Lod, Ramla, Shoham) — UNLESS the job is hybrid/remote. Keep only north / valleys / Sharon (≤~65 km) or hybrid. If a job's location CANNOT be determined from the listing, EXCLUDE it (do NOT guess a distance and do NOT default it to near). Also EXCLUDE any listing marked removed/expired ("משרה זו הוסרה", "פג תוקף", closed).

Extract jobs ONLY from the BOARD TEXT below. EVERY job you output MUST literally appear in that BOARD TEXT — so it is real, currently open, and has a working link. Do NOT add any job from your own knowledge/memory, and do NOT include LinkedIn / Civi / GovJobs / Greenhouse / municipal jobs unless they actually appear in the BOARD TEXT. If a job is not in the BOARD TEXT, leave it out. (Better fewer real jobs than any job whose link doesn't reach it.)

RULES:
- STRICT ROLE WHITELIST — include a job ONLY if its title is essentially one of these (the person HEADS the IS/IT/applications function): מנהל/ת מערכות מידע, מנמ"ר, CIO, מנהל/ת אפליקציות, מנהל/ת יישומים (applications MANAGER), מנהל/ת IT, Head of Information Systems, Head of IT, IT/IS Manager, Business Applications Manager.
- STRICT BLACKLIST — do NOT include (even if "מערכות מידע"/"IT" appears in the title): מנהל/ת פרויקטים / Project Manager / PMO / Portfolio / Delivery (Lead/Manager/Excellence), מנתח/ת מערכות / Systems Analyst, מיישם/ת / Implementer, אחראי/ת (coordinator — not a manager), ראש צוות / team lead, מפתח/ת / developer, תמיכה / Help Desk / Support, מנהל/ת מוצר / Product, sales, CCoE. When in doubt whether a title is a true IS/IT-MANAGEMENT role vs a project/analyst/coordinator role, EXCLUDE it.
- EXCLUDE support / help-desk / service-desk roles and their team leads — e.g. "ראש צוות תמיכה", "מנהל מוקד Help Desk", "תמיכה טכנית", "מוקד שירות", system administrator, NOC team lead. These are operational support, NOT information-systems management — do NOT include them.
- Also EXCLUDE narrow specialty-domain roles that are NOT the IS/IT-management function: CCoE / "Cloud Center of Excellence" / "מנהל תחום CCOE", pure cloud-platform leads, and similar single-domain titles. Include a role ONLY if it heads information systems / IT / applications broadly (מנהל/ת מערכות מידע, מנמ"ר, CIO, מנהל/ת אפליקציות, IT/IS manager).
- ACCURACY: use only facts that really appear; never invent a company or city. Recruiter/placement postings (השמה/גיוס/משאבי אנוש) → company = recruiter name or "חברה חסויה"; never attribute to a similarly-named real company.
- FRESHNESS: only currently-open jobs; exclude "No longer accepting"/"כבר לא מקבלים מועמדים"/"המשרה אוישה" and anything older than ~8 weeks. Municipal/tender pages: include ONLY if a date within ~8 weeks is shown.
- HYBRID: set "yes"/"no" from the listing; on Drushim the hybrid flag may be hidden under the "משרה מלאה ועוד" expander. Use "na" only if truly not stated.
- DEDUPE the same job across sources.
- LINK (CRITICAL): If the job in the BOARD TEXT is followed by a real link in the form [URL:https://...], USE THAT EXACT URL — it is the genuine direct listing. ONLY if a job has NO [URL:...] next to it, build a search link (below). NEVER invent or guess a URL with an id/slug that did not appear as [URL:...] — fabricated links are broken. For jobs without a real [URL:...], output a SEARCH URL built from a SHORT query — the recruiter/agency or company name if one is shown (e.g. YifaTalent, לירון ואליס) — that is the BEST query; otherwise a short core role phrase from the title (e.g. "מוביל מערכות מידע", "מנהל מערכות מידע"). DO NOT add a city/region to the query — the listing's location wording often differs (e.g. it says "אזור צפון" but you'd write "חיפה") and that zeroes out the search. Keep the query short (never the full job title). Use EXACTLY these formats:
   • JobMaster → https://www.jobmaster.co.il/jobs/?q=<short query>
   • AllJobs or svt.jobs → https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=<short query>
   • Drushim → https://www.drushim.co.il/jobs/search/<short query>/
   • LinkedIn → https://www.linkedin.com/jobs/search?keywords=<short query>&location=Israel
   • Civi, GovJobs, municipal, or anything else → https://www.google.com/search?q=<short query including the company name> (URL-encoded)
  URL-encode the query. When unsure, prefer the Google search format. Every link MUST lead to a non-empty results page.
- DISTANCE km from Tzrufa by stated city: Caesarea 12, Zichron Yaakov 5, Hadera 15, Pardes Hanna 12, Binyamina 8, Or Akiva 10, Yokneam 28, Haifa 25, Akko 45, Afula 45, Karmiel 50, Hod Hasharon 55, Ramat Hasharon 62, Kfar Saba 52, Tel Aviv 65, Petah Tikva 65, Herzliya 58, Holon 75, Shoham 75, Ariel 72, Modiin 85, Yavne 88, Tzfat 90, Rishon LeZion 80, Jerusalem 120, Kiryat Gat 140, Beer Sheva 160. Multi-location → nearest city. Hybrid/remote with no fixed city → location "מרחוק/היברידי", km 0.
- LOCATION ACCURACY (IMPORTANT): use the location EXACTLY as the source states it. NEVER relocate a job to a closer/northern city or guess a city. If only a region is given, keep it and use its distance: מרכז / Center District ~65, השרון ~58, צפון / North ~40, ירושלים ~120, דרום / South ~140. For a job you add from your own memory (e.g. a LinkedIn role) where you are NOT sure of its CURRENT city — OMIT it rather than guess a location.

Each array item = {"title": "...", "company": "...", "location": "...", "km": <number>, "hybrid": "yes"|"no"|"na", "desc": "<one short Hebrew line>", "source": "<JobMaster|AllJobs|דרושים|Indeed|LinkedIn|Civi|GovJobs|name>", "url": "https://..."}. Aim for 8-20 quality items. Return ONLY the JSON array.

BOARD TEXT:${corpus || '\n(no board text loaded today — rely on your own knowledge, but do not invent URLs)'}`;

async function callGemini() {
  const body = { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { temperature: 0.2 } };
  let lastErr = '';
  for (const m of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${KEY}`;
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
      if (!r.ok) { lastErr = `${m}: HTTP ${r.status} :: ${(await r.text()).slice(0, 600)}`; console.error('TRY ' + lastErr); continue; }
      const j = await r.json();
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s < 0 || e < 0) { lastErr = `${m}: no JSON array in reply :: ${text.slice(0, 300)}`; console.error('TRY ' + lastErr); continue; }
      console.log('Gemini OK via model ' + m);
      return JSON.parse(text.slice(s, e + 1));
    } catch (e) { lastErr = `${m}: ${e.message}`; console.error('TRY ' + lastErr); }
  }
  throw new Error('All Gemini models failed. Last error -> ' + lastErr);
}

// Guard: only allow known site-SEARCH URLs; anything else (fabricated ID paths, civi, blanks) -> Google search.
function safeUrl(j) {
  const u = (j.url || '').trim();
  if (realUrls.has(u)) return u;   // genuine direct listing URL extracted from a board page → use it
  const src = (j.source || '').toLowerCase();
  const g = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q.replace(/\s+/g, ' ').trim());
  // For sources with no real/fetched URL: a Google search that actually RETURNS results.
  const co = (j.company && !/חסוי|confidential/i.test(j.company)) ? j.company : '';  // drop "חברה חסויה" filler from the query
  const loc = (j.location && !/מרחוק|היבריד|רב.?אזורי|לא צוין|מרכז|צפון|דרום|שרון|עמק/i.test(j.location)) ? j.location : '';  // add a concrete city for precision
  const base = `${j.title || ''} ${co} ${loc}`;
  if (src.includes('civi')) return g(`${base} site:civi.co.il`);                      // Civi postings are indexed by Google
  if (src.includes('linkedin') || /linkedin\.com/i.test(u)) return g(`${base} site:linkedin.com/jobs`);
  if (src.includes('gov')) return g(`${base} דרושים מכרז`);                           // govojobs indexing unreliable → softer query that still returns results
  const allowed = /^https:\/\/(www\.jobmaster\.co\.il\/jobs\/\?q=|www\.alljobs\.co\.il\/SearchResultsGuest|www\.drushim\.co\.il\/jobs\/search\/|www\.linkedin\.com\/jobs\/search|www\.google\.com\/search)/i.test(u);
  return allowed ? u : g(`${base} דרושים`);
}
let jobs = [];
try { jobs = await callGemini(); } catch (err) { console.error('Gemini failed:', err.message); }
jobs = (jobs || []).filter(j => j && j.title).map(j => ({
  title: String(j.title).trim(), company: String(j.company || 'לא צוין').trim(),
  location: String(j.location || '').trim(), km: Number.isFinite(+j.km) ? +j.km : 40,
  hybrid: ['yes', 'no', 'na'].includes(j.hybrid) ? j.hybrid : 'na',
  desc: String(j.desc || '').trim(), source: String(j.source || '').trim(), url: safeUrl(j),
}));
// Distance cap: keep only jobs within ~65 km of Tzrufa, OR hybrid (which can be anywhere).
jobs = jobs.filter(j => j.km <= 65 || j.hybrid === 'yes');

// ---- "shown yesterday" state ----
const norm = s => s.toLowerCase().replace(/\//g, '').replace(/\s+/g, ' ').trim();
const keyOf = j => `${norm(j.title)}|${norm(j.company)}`;
const readJson = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
let T = await readJson('data/jobs-today.json');
let Y = await readJson('data/jobs-yesterday.json');
if (T && T.date && T.date !== D) Y = T;          // new day → roll over
if (!Y) Y = { date: '', keys: [] };
const ySet = new Set((Y.keys || []));
jobs.forEach(j => { j.ystd = ySet.has(keyOf(j)); });
const todayState = { date: D, keys: jobs.map(keyOf) };

// ---- render fixed template ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hb = { yes: '<span class="yes">כן</span>', no: '<span class="no">לא</span>', na: '<span class="na">לא צוין</span>' };
const sorted = [...jobs].sort((a, b) => a.km - b.km);
const rowsHtml = list => list.map(j => `<tr class="${j.km <= 30 ? 'near' : ''}" data-src="${esc(j.source)}" data-hyb="${j.hybrid}" data-near="${j.km <= 30}" data-new="${!j.ystd}">
  <td class="title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
  <td class="desc">${esc(j.desc)}</td>
  <td class="loc">${esc(j.location)}<span class="km">~${j.km} ק"מ</span></td>
  <td>${hb[j.hybrid]}</td><td><span class="src">${esc(j.source)}</span></td><td>${esc(j.company)}</td>
  <td>${j.ystd ? '<span class="old">כן</span>' : '<span class="new">לא · חדש</span>'}</td></tr>`).join('');
const sources = [...new Set(jobs.map(j => j.source).filter(Boolean))];
const srcButtons = sources.map(s => `<button data-f="${esc(s)}">${esc(s)}</button>`).join('');
const note = blocked.length
  ? `⚠ הערה: ${loaded.length}/${BOARDS.length} לוחות נטענו ישירות היום (${loaded.join(', ')}). ${blocked.join(', ')} חסמו גישה אוטומטית ולכן לא נסרקו ישירות.`
  : `כל הלוחות נטענו ישירות בהצלחה.`;

const html = `<meta charset="utf-8">
<title>משרות מערכות מידע — לוח אישי</title>
<style>
 :root{--bg:#0f172a;--panel:#1e293b;--row:#1a2433;--row2:#1e293b;--ink:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8;--good:#34d399;--line:#334155;--near:#0f2e23;}
 *{box-sizing:border-box}body{margin:0;font-family:"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--ink);direction:rtl}
 header{padding:24px 20px 14px;background:linear-gradient(135deg,#1e293b,#0f172a);border-bottom:1px solid var(--line)}
 h1{margin:0 0 8px;font-size:24px}.stamp{display:inline-block;background:#064e3b;color:#a7f3d0;border:1px solid #10b981;border-radius:8px;padding:6px 14px;font-size:15px;font-weight:700}
 .sub{color:var(--muted);font-size:13.5px;margin-top:8px}.note{color:#fbbf24;font-size:12.5px;margin-top:6px}
 .wrap{max-width:1240px;margin:0 auto;padding:18px}
 .filters{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}
 .filters button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:20px;padding:6px 15px;font-size:13.5px;cursor:pointer}
 .filters button.active{background:var(--accent);color:#0f172a;border-color:var(--accent);font-weight:600}
 .count{color:var(--muted);font-size:13px;margin:0 0 10px}
 table{width:100%;border-collapse:collapse;font-size:14px}
 thead th{position:sticky;top:0;background:#0b1220;color:var(--muted);text-align:right;font-weight:600;padding:11px 12px;border-bottom:2px solid var(--line);font-size:13px;white-space:nowrap}
 tbody td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}tbody tr{background:var(--row)}tbody tr:nth-child(even){background:var(--row2)}tbody tr:hover{background:#26344a}tbody tr.near{background:var(--near)}
 .title a{color:var(--ink);text-decoration:none;font-weight:600}.title a:hover{color:var(--accent)}
 .desc{color:var(--muted);font-size:13px;max-width:320px;line-height:1.5}.loc{white-space:nowrap}.km{display:block;color:var(--good);font-size:11.5px;margin-top:3px}
 .yes{color:var(--good);font-weight:600}.no{color:var(--muted)}.na{color:#64748b;font-size:12px}
 .src{font-size:12px;background:#334155;padding:3px 9px;border-radius:6px;white-space:nowrap}
 .new{background:var(--good);color:#063527;font-weight:700;padding:3px 9px;border-radius:6px;font-size:12px}.old{color:var(--muted);font-size:12px}
 .secbar{margin:20px 0 8px;font-size:14px;color:var(--good);font-weight:600;border-bottom:1px solid var(--line);padding-bottom:6px}.secbar.far{color:var(--muted)}
 footer{color:var(--muted);font-size:12px;text-align:center;padding:22px;border-top:1px solid var(--line);margin-top:26px;line-height:1.8}
 @media(max-width:820px){.desc{max-width:none}}
</style>
<header><div class="wrap" style="padding-bottom:0">
 <h1>🎯 משרות מערכות מידע — לוח אישי</h1>
 <span class="stamp">🔄 עודכן לאחרונה: ${esc(dFull)}</span>
 <div class="note">${esc(note)}</div>
 <div class="sub">מנהל/ת מערכות מידע · מנמ"ר · CIO · מנהל/ת אפליקציות · IT/IS Manager &nbsp;|&nbsp; ממוין לפי מרחק מצרופה · רץ אוטומטית ב-GitHub Actions</div>
 <div style="margin-top:8px;font-size:14px"><a href="guide.html" target="_blank" style="color:var(--accent);font-weight:600;text-decoration:none">📘 לביצוע שינויים בפיתוח ↗</a></div>
</div></header>
<div class="wrap">
 <div class="filters" id="filters">
  <button class="active" data-f="all">הכל</button>
  <button data-f="near">עד 30 ק"מ ✓</button>
  <button data-f="new">חדש היום</button>
  <button data-f="hybrid">היברידי</button>
  ${srcButtons}
 </div>
 <div class="count" id="count"></div>
 <div class="secbar">📍 עד 30 ק"מ מצרופה</div>
 <table><thead><tr><th>שם המשרה</th><th>תיאור התפקיד</th><th>מיקום</th><th>היברידי</th><th>אתר המקור</th><th>שם החברה</th><th>הוצג אתמול?</th></tr></thead>
  <tbody>${rowsHtml(sorted.filter(j => j.km <= 30)) || '<tr><td colspan="7" style="color:#64748b;padding:16px">אין כרגע משרות עד 30 ק"מ</td></tr>'}</tbody></table>
 <div class="secbar far">📌 מעבר ל-30 ק"מ — לפי מרחק עולה</div>
 <table><thead><tr><th>שם המשרה</th><th>תיאור התפקיד</th><th>מיקום</th><th>היברידי</th><th>אתר המקור</th><th>שם החברה</th><th>הוצג אתמול?</th></tr></thead>
  <tbody>${rowsHtml(sorted.filter(j => j.km > 30))}</tbody></table>
</div>
<footer>הנתונים נאספים אוטומטית — מומלץ לוודא כל מודעה במקור לפני הגשה. המרחקים אומדן אווירי מצרופה.<br>רץ כל בוקר ב-GitHub Actions (Gemini), ללא תלות בחשבונות חיצוניים.</footer>
<script>
 const countEl=document.getElementById('count');
 function apply(f){let n=0;document.querySelectorAll('tbody tr').forEach(tr=>{if(!tr.dataset.src&&f!=='all'){return;}let s=true;
  if(f==='near')s=tr.dataset.near==='true';else if(f==='new')s=tr.dataset.new==='true';else if(f==='hybrid')s=tr.dataset.hyb==='yes';else if(f!=='all')s=tr.dataset.src===f;
  tr.style.display=s?'':'none';if(s&&tr.dataset.src)n++;});
  document.querySelectorAll('.secbar').forEach(sb=>{const tb=sb.nextElementSibling.querySelector('tbody');const any=[...tb.querySelectorAll('tr')].some(t=>t.dataset.src&&t.style.display!=='none');sb.style.display=any?'':'none';sb.nextElementSibling.style.display=any?'':'none';});
  countEl.textContent='מציג '+n+' משרות';}
 document.getElementById('filters').addEventListener('click',e=>{if(e.target.tagName!=='BUTTON')return;document.querySelectorAll('#filters button').forEach(b=>b.classList.remove('active'));e.target.classList.add('active');apply(e.target.dataset.f);});
 apply('all');
</script>`;

await mkdir('data', { recursive: true });
await writeFile('index.html', html, 'utf8');
await writeFile('data/jobs-today.json', JSON.stringify(todayState, null, 2), 'utf8');
await writeFile('data/jobs-yesterday.json', JSON.stringify(Y, null, 2), 'utf8');
console.log(`Done: ${jobs.length} jobs (${jobs.filter(j => j.km <= 30).length} within 30km), loaded ${loaded.join(',') || 'none'}, blocked ${blocked.join(',') || 'none'}`);
