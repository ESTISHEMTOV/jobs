// Daily jobs refresh — runs in GitHub Actions, powered by the free Gemini API.
// Fetches Israeli job boards, asks Gemini to extract relevant manager-level IS/IT roles,
// then renders a FIXED Hebrew RTL template (so column layout can never break).
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Missing GEMINI_API_KEY secret'); process.exit(1); }
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
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
const NEAR_KM = 45;   // section 1 = up to this distance; sections 2/3 = beyond it (hybrid / not hybrid)
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const decodeEntities = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const safeDecodeURI = u => { try { return decodeURI(u); } catch { return u; } };
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
  // CIO / Chief Information Officer / מנהל/ת טכנולוגיות
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=CIO'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=מנהל טכנולוגיות'],
  ['JobMaster', 'https://www.jobmaster.co.il/jobs/?q=מנהל טכנולוגיות'],
  ['דרושים', 'https://www.drushim.co.il/jobs/search/מנהל טכנולוגיות/'],
  // Information Systems Manager / IS Manager
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=Information Systems Manager'],
  ['AllJobs', 'https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=IS Manager'],
  ['JobMaster', 'https://www.jobmaster.co.il/jobs/?q=Information Systems Manager'],
  ['JobMaster', 'https://www.jobmaster.co.il/jobs/?q=IS Manager'],
  ['דרושים', 'https://www.drushim.co.il/jobs/search/Information Systems Manager/'],
  ['דרושים', 'https://www.drushim.co.il/jobs/search/IS Manager/'],
  ['Indeed', 'https://il.indeed.com/jobs?q=Information Systems Manager&l=חיפה'],
  ['Indeed', 'https://il.indeed.com/jobs?q=IS Manager&l=חיפה'],
  // LinkedIn — public guest job search (no login needed). f_TPR=r2592000 = posted in the last 30 days.
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=IT Manager&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Head of IT&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=מנהל מערכות מידע&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Business Applications Manager&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=CIO&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Chief Information Officer&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=מנהל טכנולוגיות&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Information Systems Manager&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Information System Manager&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
  ['LinkedIn', 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords="IS Manager"&location=Israel&geoId=101620260&f_TPR=r2592000&sortBy=DD'],
];
// LinkedIn returns only the first ~10 results per search, so Israel-wide searches can be crowded out by central jobs.
// PRIORITY GROUP 1 (≤30 km): extra LinkedIn searches limited to the near regions.
const LI = (kw, loc) => `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${kw}&location=${loc}&f_TPR=r2592000&sortBy=DD`;
for (const loc of ['Haifa District, Israel', 'Northern District, Israel'])
  for (const kw of ['מערכות מידע', 'Information Systems', 'IT Manager', 'CIO']) BOARDS.push(['LinkedIn', LI(kw, loc)]);

// ===== אתרים נוספים — הדביקי בין הגרשיים את כתובת עמוד החיפוש/המשרות של כל אתר =====
// אתר שהכתובת שלו ריקה ('') פשוט מדולג. אפשר להוסיף כמה שורות לאותו אתר (למשל חיפוש נוסף).
const MORE_SITES = [
  ['השועלה',   'https://app.civi.co.il/?promos&lang=he&id=LNTRFP75FN&src=9601&fallback=1&p=1&r=20&o=date_opened%2Cd&f=job_code,1021%2B1012&l='],  // מסונן: טכנולוגיות מערכות מידע + בכירים
  ['עץ השדה',  'https://www.ezsade.co.il/copy-of-%D7%A0%D7%99%D7%94%D7%95%D7%9C-%D7%9E%D7%95%D7%AA%D7%92-%D7%95%D7%90%D7%99%D7%99%D7%A7%D7%95%D7%9E%D7%A8%D7%A1'],  // מסונן: טכנולוגיות מידע
  ['Aman',     'https://www.aman.co.il/careers/all/?category=%25d7%259e%25d7%25a2%25d7%25a8%25d7%259b%25d7%2595%25d7%25aa-%25d7%259e%25d7%2599%25d7%2593%25d7%25a2&location=&s='],  // מסונן: מערכות מידע
  ['Norterra', 'https://www.norterra.co.il/jobs'],
  ["ג'וב קרוב", 'https://www.jobkarov.com/Search/?speciality=1857&role=1864%2C3387'],  // מסונן: מערכות מידע
  ['זיוה בן פורת', 'https://www.zivabenporat.com/jobs'],
  ['Sharon Careers', 'https://sharoncareers.site/?search_category=172'],  // מסונן: מערכות מידע
];
const MORE_HOSTS = new Set();
for (const [n, u] of MORE_SITES) {
  const v = (u || '').trim();
  if (!v) continue;
  try { MORE_HOSTS.add(new URL(v).hostname.replace(/^www\./, '')); BOARDS.push([n, v]); }
  catch { console.log(`Skipping ${n}: not a valid URL -> ${v}`); }
}
// On the added sites, treat a same-site link that looks like a single job page (has an id number or job/career/position/משרה in it) as a REAL listing link.
const sameHost = (a, b) => { try { const h = new URL(a).hostname.replace(/^www\./, ''), H = new URL(b).hostname.replace(/^www\./, ''); return h === H || h.endsWith('.' + H) || H.endsWith('.' + h); } catch { return false; } };
const looksLikeJob = (abs) => { try { const x = new URL(abs); return /\d{3,}|job|career|position|vacanc|misra|משר/i.test(decodeURIComponent(x.pathname + x.search)); } catch { return false; } };

const loaded = [], blocked = [], empty = [], trimmed = [];
const CORPUS_MAX = 380000;    // max characters of board text sent to Gemini in one run (free-tier input limits)
const MAX_PER_BOARD = 20000;  // max characters from any single search page
const realUrls = new Set();   // genuine listing URLs extracted from the board pages (so Gemini doesn't invent links)
const srcTitle = new Map();   // LinkedIn listing URL → the real job title as written on the search card
const pages = [];             // { name, url, txt } per loaded search
let lastLi = 0;
for (const [name, url] of BOARDS) {
  if (/linkedin\.com/i.test(url)) { const w = 1500 - (Date.now() - lastLi); if (w > 0) await sleep(w); lastLi = Date.now(); }   // pace LinkedIn requests
  const html = await fetchHtml(url);   // up to 3 attempts with rotating User-Agents
  if (!html) { blocked.push(name); continue; }
  try {
    const linksBefore = realUrls.size;
    let raw = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Keep REAL job-listing links inline as "text [URL:...]" before stripping tags.
    raw = raw.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      let abs = ''; try { abs = new URL(href.replace(/&amp;/g, '&'), url).href; } catch {}
      if (/linkedin\.com\/jobs\/view\//i.test(abs)) abs = abs.split('?')[0];   // drop LinkedIn refId/trackingId
      const t = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      const extraJob = abs && MORE_HOSTS.size && MORE_HOSTS.has(new URL(url).hostname.replace(/^www\./, '')) && sameHost(abs, url) && new URL(abs).pathname !== new URL(url).pathname && looksLikeJob(abs) && t.length >= 4;
      if (extraJob || abs && /(checknum\.asp\?key=|drushim\.co\.il\/job\/\d+\/|alljobs\.co\.il\/Search\/UploadSingle|app\.civi\.co\.il\/|linkedin\.com\/jobs\/view\/)/i.test(abs)) {
        realUrls.add(abs);
        if (/linkedin\.com\/jobs\/view\//i.test(abs) && t.length >= 3 && !srcTitle.has(abs)) srcTitle.set(abs, t);
        return ` ${t} [URL:${abs}] `;
      }
      return ' ' + t + ' ';
    });
    const txt = decodeEntities(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (txt.length < 300) { empty.push(name); continue; }
    pages.push({ name, url, txt });
    console.log(`  ${name}: ${txt.length} chars, ${realUrls.size - linksBefore} direct links | ${safeDecodeURI(url).slice(0, 110)}`);
    loaded.push(name);
  } catch { blocked.push(name); }
}
// Fit all text into Gemini's limit WITHOUT dropping any source: small pages stay whole, the remaining budget is split evenly among the big ones.
let budget = CORPUS_MAX, left = pages.length, cap = MAX_PER_BOARD;
for (const len of pages.map(p => p.txt.length).sort((x, y) => x - y)) {
  const share = Math.min(MAX_PER_BOARD, Math.floor(budget / Math.max(left, 1)));
  if (len <= share) { budget -= len; left--; } else { cap = share; break; }
}
let corpus = '';
for (const p of pages) corpus += `\n\n===== ${p.name} (${p.url}) =====\n` + p.txt.slice(0, cap);
console.log(`  Text per search capped at ${cap} chars; total sent to Gemini: ${corpus.length} chars.`);

// ===== יישובים עד 45 ק"מ מצרופה — המרחק כאן קובע (אומדן). משרה באחד מהם תמיד בקבוצה הראשונה =====
const NEAR = [
  [['זכרון יעקב', 'זכרון', 'Zichron', 'Zikhron'], 5], [['צרופה', 'Tzrufa'], 0], [['פוריידיס', 'Fureidis'], 3],
  [['עין הוד', 'Ein Hod'], 4], [['מעגן מיכאל', 'Maagan Michael'], 5], [['ג\'סר א-זרקא', 'Jisr'], 7],
  [['בנימינה', 'Binyamina'], 8], [['עתלית', 'Atlit'], 8], [['גבעת עדה', 'Givat Ada'], 10], [['אור עקיבא', 'Or Akiva'], 10],
  [['דלית אל כרמל', 'דאלית אל כרמל', 'Daliyat'], 11], [['עוספיא', 'Isfiya'], 13], [['פרדס חנה', 'Pardes Hanna', 'Pardes Hana'], 12],
  [['כרכור', 'Karkur'], 13], [['קיסריה', 'Caesarea'], 12], [['חדרה', 'Hadera'], 15], [['טירת כרמל', 'Tirat Carmel'], 15],
  [['עין שמר', 'Ein Shemer'], 18], [['אום אל פחם', 'אום אל-פחם', 'Umm al-Fahm'], 21], [['נשר', 'Nesher'], 22],
  [['חיפה', 'Haifa'], 25], [['יקנעם', 'Yokneam', 'Yoqneam'], 28], [['קריית טבעון', 'קרית טבעון', 'Kiryat Tivon'], 28],
  [['עמק חפר', 'Emek Hefer'], 28], [['חוף הכרמל', 'Hof HaCarmel'], 5], [['מגידו', 'Megiddo'], 25],
  // 30–45 km (section 1 now goes up to 45 km)
  [['רמת ישי', 'Ramat Yishai'], 30], [['קריית אתא', 'קרית אתא', 'Kiryat Ata'], 33], [['קריית ים', 'קרית ים', 'Kiryat Yam'], 33],
  [['הקריות', 'Krayot', 'Kiryat Bialik', 'קריית ביאליק', 'קרית ביאליק', 'קריית מוצקין', 'קרית מוצקין', 'Kiryat Motzkin'], 35],
  [['מגדל העמק', 'Migdal HaEmek'], 35], [['נתניה', 'Netanya'], 38], [['כפר יונה', 'Kfar Yona'], 40], [['נצרת', 'Nazareth'], 42],
  [['נוף הגליל', 'Nof HaGalil'], 43], [['עכו', 'Akko', 'Acre'], 45], [['עפולה', 'Afula'], 45], [['אבן יהודה', 'Even Yehuda'], 45],
];
const nearKm = (loc) => { let best = null; const L = String(loc || '').toLowerCase();
  for (const [names, km] of NEAR) if (names.some(n => L.includes(n.toLowerCase()))) best = best === null ? km : Math.min(best, km);
  return best; };
// Excerpts of the board text around every mention of a near place → a second, focused Gemini pass (so no near job is missed).
let nearCorpus = '';
{ const re = new RegExp(NEAR.flatMap(([n]) => n).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  for (const p of pages) {
    const spans = [];
    for (const m of p.txt.matchAll(re)) { const a = Math.max(0, m.index - 700), b = Math.min(p.txt.length, m.index + 500);
      if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = b; else spans.push([a, b]); }
    if (spans.length) nearCorpus += `\n\n===== ${p.name} (${p.url}) =====\n` + spans.map(([a, b]) => p.txt.slice(a, b)).join(' … ');
  }
  nearCorpus = nearCorpus.slice(0, 120000);
  console.log(`  Near-place excerpts for the focused pass: ${nearCorpus.length} chars.`); }

const PROMPT = `You extract job listings for a Hebrew job-search landing page. Return ONLY a JSON array (no markdown, no prose).

JOB SEEKER: lives in צרופה (Tzrufa), Hof HaCarmel, northern Israel (near Zichron Yaakov/Hadera). Wants MANAGER-LEVEL roles only: מנהל/ת מערכות מידע, Information Systems Manager, IS Manager, מנמ"ר, CIO, Chief Information Officer, מנהל/ת טכנולוגיות, מנהל/ת אפליקציות, מנהל/ת יישומים עסקיים, Business Applications Manager, Information System Manager, Head of Information Systems, Head of IT, IT/IS manager. Target areas: north, the Sharon, the valleys (העמקים), plus hybrid roles anywhere. DISTANCE LIMIT: up to 65 km from Tzrufa INCLUSIVE, using the DISTANCE table below. Tel Aviv, Petah Tikva and a region-only "Center District" / "מרכז" are AT the limit (65 km) → INCLUDE them. EXCLUDE places beyond 65 km (Holon, Bat Yam, Be'er Yaakov, Yavne, Rishon, Rehovot, Ness Ziona, Gedera, Ashdod, Ashkelon, Kiryat Gat, Beer Sheva, Dimona, Jerusalem, Modiin, Lod, Ramla, Shoham) — UNLESS the job is hybrid/remote. If a job's location CANNOT be determined from the listing, EXCLUDE it (do NOT guess a distance and do NOT default it to near). Also EXCLUDE any listing marked removed/expired ("משרה זו הוסרה", "פג תוקף", closed).

Extract jobs ONLY from the BOARD TEXT below. EVERY job you output MUST literally appear in that BOARD TEXT — so it is real, currently open, and has a working link. Do NOT add any job from your own knowledge/memory, and do NOT include Civi / GovJobs / Greenhouse / municipal jobs unless they actually appear in the BOARD TEXT. If a job is not in the BOARD TEXT, leave it out. (Better fewer real jobs than any job whose link doesn't reach it.)

RULES:
- STRICT ROLE WHITELIST — include a job ONLY if its title is essentially one of these (the person HEADS the IS/IT/applications/technology function): מנהל/ת מערכות מידע, מנמ"ר, CIO, Chief Information Officer, מנהל/ת טכנולוגיות, מנהל/ת אפליקציות, מנהל/ת יישומים (applications MANAGER), מנהל/ת IT, Head of Information Systems, Head of IT, IT/IS Manager, Information Systems Manager / Information System Manager, IS Manager, Business Applications Manager.
- COMBINED TITLES count: if the title includes a whitelisted role alongside others (e.g. "CIO / CTO / Chief AI Officer", "CIO & VP Operations"), INCLUDE it. Contract / freelance / fractional roles count too.
- STRICT BLACKLIST — do NOT include (even if "מערכות מידע"/"IT" appears in the title): IT Risk / GRC / compliance, finance / FP&A, CISO / InfoSec / information security (also "CISO & Head of IT"), MIS-only, cloud-only (Head of Cloud), מנהל/ת פרויקטים / Project Manager / PMO / Portfolio / Delivery (Lead/Manager/Excellence), מנתח/ת מערכות / Systems Analyst, מיישם/ת / Implementer, אחראי/ת (coordinator — not a manager), ראש צוות / team lead, מפתח/ת / developer, תמיכה / Help Desk / Support, מנהל/ת מוצר / Product, sales, CCoE, מנהל/ת יישום של מערכת בודדת (single-system rollout — e.g. "מנהל מערכת Priority/SAP", "מנהל/ת מחלקת יישום", "מנהל/ת יישום מערכות"). (DO include "מנהל/ת אפליקציות/יישומים" that HEADS the applications domain.) When in doubt whether a title is a true IS/IT-MANAGEMENT role vs a project/analyst/coordinator role, EXCLUDE it — EXCEPT for jobs within ${NEAR_KM} km (GROUP 1): for those, when in doubt INCLUDE (the STRICT BLACKLIST below still applies to them).
- EXCLUDE support / help-desk / service-desk roles and their team leads — e.g. "ראש צוות תמיכה", "מנהל מוקד Help Desk", "תמיכה טכנית", "מוקד שירות", system administrator, NOC team lead. These are operational support, NOT information-systems management — do NOT include them.
- EXCLUDE information-SECURITY / cyber roles — they are NOT information-systems management: מנהל/ת אבטחת מידע, CISO, CISCO/CICO (mis-spellings of CISO), Information Security Manager/Officer, סייבר / Cyber, SOC, מנהל/ת סיכוני סייבר, GRC. Even if the title contains "מערכות מידע", if the role is about SECURITY, drop it.
- Also EXCLUDE narrow specialty-domain roles that are NOT the IS/IT-management function: CCoE / "Cloud Center of Excellence" / "מנהל תחום CCOE", pure cloud-platform leads, DBA / infrastructure-only, and similar single-domain titles. Include a role ONLY if it heads information systems / IT / applications / technology broadly (מנהל/ת מערכות מידע, מנמ"ר, CIO, Chief Information Officer, מנהל/ת טכנולוגיות, מנהל/ת אפליקציות, IT/IS manager).
- COVERAGE: scan the ENTIRE board text top to bottom, not only the first listings. Include EVERY qualifying role — northern jobs AND Sharon/Center jobs within ~65 km (e.g. Hod Hasharon, Kfar Saba, Herzliya, Tel Aviv) and hybrid roles. Do not stop after a few near-Haifa results.
- ACCURACY: use only facts that really appear; never invent a company or city. Recruiter/placement postings (השמה/גיוס/משאבי אנוש) → company = recruiter name or "חברה חסויה"; never attribute to a similarly-named real company.
- FRESHNESS: only currently-open jobs; exclude "No longer accepting"/"כבר לא מקבלים מועמדים"/"המשרה אוישה" and anything older than ~8 weeks. Municipal/tender pages: include ONLY if a date within ~8 weeks is shown.
- TITLE: copy the job title EXACTLY as written in the BOARD TEXT — never rephrase, translate, shorten or "upgrade" it (e.g. do NOT turn "IT Team Lead" into "IT Manager").
- HYBRID: set "yes"/"no" from the listing. LinkedIn search cards usually do NOT state the work mode → use "na" for them unless the card text itself says Hybrid/Remote/On-site. "no" = On-site / On site / Onsite / "עבודה מהמשרד" / "במשרדי החברה" / "לא היברידי" / "ללא עבודה מהבית". "yes" = Hybrid / היברידי / Remote / "מרחוק" / "עבודה מהבית" / "ימים מהבית". Words like "Full-time" / "משרה מלאה" say nothing about hybrid; on Drushim the hybrid flag may be hidden under the "משרה מלאה ועוד" expander. Use "na" only if truly not stated.
- DEDUPE the same job across sources.
- LINK (CRITICAL): If the job in the BOARD TEXT is followed by a real link in the form [URL:https://...], USE THAT EXACT URL — it is the genuine direct listing. ONLY if a job has NO [URL:...] next to it, build a search link (below). NEVER invent or guess a URL with an id/slug that did not appear as [URL:...] — fabricated links are broken. For jobs without a real [URL:...], output a SEARCH URL built from a SHORT query — the recruiter/agency or company name if one is shown (e.g. YifaTalent, לירון ואליס) — that is the BEST query; otherwise a short core role phrase from the title (e.g. "מוביל מערכות מידע", "מנהל מערכות מידע"). DO NOT add a city/region to the query — the listing's location wording often differs (e.g. it says "אזור צפון" but you'd write "חיפה") and that zeroes out the search. Keep the query short (never the full job title). Use EXACTLY these formats:
   • JobMaster → https://www.jobmaster.co.il/jobs/?q=<short query>
   • AllJobs or svt.jobs → https://www.alljobs.co.il/SearchResultsGuest.aspx?freetxt=<short query>
   • Drushim → https://www.drushim.co.il/jobs/search/<short query>/
   • LinkedIn → https://www.linkedin.com/jobs/search?keywords=<short query>&location=Israel
   • השועלה, עץ השדה, Aman, Norterra, ג'וב קרוב, זיוה בן פורת, Sharon Careers (added sites) → use the [URL:...] shown right next to that job in the BOARD TEXT if there is one; otherwise leave "url" EMPTY ("").
   • GovJobs, municipal, or anything else → https://www.google.com/search?q=<short query including the company name> (URL-encoded)
   LinkedIn locations look like "Haifa, Haifa District, Israel" — use the city. LinkedIn "Hybrid"/"Remote" in the card = hybrid "yes".
  URL-encode the query. When unsure, prefer the Google search format. Every link MUST lead to a non-empty results page.
- DISTANCE km from Tzrufa by stated city: Caesarea 12, Zichron Yaakov 5, Hadera 15, Pardes Hanna 12, Binyamina 8, Or Akiva 10, Yokneam 28, Haifa 25, Akko 45, Afula 45, Karmiel 50, Hod Hasharon 55, Ramat Hasharon 62, Kfar Saba 52, Tel Aviv 65, Petah Tikva 65, Herzliya 58, Holon 75, Shoham 75, Ariel 72, Modiin 85, Yavne 88, Tzfat 90, Rishon LeZion 80, Rehovot 85, Ness Ziona 83, Gedera 100, Ashdod 100, Ashkelon 115, Lod 75, Ramla 78, Bat Yam 75, Jerusalem 120, Kiryat Gat 140, Beer Sheva 160. Region only: "שפלה"/Shfela 90, "דרום"/South 140, "אזור ירושלים" 120. Multi-location → nearest city. Hybrid/remote with no fixed city → location "מרחוק/היברידי", km 0.
- LOCATION ACCURACY (IMPORTANT): use the location EXACTLY as the source states it. NEVER relocate a job to a closer/northern city or guess a city. If only a region is given, keep it and use its distance: מרכז / Center District ~65, השרון ~58, צפון / North ~40, ירושלים ~120, דרום / South ~140. For a job you add from your own memory (e.g. a LinkedIn role) where you are NOT sure of its CURRENT city — OMIT it rather than guess a location.

Each array item = {"title": "...", "company": "...", "location": "...", "km": <number>, "hybrid": "yes"|"no"|"na", "desc": "<one short Hebrew line>", "source": "<EXACTLY the board name from the ===== header of the section the job came from, e.g. JobMaster, AllJobs, דרושים, LinkedIn, השועלה, עץ השדה, Aman, Norterra, זיוה בן פורת, Sharon Careers>", "url": "https://..."}. PRIORITIES (most important first): GROUP 1 = km ≤ ${NEAR_KM} (any hybrid status); GROUP 2 = km > ${NEAR_KM} AND hybrid "yes"; GROUP 3 = km > ${NEAR_KM} and not hybrid. Include EVERY qualifying job — there is NO maximum count. Completeness matters most for GROUP 1, then GROUP 2 — never omit a qualifying GROUP 1 or GROUP 2 job. Output the array in that order: all GROUP 1 jobs (km ascending), then GROUP 2 (km ascending), then GROUP 3 (km ascending). Return ONLY the JSON array.

BOARD TEXT:${corpus}`;

// Parse Gemini's reply into a job array, repairing the usual breakages instead of failing the whole run:
// code fences, unescaped quotes in Hebrew abbreviations (בע"מ, מנכ"ל, אזה"ת), a cut-off reply, or one broken item.
function parseJobs(text, fin) {
  const t = String(text || '').replace(/```(?:json)?/gi, '')
    .replace(/([\u05d0-\u05ea])"(?=[\u05d0-\u05ea])/g, '$1״');   // Hebrew letter " Hebrew letter → gershayim (never a JSON delimiter)
  const s = t.indexOf('['); if (s < 0) return null;
  const e = t.lastIndexOf(']');
  if (e > s) { try { const a = JSON.parse(t.slice(s, e + 1)); if (Array.isArray(a)) return a; } catch {} }
  // fallback: parse item by item (items are flat objects), keep every one that parses
  const items = []; let bad = 0;
  for (const m of t.slice(s).matchAll(/\{[^{}]*\}/g)) { try { items.push(JSON.parse(m[0])); } catch { bad++; } }
  if (items.length) { console.log(`::warning::Gemini reply needed repair (${fin || 'unknown'}) — kept ${items.length} jobs${bad ? `, skipped ${bad} unreadable` : ''}.`); return items; }
  return null;
}
// 429 = rate limit. Per-MINUTE limit → wait the delay Gemini asks for and retry; per-DAY quota → no point waiting.
async function handle429(r, m) {
  const body = await r.text().catch(() => '');
  const daily = /PerDay/i.test(body);
  const delay = Math.min(90, (+((body.match(/"retryDelay"\s*:\s*"(\d+)/) || [])[1]) || 60) + 3);
  console.log(`::warning::Gemini ${m}: HTTP 429 (${daily ? 'daily free quota used up' : `per-minute limit — waiting ${delay}s and retrying`})`);
  if (!daily) await sleep(delay * 1000);
  return daily;
}

async function callGemini(promptText, models = MODELS) {
  // thinkingBudget capped (not the unbounded default that caused >120s timeouts) — enough reasoning to be thorough & classify correctly, still fast.
  const body = { contents: [{ role: 'user', parts: [{ text: promptText }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 32768, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 3000 } } };   // strict JSON → quotes are escaped
  let lastErr = '';
  for (const m of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {   // retry the SAME (working) model on timeout/5xx instead of falling to a dead quota
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${KEY}`;
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(170000) });
        if (r.status === 429) { const daily = await handle429(r, m); lastErr = `${m}: HTTP 429 (${daily ? 'daily free quota used up' : 'per-minute limit'})`; if (daily) break; continue; }
        if (!r.ok) { lastErr = `${m}: HTTP ${r.status} :: ${(await r.text()).slice(0, 400)}`; console.log(`::warning::Gemini ${lastErr.replace(/\s+/g, ' ').slice(0, 300)} (attempt ${attempt})`); await sleep(2000 * attempt); continue; }
        const j = await r.json();
        const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        const fin = j.candidates?.[0]?.finishReason || '';
        const arr = parseJobs(text, fin);
        if (!Array.isArray(arr)) { lastErr = `${m}: no JSON array in reply (${fin}) :: ${text.slice(0, 300)}`; console.log(`::warning::Gemini ${lastErr.replace(/\s+/g, ' ').slice(0, 300)} (attempt ${attempt})`); await sleep(2000 * attempt); continue; }
        console.log(`Gemini OK via model ${m} (attempt ${attempt}), ${arr.length} jobs${fin && fin !== 'STOP' ? ', finish=' + fin : ''}`);
        return arr;
      } catch (e) { lastErr = `${m}: ${e.message}`; console.log(`::warning::Gemini ${lastErr.replace(/\s+/g, ' ').slice(0, 300)} (attempt ${attempt})`); await sleep(2000 * attempt); }
    }
  }
  throw new Error('All Gemini models failed. Last error -> ' + lastErr);
}

// Which added site a job belongs to — by its name (Hebrew/English, spaces ignored) or by the site's domain.
const squash = x => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const hostKey = (v) => { try { return new URL(v).hostname.split('.').find(x => !['www', 'app', 'jobs'].includes(x)) || ''; } catch { return ''; } };
const siteOf = (j) => { const src = squash(j.source), u = String(j.url || '').toLowerCase();
  const head = n => squash(n).slice(0, 8);   // first 8 letters are enough — tolerates typos like "sharon careeres"
  return MORE_SITES.find(([n, v]) => (v || '').trim() && ((head(n) && src.includes(head(n))) || (hostKey(v) && (src.includes(hostKey(v).slice(0, 8)) || u.includes(hostKey(v) + '.'))))); };
// Guard: only allow known site-SEARCH URLs; anything else (fabricated ID paths, civi, blanks) -> Google search.
function safeUrl(j) {
  const u = (j.url || '').trim();
  if (realUrls.has(u)) return u;   // genuine direct listing URL extracted from a board page → use it
  const src = (j.source || '').toLowerCase();
  const site = siteOf(j);
  if (site) return site[1].trim();   // added site with no per-job link → open that site's jobs page
  const g = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q.replace(/\s+/g, ' ').trim());
  // For sources with no real/fetched URL: a Google search that actually RETURNS results.
  const co = (j.company && !/חסוי|confidential/i.test(j.company)) ? j.company : '';  // drop "חברה חסויה" filler from the query
  const loc = (j.location && j.location !== 'na' && !/מרחוק|היבריד|רב.?אזורי|לא צוין|מרכז|צפון|דרום|שרון|עמק/i.test(j.location)) ? j.location : '';  // add a concrete city for precision
  const base = `${j.title || ''} ${co} ${loc}`;
  if (src.includes('linkedin') || /linkedin\.com/i.test(u)) return g(`${base} site:linkedin.com/jobs`);
  if (src.includes('gov')) return g(`${base} דרושים מכרז`);                           // govojobs indexing unreliable → softer query that still returns results
  const allowed = /^https:\/\/(www\.jobmaster\.co\.il\/jobs\/\?q=|www\.alljobs\.co\.il\/SearchResultsGuest|www\.drushim\.co\.il\/jobs\/search\/|www\.linkedin\.com\/jobs\/search|www\.google\.com\/search)/i.test(u);
  return allowed ? u : g(`${base} דרושים`);
}
let jobs = [], geminiError = '';
if (!pages.length) {   // nothing loaded → don't ask Gemini (it would invent jobs); keep the previous page
  console.log(`::error::Page NOT updated (previous page kept). No board could be loaded (blocked: ${[...new Set(blocked)].join(', ')}).`);
  process.exit(1);
}
try { jobs = await callGemini(PROMPT, [MODELS[0]]); }   // main pass: strong model only — the fallback model misses whole sources, better to keep the previous page
 catch (err) { geminiError = err.message; console.error('Gemini failed:', err.message); }
if (geminiError) { console.log(`::error::Page NOT updated (previous page kept). Gemini failed — ${geminiError}`); process.exit(1); }
// Focused pass on GROUP 1: only the excerpts around near places, inclusive when in doubt. Its jobs are ADDED (duplicates are removed below).
if (nearCorpus && !geminiError) {
  const NEAR_PROMPT = PROMPT.slice(0, PROMPT.lastIndexOf('BOARD TEXT:')) +
    `FOCUS FOR THIS PASS: the BOARD TEXT below contains ONLY excerpts around places within ${NEAR_KM} km of Tzrufa. List EVERY job in it that is LOCATED in such a place and fits the roles — completeness is critical here; when unsure whether a title qualifies, INCLUDE it. Ignore jobs whose location is elsewhere.\n\nBOARD TEXT:` + nearCorpus;
  try { const extra = await callGemini(NEAR_PROMPT); console.log(`  Focused near pass: ${extra.length} jobs`); jobs = [...(jobs || []), ...extra]; }
  catch (err) { console.log(`::warning::Focused near pass failed (main results still used): ${err.message.slice(0, 200)}`); }
}
const rawCount = (jobs || []).length;
jobs = (jobs || []).filter(j => j && j.title).map(j => ({
  title: String(j.title).trim(), company: String(j.company || 'לא צוין').trim(),
  location: String(j.location || '').trim(), km: Number.isFinite(+j.km) ? +j.km : 40,
  hybrid: ['yes', 'no', 'na'].includes(j.hybrid) ? j.hybrid : 'na',
  desc: String(j.desc || '').trim(), source: String(j.source || '').trim(), url: safeUrl(j),
}));
jobs.forEach(j => { const st = siteOf(j); if (st) j.source = st[0]; });   // one source name per added site (e.g. "Civi"/"Ziva Ben Porat" → the Hebrew site name)
// ---- job identity keys (used by carry-over, dedupe and the "appeared before" history) ----
const norm = s => s.toLowerCase().replace(/\//g, '').replace(/\s+/g, ' ').trim();
const normCo = c => norm(c).replace(/^(קבוצת|קבוצה|חברת|רשת|חב')\s+/, '').trim();   // "קבוצת HOT" == "HOT"
const titleKey = j => `${norm(j.title)}|${normCo(j.company)}`;
// STABLE listing id from the URL (survives recruiter title edits between days), or null if it's only a search link.
const idKey = j => {
  const u = j.url || '';
  let m;
  if ((m = u.match(/checknum\.asp\?key=(\d+)/i))) return 'jm:' + m[1];
  if ((m = u.match(/UploadSingle\.aspx\?JobID=(\d+)/i))) return 'aj:' + m[1];
  if ((m = u.match(/drushim\.co\.il\/job\/(\d+)/i))) return 'dr:' + m[1];
  if ((m = u.match(/linkedin\.com\/jobs\/view\/(?:[^\/?]*-)?(\d+)/i))) return 'li:' + m[1];
  return null;
};
// Each job carries BOTH keys; two jobs are "the same" if EITHER matches — so a day that stored only titles still matches a day that has ids, and vice-versa.
// LOOSE key: tolerant to small wording changes between runs (gender markers, job codes, punctuation, company suffixes).
const coreTitle = t => String(t || '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ')                                  // (1234), (ת)
  .replace(/[a-z]*-?\d[\w-]*/g, ' ')                           // job codes: 17725, JB-5480
  .replace(/(\S)\s*[\/.]\s*(ת|ית|ה)(?=\s|$)/g, '$1')            // מנהל/ת, מנהל.ת, מנהל /ת → מנהל
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').filter(w => !['ת', 'ית', 'ה'].includes(w))      // stray gender markers ("מנהל ת")
  .map(w => /^[\u05d0-\u05ea]{4,}$/.test(w) ? w.replace(/ית$|ת$/, '') : w)   // מנהלת / סגןית (slash already removed) → מנהל / סגן
  .join(' ');
const coreCo = c => { const x = String(c || '').toLowerCase().replace(/חסוי|חסויה|confidential|חברה חסויה|לא צוין|^na$/g, '')
  .replace(/\b(ltd|inc|israel|group)\b|בע"?מ|ישראל|^(קבוצת|חברת|רשת)\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim(); return x; };
const looseKey = j => { const co = coreCo(j.company);
  return 'L:' + coreTitle(j.title) + '|' + (co || ('@' + String(j.location || '').toLowerCase().split(/[,\s]+/)[0])); };   // no company → use first location word
const isSitePage = u => MORE_SITES.some(([, v]) => (v || '').trim() && String(u || '').replace(/\/$/, '') === v.trim().replace(/\/$/, ''));
const directUrlKey = j => { const u = String(j.url || '').split('#')[0];
  return /^https?:\/\//.test(u) && !/google\.com\/search|linkedin\.com\/jobs\/search|jobs-guest/i.test(u) && !isSitePage(u) && !/[?&](q|freetxt|keywords|search_category)=/i.test(u) ? 'u:' + u.replace(/\/$/, '') : ''; };
const keysOf = j => { const k = [titleKey(j), looseKey(j)]; const id = idKey(j); if (id) k.push(id); const du = directUrlKey(j); if (du) k.push(du); return k; };
// CARRY-OVER: Gemini's output varies between runs, so a still-listed job can vanish for one run. Keep jobs that were REALLY found
// in the last 2 days but are missing now. They go through ALL the checks below again (title rules, distance, LinkedIn page, expiry).
const CARRY_DAYS = 2;
const isoToday = D.split('.').reverse().join('-');
let prevShown = []; try { prevShown = JSON.parse(await readFile('data/jobs-shown.json', 'utf8')); } catch {}
jobs.forEach(j => { j.lastReal = isoToday; });
{ const nowKeys = new Set(jobs.flatMap(keysOf));
  const cutC = new Date(Date.parse(isoToday) - CARRY_DAYS * 864e5).toISOString().slice(0, 10);
  const carried = (Array.isArray(prevShown) ? prevShown : []).filter(p => p && p.title && p.lastReal >= cutC && !keysOf(p).some(k => nowKeys.has(k)));
  if (carried.length) {
    console.log(`::notice::Kept ${carried.length} job(s) found in the last ${CARRY_DAYS} days but missing from this run's Gemini output: ${carried.map(p => p.title).join(' · ').slice(0, 700)}`);
    jobs.push(...carried.map(p => ({ title: p.title, company: p.company || '', location: p.location || '', km: Number.isFinite(+p.km) ? +p.km : 40,
      hybrid: ['yes', 'no', 'na'].includes(p.hybrid) ? p.hybrid : 'na', desc: p.desc || '', source: p.source || '', url: (p.url || '').trim() || safeUrl(p), lastReal: p.lastReal, carried: true })));
  } }
// Far places: a location ONLY in the Shfela / south / Jerusalem gets at least its real distance (so a non-hybrid job there is dropped).
const FAR = [[/שפלה|shfela|shephelah/i, 90], [/רחובות|rehovot/i, 85], [/נס ציונה|ness ziona/i, 83], [/גדרה|gedera/i, 100], [/יבנה|yavne/i, 88],
  [/אשדוד|ashdod/i, 100], [/אשקלון|ashkelon/i, 115], [/קרי?ית גת|kiryat gat/i, 140], [/באר שבע|beer ?sheva|be'er sheva/i, 160],
  [/ירושלים|jerusalem/i, 120], [/בית.?שמש|beit.?shemesh/i, 110], [/חולון|holon/i, 75], [/בת.?ים|bat.?yam/i, 75], [/(^|[\s,])לוד|\blod\b/i, 75], [/רמלה|ramla/i, 78], [/מודיעין|modiin/i, 85], [/ראשון לציון|rishon/i, 80], [/דרום|south district/i, 140]];
const MID = /תל.?אביב|tel.?aviv|פתח.?תקו|petah|הרצליה|herzliya|רמת.?גן|ramat.?gan|גבעתיים|givatayim|בני.?ברק|bnei.?brak|רעננה|ra'?anana|כפר.?סבא|kfar.?saba|נתניה|netanya|הוד.?השרון|hod.?hasharon|ראש.?העין|rosh.?ha|אור.?יהודה|or.?yehuda|מרכז|center/i;   // multi-location with a nearer city → keep nearest
const cityPart = l => String(l || '').replace(/,?\s*(center|central|tel aviv|haifa|north(ern)?|south(ern)?|jerusalem)\s+district\b.*$/i, '').replace(/,?\s*מחוז\s+\S+.*$/, '').replace(/,?\s*israel\s*$/i, '');   // "Rishon LeZion, Center District, Israel" → "Rishon LeZion"
jobs.forEach(j => { const loc = cityPart(j.location); if (nearKm(j.location) !== null || MID.test(loc)) return;
  const f = FAR.filter(([re]) => re.test(loc)).map(([, km]) => km);
  if (f.length) j.km = Math.max(j.km, Math.min(...f)); });
// Near places: distance fixed in code (never let a wrong estimate push a near job out of GROUP 1).
jobs.forEach(j => { const k = nearKm(j.location); if (k !== null && k < j.km) j.km = k; });
// Title rules enforced in code (Gemini doesn't always obey the blacklist).
const BROAD = /מערכות מידע|information systems|information technology(?! infrastructure)|\bCIO\b|chief information|head of (it|information|technology)|מנמ"?ר|\bIT manager|IT director|director of (it|information)|מנהל\/?ת? (it|טכנולוגיות|אפליקציות|יישומים)|applications manager/i;
const TITLE_BLOCK = /team ?lead|ראש(ת)? צוות|devops|developer|^\s*מפתח|מפתח\/ת|מפתחת|analyst|מנתח|project manager|מנהל\/?ת? פרויקט|\bPMO\b|engineer|מהנדס|\bDBA\b|CCoE|junior|ג'וניור|\brisk\b|סיכונ|\bGRC\b|compliance|(^|[\s,–-])ו?ציות(?=[\s,–-]|$)|FP&A|\bfinance\b|כספים|controller|(^|\s)חשב(\/?ת)?(\s|$)|\bCISO\b|infosec|information security officer/i;   // never a fit (incl. risk, finance, CISO — even "CISO & Head of IT")
const SOFT_BLOCK = /help ?desk|service ?desk|תמיכה|\bsupport\b/i;   // support roles — dropped unless the title is ALSO broad IS/IT management
const NARROW = /infrastructure|תשתיות|security|אבטחת מידע|סייבר|cyber|\bMIS\b|\bcloud\b|ענן/i;   // narrow domain — kept only if the title is ALSO broad IS/IT management
const droppedTitles = [];
const applyTitleRules = () => { jobs = jobs.filter(j => { const t = j.title;
  // judge "broad" WITHOUT the narrow words: "Head of IT Infrastructure" → "Head of" (narrow), "מנהל/ת מערכות מידע ואבטחת מידע" → still broad
  const broad = BROAD.test(t.replace(/(information technology|\bit)\s+infrastructure|infrastructure|תשתיות(\s+(it|מחשוב))?|(information\s+)?security|אבטחת מידע|סייבר|cyber|\bCISO\b|\bMIS\b|\bcloud\b|ענן/ig, ' '));
  const bad = TITLE_BLOCK.test(t) || ((NARROW.test(t) || SOFT_BLOCK.test(t)) && !broad);
  if (bad) droppedTitles.push(t); return !bad; }); };
// Gemini sometimes rewrites/"upgrades" titles (e.g. "IT Team Lead" → "IT Manager") → restore the real LinkedIn card title first.
const fixedTitles = [];
jobs.forEach(j => { const t = srcTitle.get(j.url); if (t && t.toLowerCase() !== j.title.toLowerCase()) { fixedTitles.push(`${j.title} → ${t}`); j.title = t; } });
applyTitleRules();

// LinkedIn search cards don't show Hybrid/On-site → open each LinkedIn job page and look for an EXPLICIT statement.
// Only an explicit hybrid/remote statement makes it "yes"; anything unclear stays "na" (better to miss a hybrid than to mislabel an on-site job).
// Specific "closed" phrases only, tested on VISIBLE text (scripts/styles removed) — generic words like "לא נמצאה" appear on valid pages too.
const EXPIRED = /משרה זו הוסרה|המשרה הוסרה|הוסרה מהלוח|המשרה אוישה|המשרה אינה פעילה|משרה זו אינה פעילה|המשרה לא נמצאה|המשרה אינה קיימת|תוקף המשרה פג|no longer accepting applications|this job is no longer available|כבר לא מקבלים מועמדים/i;
const visibleText = h => decodeEntities(String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const expiredDrops = [];
const HYB_YES = /\bhybrid\b(?![\s-]*(cloud|environment|infrastructure|it\b|architecture|solution|system|data|network))|היברידי|work(ing)? from home|\bWFH\b|remote work|fully remote|remote position|remote-first|עבודה מהבית|ימים? מהבית/i;
const HYB_NO = /\bon[\s-]?site\b|from the office|מהמשרד|במשרדי החברה|לא היברידי|ללא עבודה מהבית/i;
let liRead = 0, liYes = 0, liNo = 0;
for (const j of jobs) {
  const m = (j.url || '').match(/linkedin\.com\/jobs\/view\/(?:[^\/?]*-)?(\d+)/i);
  if (!m) { if (/linkedin/i.test(j.source)) j.hybrid = 'na'; continue; }   // LinkedIn job we can't open → Gemini's guess isn't trusted
  await sleep(1200);   // pace LinkedIn requests
  let h = '';
  for (const u of [j.url, `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`]) {
    try { const r = await fetch(u, { headers: { 'User-Agent': UAS[0], 'Accept-Language': 'en-US,en;q=0.9,he;q=0.8' }, signal: AbortSignal.timeout(15000) });
      if (r.ok) { h = await r.text(); if (h.length > 2000) break; } } catch {}
  }
  if (!h) { j.hybrid = 'na'; continue; }   // couldn't read the page → can't confirm hybrid
  liRead++;
  if (EXPIRED.test(visibleText(h))) { j.expired = true; expiredDrops.push(j.title); continue; }
  const t = h.replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const h1 = (h.match(/<h1[^>]*class="[^"]*(top-card-layout__title|topcard__title|job-title)[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[2];   // job-title heading only
  const pageTitle = h1 ? h1.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : '';
  if (pageTitle && pageTitle.length <= 150 && pageTitle.toLowerCase() !== j.title.toLowerCase()) { fixedTitles.push(`${j.title} → ${pageTitle}`); j.title = pageTitle; }
  const yes = /"jobLocationType"\s*:\s*"TELECOMMUTE"/i.test(h) || HYB_YES.test(t), no = HYB_NO.test(t);
  j.hybrid = yes && !no ? 'yes' : (no && !yes ? 'no' : 'na');
  if (j.hybrid === 'yes') liYes++; else if (j.hybrid === 'no') liNo++;
}
jobs = jobs.filter(j => !j.expired);
applyTitleRules();   // again, with the real titles from the job pages
if (fixedTitles.length) console.log(`::notice::Titles corrected to the real LinkedIn title (${fixedTitles.length}): ${fixedTitles.join(' · ').slice(0, 900)}`);
if (droppedTitles.length) console.log(`::notice::Dropped by title rules (${droppedTitles.length}): ${droppedTitles.join(' · ').slice(0, 900)}`);
console.log(`::notice::LinkedIn work-mode check: read ${liRead} job pages — ${liYes} hybrid/remote, ${liNo} on-site, the rest not stated.`);
// Distance cap: keep only jobs within ~65 km of Tzrufa, OR hybrid (which can be anywhere).
jobs = jobs.filter(j => j.km <= 65 || j.hybrid === 'yes');

// Expiry check: open each direct-listing page and DROP jobs marked removed/expired/closed.
const isDirect = (u) => /checknum\.asp|alljobs\.co\.il\/Search\/UploadSingle|drushim\.co\.il\/job\//i.test(u);   // LinkedIn already checked above
const checked = [];
for (const j of jobs) {
  if (!isDirect(j.url)) { checked.push(j); continue; }   // search/Google links can't be expiry-checked → keep
  try {
    const r = await fetch(j.url, { headers: { 'User-Agent': UAS[0], 'Accept-Language': 'he-IL' }, signal: AbortSignal.timeout(15000) });
    const t = r.ok ? visibleText(await r.text()) : '';
    if (EXPIRED.test(t)) { expiredDrops.push(j.title); continue; }
  } catch { /* on error, keep the job */ }
  checked.push(j);
}
jobs = checked;
if (expiredDrops.length) console.log(`::notice::Dropped as closed/removed at the source (${expiredDrops.length}): ${expiredDrops.join(' · ').slice(0, 900)}`);

// DEDUPE — drop a posting if EITHER its stable id OR its title|company was already seen. This catches the SAME job listed on
// two boards (different ids) as well as exact repeats. Keeps the first (usually the direct-link source).
{ const words = j => new Set(coreTitle(j.title).split(' ').filter(Boolean));
  const sub = (a, b) => a.size > 0 && [...a].every(w => b.has(w));
  jobs = jobs.filter(j => { if (!isSitePage(j.url)) return true;
    const wj = words(j);
    return !jobs.some(k => k !== j && k.source === j.source && !isSitePage(k.url) && (sub(words(k), wj) || sub(wj, words(k)))); });
}
{ const seen = new Set();   // same job if ANY key matches: listing id, exact title|company, or the tolerant (loose) key
  jobs = jobs.filter(j => { const ks = keysOf(j); if (ks.some(k => seen.has(k))) return false; ks.forEach(k => seen.add(k)); return true; });
}
const readJson = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
let T = await readJson('data/jobs-today.json');
let Y = await readJson('data/jobs-yesterday.json');
if (T && T.date && T.date !== D) Y = T;          // new day → roll over (kept for compatibility)
if (!Y) Y = { date: '', keys: [] };
// HISTORY: every key ever shown in the last 45 days → { f: first-seen date, l: last-seen date } (ISO yyyy-mm-dd).
// "Appeared before" = first seen on an EARLIER day, in ANY run (not only the previous day's last run).
const iso = d => (d || '').split('.').reverse().join('-');   // 25.06.2026 → 2026-06-25
const TODAY = iso(D);
let H = await readJson('data/seen.json');
if (!H || typeof H !== 'object') {   // first run with history → seed from the old state files
  H = {};
  for (const st of [Y, T]) if (st && st.date && Array.isArray(st.keys)) for (const k of st.keys) {
    const d = iso(st.date);
    const ks = [k];   // old "title|company" keys → also derive the loose key (when the company is known)
    if (!/^(L:|jm:|aj:|dr:|li:)/.test(k) && k.includes('|')) { const [t, c] = k.split('|'); if (coreCo(c)) ks.push(looseKey({ title: t, company: c })); }
    for (const x of ks) { if (!H[x]) H[x] = { f: d, l: d }; else { if (d < H[x].f) H[x].f = d; if (d > H[x].l) H[x].l = d; } } }
}
jobs.forEach(j => { j.ystd = keysOf(j).some(k => H[k] && H[k].f < TODAY); });
for (const j of jobs) for (const k of keysOf(j)) { if (!H[k]) H[k] = { f: TODAY, l: TODAY }; else H[k].l = TODAY; }
{ const cut = new Date(Date.parse(TODAY) - 45 * 864e5).toISOString().slice(0, 10);
  for (const k of Object.keys(H)) if (!H[k] || H[k].l < cut) delete H[k]; }
console.log(`  New today: ${jobs.filter(j => !j.ystd).length} of ${jobs.length} (history holds ${Object.keys(H).length} keys).`);
const todayState = { date: D, keys: jobs.flatMap(keysOf) };

// ---- render fixed template ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hb = { yes: '<span class="yes">כן</span>', no: '<span class="no">לא</span>', na: '<span class="na">לא צוין</span>' };
const sorted = [...jobs].sort((a, b) => a.km - b.km);
const rowsHtml = list => list.map(j => `<tr class="${j.km <= NEAR_KM ? 'near' : ''}" data-src="${esc(j.source)}" data-hyb="${j.hybrid}" data-near="${j.km <= NEAR_KM}" data-new="${!j.ystd}">
  <td class="title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></td>
  <td class="desc">${esc(j.desc)}</td>
  <td class="loc${String(j.location).length > 28 ? ' long' : ''}">${esc(j.location)}<span class="km">~${j.km} ק"מ</span></td>
  <td>${hb[j.hybrid]}</td><td><span class="src">${esc(j.source)}</span></td><td>${esc(j.company)}</td>
  <td>${j.ystd ? '<span class="old">כן</span>' : '<span class="new">לא · חדש</span>'}</td></tr>`).join('');
const sources = [...new Set(jobs.map(j => j.source).filter(Boolean))];
const srcButtons = sources.map(s => `<button data-f="${esc(s)}">${esc(s)}</button>`).join('');
const emptyNote = empty.length ? ` ${[...new Set(empty)].join(', ')} נטענו אך בלי רשימת משרות (כנראה האתר טוען אותה ב-JavaScript) — לבדוק ידנית.` : '';
const trimNote = trimmed.length ? ` ${[...new Set(trimmed)].join(', ')} לא נכללו היום — חריגה מכמות הטקסט המקסימלית ל-Gemini.` : '';
const note = (blocked.length
  ? `⚠ הערה: ${loaded.length}/${BOARDS.length} חיפושים נטענו ישירות היום (${[...new Set(loaded)].join(', ')}). ${[...new Set(blocked)].join(', ')} חסמו גישה אוטומטית ולכן לא נסרקו ישירות.`
  : `כל הלוחות נטענו ישירות בהצלחה.`) + emptyNote + trimNote;

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
 .desc{color:var(--muted);font-size:13px;max-width:320px;line-height:1.5}.loc{white-space:nowrap}.loc.long{white-space:normal;min-width:120px;max-width:170px}.km{display:block;color:var(--good);font-size:11.5px;margin-top:3px}
 .yes{color:var(--good);font-weight:600}.no{color:var(--muted)}.na{color:#64748b;font-size:12px}
 .src{font-size:12px;background:#334155;padding:3px 9px;border-radius:6px;white-space:nowrap}
 .new{background:var(--good);color:#063527;font-weight:700;padding:3px 9px;border-radius:6px;font-size:12px}.old{color:var(--muted);font-size:12px}
 .secbar{margin:20px 0 8px;font-size:14px;color:var(--good);font-weight:600;border-bottom:1px solid var(--line);padding-bottom:6px}.secbar.far{color:var(--muted)}.secbar.hyb{color:var(--accent)}
 footer{color:var(--muted);font-size:12px;text-align:center;padding:22px;border-top:1px solid var(--line);margin-top:26px;line-height:1.8}
 @media(max-width:820px){.desc{max-width:none}}
</style>
<header><div class="wrap" style="padding-bottom:0">
 <h1>🎯 משרות מערכות מידע — לוח אישי</h1>
 <span class="stamp">🔄 עודכן לאחרונה: ${esc(dFull)}</span>
 <div class="note">${esc(note)}</div>
 <div class="sub">מנהל/ת מערכות מידע · מנמ"ר · CIO · מנהל/ת טכנולוגיות · מנהל/ת אפליקציות · IT/IS Manager &nbsp;|&nbsp; ממוין לפי מרחק מצרופה · רץ אוטומטית ב-GitHub Actions</div>
 <div style="margin-top:8px;font-size:14px"><a href="guide.html" target="_blank" style="color:var(--accent);font-weight:600;text-decoration:none">📘 לביצוע שינויים בפיתוח ↗</a></div>
</div></header>
<div class="wrap">
 <div class="filters" id="filters">
  <button class="active" data-f="all">הכל</button>
  <button data-f="near">עד ${NEAR_KM} ק"מ ✓</button>
  <button data-f="new">חדש היום</button>
  <button data-f="hybrid">היברידי</button>
  ${srcButtons}
 </div>
 <div class="count" id="count"></div>
 <div class="secbar">📍 עד ${NEAR_KM} ק"מ מצרופה</div>
 <table><thead><tr><th>שם המשרה</th><th>תיאור התפקיד</th><th>מיקום</th><th>היברידי</th><th>אתר המקור</th><th>שם החברה</th><th>הופיע בעבר?</th></tr></thead>
  <tbody>${rowsHtml(sorted.filter(j => j.km <= NEAR_KM)) || '<tr><td colspan="7" style="color:#64748b;padding:16px">אין כרגע משרות עד ${NEAR_KM} ק"מ</td></tr>'}</tbody></table>
 <div class="secbar hyb">🏠 מעבר ל-${NEAR_KM} ק"מ — היברידי · לפי מרחק עולה</div>
 <table><thead><tr><th>שם המשרה</th><th>תיאור התפקיד</th><th>מיקום</th><th>היברידי</th><th>אתר המקור</th><th>שם החברה</th><th>הופיע בעבר?</th></tr></thead>
  <tbody>${rowsHtml(sorted.filter(j => j.km > NEAR_KM && j.hybrid === 'yes'))}</tbody></table>
 <div class="secbar far">📌 מעבר ל-${NEAR_KM} ק"מ — לא היברידי / לא צוין · לפי מרחק עולה</div>
 <table><thead><tr><th>שם המשרה</th><th>תיאור התפקיד</th><th>מיקום</th><th>היברידי</th><th>אתר המקור</th><th>שם החברה</th><th>הופיע בעבר?</th></tr></thead>
  <tbody>${rowsHtml(sorted.filter(j => j.km > NEAR_KM && j.hybrid !== 'yes'))}</tbody></table>
</div>
<footer>הנתונים נאספים אוטומטית — מומלץ לוודא כל מודעה במקור לפני הגשה. המרחקים אומדן אווירי מצרופה.<br>רץ 3 פעמים ביום ב-GitHub Actions (Gemini), ללא תלות בחשבונות חיצוניים.</footer>
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

// SAFETY: never replace a good page with an empty one. If today produced 0 jobs (Gemini failed / all filtered / boards blocked),
// keep yesterday's page & state untouched so the user still sees the last good listings.
if (jobs.length === 0) {
  const why = geminiError
    ? `Gemini failed — ${geminiError}`
    : `Gemini returned ${rawCount} jobs, 0 left after filtering. Boards loaded: ${loaded.length}/${BOARDS.length}.`;
  console.log(`::${geminiError ? 'error' : 'warning'}::Page NOT updated (previous page kept). ${why}`);
  process.exit(geminiError ? 1 : 0);   // Gemini failure → red X in Actions, so it is visible
}
await mkdir('data', { recursive: true });
await writeFile('index.html', html, 'utf8');
await writeFile('data/jobs-today.json', JSON.stringify(todayState, null, 2), 'utf8');
await writeFile('data/seen.json', JSON.stringify(H), 'utf8');
await writeFile('data/jobs-shown.json', JSON.stringify(jobs.map(j => ({ title: j.title, company: j.company, location: j.location, km: j.km, hybrid: j.hybrid, desc: j.desc, source: j.source, url: j.url, lastReal: j.lastReal || isoToday })), null, 1), 'utf8');
await writeFile('data/jobs-yesterday.json', JSON.stringify(Y, null, 2), 'utf8');
console.log(`::notice::Page updated: ${jobs.length} jobs (${jobs.filter(j => j.km <= NEAR_KM).length} within ${NEAR_KM} km). Loaded ${[...new Set(loaded)].join(', ') || 'none'}; blocked ${[...new Set(blocked)].join(', ') || 'none'}.`);
console.log(`Done: ${jobs.length} jobs (${jobs.filter(j => j.km <= NEAR_KM).length} within ${NEAR_KM}km), loaded ${loaded.join(',') || 'none'}, blocked ${blocked.join(',') || 'none'}`);

