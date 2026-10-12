'use strict';

/*
 * Studio 1400 — opnames per ministerie kiezen en afspelen op een iPad.
 *
 * - De app-bestanden komen via de service worker uit de cache (offline).
 * - De opnames leest de beheerder in vanuit een map in de Bestanden-app.
 *   Ze staan daarna in IndexedDB op de iPad en gaan nooit online.
 * - Huisstijlbestanden (RO Sans, logo) kunnen in de submap _huisstijl staan.
 *
 * Verhoog VERSIE hier én in sw.js bij elke wijziging.
 */

const VERSIE = '1.0.0';
const RUST_NA_MS = 2 * 60 * 1000;      // terug naar beginscherm na 2 minuten zonder gebruik
const LANG_DRUKKEN_MS = 3000;           // zo lang op de blauwe balk drukken opent Beheer
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const AUDIO_EXT = /\.(mp3|m4a|aac|wav)$/i;
const LETTER_EXT = /\.(woff2?|ttf|otf)$/i;
const LOGO_NAAM = /^logo\.(svg|png|jpe?g|webp)$/i;
const HUISSTIJL_MAP = /^_huisstijl$/i;
const OVERIG = 'Overige opnames';

const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

const vergelijk = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' }).compare;

const $ = (id) => document.getElementById(id);
const el = {
  balk: $('balk'),
  logoStrook: $('logo-strook'),
  lijstMinisteries: $('lijst-ministeries'),
  opnamesKop: $('opnames-kop'),
  kopOpnames: $('kop-opnames'),
  samenvatting: $('samenvatting'),
  lijstOpnames: $('lijst-opnames'),
  hint: $('hint'),
  leeg: $('leeg'),
  knopLeegBeheer: $('knop-leeg-beheer'),
  spelerKnop: $('speler-knop'),
  spelerTitel: $('speler-titel'),
  spelerMinisterie: $('speler-ministerie'),
  voortgang: $('voortgang'),
  tijdNu: $('tijd-nu'),
  tijdTotaal: $('tijd-totaal'),
  beheer: $('beheer'),
  beheerWaarschuwing: $('beheer-waarschuwing'),
  knopMap: $('knop-map'),
  invoerMap: $('invoer-map'),
  inlezen: $('inlezen'),
  inlezenBalk: $('inlezen-balk'),
  inlezenTekst: $('inlezen-tekst'),
  beheerMelding: $('beheer-melding'),
  opslagTekst: $('opslag-tekst'),
  versie: $('versie'),
  knopUpdate: $('knop-update'),
  knopWissen: $('knop-wissen'),
  knopSluiten: $('knop-sluiten'),
  status: $('status'),
  audio: $('audio'),
};

/* ---------- Toestand ---------- */

let bibliotheek = new Map();   // sleutel -> { naam, opnames: [] }
let gekozen = null;            // sleutel van het gekozen ministerie
let huidige = null;            // opname die in de speler staat
const blobUrls = new Map();    // opname-id -> object-URL
let sleept = false;
let bezig = false;             // inlezen loopt
let laatsteActie = Date.now();
let inRust = true;
let updateKlaar = false;
let handmatigeUpdate = false;
let wekslot = null;
let logoUrl = null;
let geladenLetters = [];

/* ---------- IndexedDB ---------- */

let dbBelofte = null;

function db() {
  if (!dbBelofte) {
    dbBelofte = new Promise((resolve, reject) => {
      const req = indexedDB.open('studio1400', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('meta');
        d.createObjectStore('opnames', { keyPath: 'id' });
        d.createObjectStore('audio', { keyPath: 'id' });
        d.createObjectStore('huisstijl', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbBelofte;
}

function verzoek(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function afgerond(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error || tx.error);
    tx.onabort = (e) => reject(e.target.error || tx.error || new Error('Opslaan afgebroken'));
  });
}

async function haal(winkel, sleutel) {
  const tx = (await db()).transaction(winkel);
  return verzoek(tx.objectStore(winkel).get(sleutel));
}

async function alles(winkel) {
  const tx = (await db()).transaction(winkel);
  return verzoek(tx.objectStore(winkel).getAll());
}

async function zetMeta(sleutel, waarde) {
  const tx = (await db()).transaction('meta', 'readwrite');
  tx.objectStore('meta').put(waarde, sleutel);
  return afgerond(tx);
}

async function bewaar(winkels, records) {
  const tx = (await db()).transaction(winkels, 'readwrite');
  for (const [winkel, record] of records) tx.objectStore(winkel).put(record);
  return afgerond(tx);
}

async function verwijderIds(winkels, ids) {
  if (!ids.length) return;
  const tx = (await db()).transaction(winkels, 'readwrite');
  for (const winkel of winkels) {
    const st = tx.objectStore(winkel);
    for (const id of ids) st.delete(id);
  }
  return afgerond(tx);
}

async function wisAlles() {
  const winkels = ['meta', 'opnames', 'audio', 'huisstijl'];
  const tx = (await db()).transaction(winkels, 'readwrite');
  for (const w of winkels) tx.objectStore(w).clear();
  return afgerond(tx);
}

/* Verwijder resten van oude of afgebroken inleesrondes. */
async function ruimOp() {
  const batch = await haal('meta', 'batch');
  const huisBatch = await haal('meta', 'huisstijlBatch');
  const oud = (await alles('opnames')).filter((o) => o.batch !== batch).map((o) => o.id);
  await verwijderIds(['opnames', 'audio'], oud);
  const oudHuis = (await alles('huisstijl')).filter((h) => h.batch !== huisBatch).map((h) => h.id);
  await verwijderIds(['huisstijl'], oudHuis);
}

/* ---------- Duur bepalen zonder af te spelen ---------- */
/* iPadOS laadt geen metadata van audio zonder tik. Daarom lezen we de duur uit het bestand zelf. */

const MP3_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_HZ = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function tekstOp(b, p, n) {
  let s = '';
  for (let i = 0; i < n && p + i < b.length; i++) s += String.fromCharCode(b[p + i]);
  return s;
}

function leesMp3Kop(b, p) {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const versie = (b[p + 1] >> 3) & 3;   // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const laag = (b[p + 1] >> 1) & 3;     // 1 = Layer III
  if (versie === 1 || laag !== 1) return null;
  const bitIndex = b[p + 2] >> 4;
  const hzIndex = (b[p + 2] >> 2) & 3;
  if (bitIndex === 0 || bitIndex === 15 || hzIndex === 3) return null;
  const mpeg1 = versie === 3;
  const kbps = (mpeg1 ? MP3_KBPS.mpeg1 : MP3_KBPS.mpeg2)[bitIndex];
  const hz = MP3_HZ[versie][hzIndex];
  const samples = mpeg1 ? 1152 : 576;
  const lengte = Math.floor((samples / 8) * kbps * 1000 / hz) + ((b[p + 2] >> 1) & 1);
  return { mpeg1, kbps, hz, samples, lengte, mono: (b[p + 3] >> 6) === 3 };
}

function duurMp3(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let start = 0;
  while (start + 10 <= b.length && tekstOp(b, start, 3) === 'ID3') {
    const grootte = ((b[start + 6] & 0x7f) << 21) | ((b[start + 7] & 0x7f) << 14)
      | ((b[start + 8] & 0x7f) << 7) | (b[start + 9] & 0x7f);
    start += 10 + grootte + ((b[start + 5] & 0x10) ? 10 : 0);
  }
  const grens = Math.min(b.length - 4, start + 512 * 1024);
  for (let p = start; p < grens; p++) {
    const kop = leesMp3Kop(b, p);
    if (!kop) continue;
    const volgende = p + kop.lengte;
    if (volgende + 4 <= b.length && !leesMp3Kop(b, volgende)) continue;

    const xing = p + 4 + (kop.mpeg1 ? (kop.mono ? 17 : 32) : (kop.mono ? 9 : 17));
    const tag = tekstOp(b, xing, 4);
    if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= b.length && (dv.getUint32(xing + 4) & 1)) {
      const frames = dv.getUint32(xing + 8);
      if (frames) return frames * kop.samples / kop.hz;
    }
    const vbri = p + 36;
    if (tekstOp(b, vbri, 4) === 'VBRI' && vbri + 18 <= b.length) {
      const frames = dv.getUint32(vbri + 14);
      if (frames) return frames * kop.samples / kop.hz;
    }
    let eind = b.length;
    if (eind >= 128 && tekstOp(b, eind - 128, 3) === 'TAG') eind -= 128;
    return (eind - p) * 8 / (kop.kbps * 1000);
  }
  return null;
}

function duurMp4(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const zoek = (van, tot, soort) => {
    let p = van;
    while (p + 8 <= tot) {
      let grootte = dv.getUint32(p);
      let kop = 8;
      if (grootte === 1 && p + 16 <= tot) { grootte = Number(dv.getBigUint64(p + 8)); kop = 16; }
      else if (grootte === 0) grootte = tot - p;
      if (grootte < kop) return null;
      if (tekstOp(b, p + 4, 4) === soort) return { van: p + kop, tot: Math.min(p + grootte, tot) };
      p += grootte;
    }
    return null;
  };
  const moov = zoek(0, b.length, 'moov');
  const mvhd = moov && zoek(moov.van, moov.tot, 'mvhd');
  if (!mvhd) return null;
  const v1 = b[mvhd.van] === 1;
  const schaal = dv.getUint32(mvhd.van + (v1 ? 20 : 12));
  const duur = v1 ? Number(dv.getBigUint64(mvhd.van + 24)) : dv.getUint32(mvhd.van + 16);
  return schaal ? duur / schaal : null;
}

function duurWav(b) {
  if (tekstOp(b, 0, 4) !== 'RIFF' || tekstOp(b, 8, 4) !== 'WAVE') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12;
  let bytesPerSeconde = 0;
  while (p + 8 <= b.length) {
    const id = tekstOp(b, p, 4);
    const grootte = dv.getUint32(p + 4, true);
    if (id === 'fmt ') bytesPerSeconde = dv.getUint32(p + 16, true);
    if (id === 'data') {
      const data = Math.min(grootte, b.length - p - 8);
      return bytesPerSeconde ? data / bytesPerSeconde : null;
    }
    p += 8 + grootte + (grootte & 1);
  }
  return null;
}

function duurUitBuffer(buffer, naam) {
  const b = new Uint8Array(buffer);
  const ext = extensie(naam);
  try {
    let d = null;
    if (ext === 'wav') d = duurWav(b);
    else if (ext === 'm4a') d = duurMp4(b);
    else d = duurMp3(b) ?? duurMp4(b);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/* ---------- Hulpjes ---------- */

function extensie(naam) {
  const m = /\.([a-z0-9]+)$/i.exec(naam);
  return m ? m[1].toLowerCase() : '';
}

function mimeVan(naam, type) {
  return MIME[extensie(naam)] || type || 'application/octet-stream';
}

/*
 * Een volgnummer vooraan bepaalt de volgorde, maar tonen we niet.
 * "01 - Persconferentie_ministerraad.mp3" -> "Persconferentie ministerraad"
 * "10 Jaaroverzicht" verliest zijn nummer alleen als een buur met "0" begint (01, 02 …),
 * zodat "100 dagen kabinet" of "2024 jaarbericht" heel blijft.
 */
const NUMMER_MET_TEKEN = /^\s*\d{1,3}\s*[-._)]\s*/;
const NUMMER_LOS = /^\s*\d{1,3}\s+/;
const NUMMER_MET_NUL = /^\s*0\d{0,2}[\s._)-]/;

function heeftNummering(namen) {
  return namen.some((n) => NUMMER_MET_NUL.test(n));
}

function schoneNaam(naam, isBestand, nummering = false) {
  let s = isBestand ? naam.replace(/\.[^.]+$/, '') : naam;
  if (NUMMER_MET_TEKEN.test(s)) s = s.replace(NUMMER_MET_TEKEN, '');
  else if (nummering || NUMMER_MET_NUL.test(s)) s = s.replace(NUMMER_LOS, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || naam;
}

function tijd(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  s = Math.floor(s);
  const u = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return u ? `${u}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/* Machineleesbare duur voor <time datetime>, bijvoorbeeld PT1M5S. */
function duurAttribuut(s) {
  s = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const u = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `PT${u ? `${u}H` : ''}${m ? `${m}M` : ''}${sec || (!u && !m) ? `${sec}S` : ''}`;
}

function minutenTekst(s) {
  const min = Math.round(s / 60);
  if (min < 1) return 'minder dan een minuut';
  if (min < 90) return min === 1 ? '1 minuut' : `${min} minuten`;
  const u = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${u} uur en ${rest} minuten` : `${u} uur`;
}

function grootteTekst(bytes) {
  const nl = (n) => n.toLocaleString('nl-NL', { maximumFractionDigits: 1 });
  if (bytes >= 1e9) return `${nl(bytes / 1e9)} GB`;
  return `${nl(Math.max(bytes, 0) / 1e6)} MB`;
}

function opnamesTekst(n) {
  return n === 1 ? '1 opname' : `${n} opnames`;
}

function maak(tag, klasse, tekst) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (tekst !== undefined && tekst !== null) e.textContent = tekst;
  return e;
}

function icoon(naam, klasse) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', klasse);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${naam}`);
  svg.append(use);
  return svg;
}

function zetIcoon(svg, naam) {
  svg.firstElementChild.setAttribute('href', `#i-${naam}`);
  svg.classList.toggle('afspelen', naam === 'afspelen');
}

function meldStatus(tekst) {
  el.status.textContent = '';
  requestAnimationFrame(() => { el.status.textContent = tekst; });
}

function isBeginschermApp() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone === true;
}

/* ---------- Bibliotheek laden en tonen ---------- */

async function laadBibliotheek() {
  const batch = await haal('meta', 'batch');
  const opnames = batch ? (await alles('opnames')).filter((o) => o.batch === batch) : [];
  const groepen = new Map();
  for (const o of opnames) {
    if (!groepen.has(o.ministerieSleutel)) groepen.set(o.ministerieSleutel, { naam: o.ministerie, opnames: [] });
    groepen.get(o.ministerieSleutel).opnames.push(o);
  }
  for (const g of groepen.values()) g.opnames.sort((a, b) => vergelijk(a.sleutel, b.sleutel));
  const sleutels = [...groepen.keys()].sort((a, b) => {
    if (a === OVERIG) return 1;
    if (b === OVERIG) return -1;
    return vergelijk(a, b);
  });
  bibliotheek = new Map(sleutels.map((k) => [k, groepen.get(k)]));
  if (gekozen && !bibliotheek.has(gekozen)) gekozen = null;
}

function toonMinisteries() {
  const items = [];
  for (const [sleutel, groep] of bibliotheek) {
    const knop = maak('button', 'ministerie');
    knop.type = 'button';
    knop.dataset.sleutel = sleutel;
    if (sleutel === gekozen) knop.setAttribute('aria-current', 'true');
    const aantal = maak('span', 'aantal', String(groep.opnames.length));
    aantal.append(maak('span', 'verborgen', groep.opnames.length === 1 ? ' opname' : ' opnames'));
    knop.append(maak('span', 'naam', groep.naam), aantal, icoon('pijl', 'ministerie-pijl'));
    knop.addEventListener('click', () => kiesMinisterie(sleutel));
    const li = maak('li');
    li.append(knop);
    items.push(li);
  }
  el.lijstMinisteries.replaceChildren(...items);
}

function kiesMinisterie(sleutel) {
  gekozen = sleutel;
  for (const knop of el.lijstMinisteries.querySelectorAll('.ministerie')) {
    if (knop.dataset.sleutel === sleutel) knop.setAttribute('aria-current', 'true');
    else knop.removeAttribute('aria-current');
  }
  toonOpnames();
  el.lijstOpnames.parentElement.scrollTop = 0;
  bereidAfspelenVoor(bibliotheek.get(sleutel));
}

function toonOpnames() {
  const leeg = bibliotheek.size === 0;
  const groep = gekozen ? bibliotheek.get(gekozen) : null;
  el.leeg.hidden = !leeg;
  el.hint.hidden = leeg || Boolean(groep);
  el.opnamesKop.hidden = !groep;

  if (!groep) {
    el.kopOpnames.textContent = 'Opnames';
    el.lijstOpnames.replaceChildren();
    return;
  }

  el.kopOpnames.textContent = groep.naam;
  const duren = groep.opnames.map((o) => o.duur);
  const n = groep.opnames.length;
  el.samenvatting.textContent = duren.every((d) => d > 0)
    ? `${opnamesTekst(n)}, samen ${minutenTekst(duren.reduce((a, b) => a + b, 0))}`
    : opnamesTekst(n);

  const items = groep.opnames.map((o) => {
    const knop = maak('button', 'opname');
    knop.type = 'button';
    knop.dataset.id = o.id;
    const rondje = maak('span', 'icoon');
    rondje.append(icoon('afspelen', 'opname-teken afspelen'));
    const duur = maak('time', 'duur', tijd(o.duur));
    duur.dateTime = duurAttribuut(o.duur);
    knop.append(rondje, maak('span', 'naam', o.titel), duur);
    knop.addEventListener('click', () => speelOpname(o));
    const li = maak('li');
    li.append(knop);
    return li;
  });
  el.lijstOpnames.replaceChildren(...items);
  markeerSpelend();
}

function markeerSpelend() {
  const speelt = huidige && !el.audio.paused;
  for (const knop of el.lijstOpnames.querySelectorAll('.opname')) {
    const isHuidig = Boolean(huidige) && knop.dataset.id === huidige.id;
    if (isHuidig) knop.setAttribute('aria-current', 'true');
    else knop.removeAttribute('aria-current');
    zetIcoon(knop.querySelector('svg'), isHuidig && speelt ? 'pauze' : 'afspelen');
  }
}

/* ---------- Afspelen ---------- */

/*
 * iPadOS speelt alleen af als play() direct in de tik wordt aangeroepen.
 * Daarom maken we de object-URL's al klaar zodra iemand een ministerie kiest.
 */
async function bereidAfspelenVoor(groep) {
  if (!groep) return;
  const nodig = new Set(groep.opnames.map((o) => o.id));
  for (const [id, url] of blobUrls) {
    if (!nodig.has(id) && id !== huidige?.id) {
      URL.revokeObjectURL(url);
      blobUrls.delete(id);
    }
  }
  const ontbrekend = [...nodig].filter((id) => !blobUrls.has(id));
  if (!ontbrekend.length) return;
  try {
    const tx = (await db()).transaction('audio');
    const st = tx.objectStore('audio');
    const records = await Promise.all(ontbrekend.map((id) => verzoek(st.get(id))));
    for (const r of records) {
      if (r && !blobUrls.has(r.id)) blobUrls.set(r.id, URL.createObjectURL(r.blob));
    }
  } catch (e) {
    console.error('Voorbereiden mislukt', e);
  }
}

function speelOpname(opname) {
  if (huidige && huidige.id === opname.id) {
    wissel();
    return;
  }
  const url = blobUrls.get(opname.id);
  if (url) {
    laadInSpeler(opname, url);
    speel();
    return;
  }
  // Terugval: ontgrendel de speler binnen de tik en laad daarna.
  el.audio.removeAttribute('src');
  el.audio.load();
  el.audio.play().catch(() => {});
  haal('audio', opname.id).then((r) => {
    if (!r) {
      meldStatus('Deze opname is niet gevonden. Lees de map opnieuw in.');
      return;
    }
    const nieuw = URL.createObjectURL(r.blob);
    blobUrls.set(opname.id, nieuw);
    laadInSpeler(opname, nieuw);
    speel();
  }).catch((e) => console.error(e));
}

function laadInSpeler(opname, url) {
  huidige = opname;
  el.audio.src = url;
  zetPositie(0, opname.duur || 0);
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: opname.titel,
      artist: opname.ministerie,
      album: 'Studio 1400',
    });
  }
  toonSpeler();
}

async function speel() {
  try {
    await el.audio.play();
  } catch (e) {
    if (e.name !== 'AbortError') meldStatus('Afspelen lukt niet. Tik nog een keer op de opname.');
  }
}

function wissel() {
  if (!huidige) return;
  if (el.audio.paused) speel();
  else el.audio.pause();
}

function duurNu() {
  const d = el.audio.duration;
  if (Number.isFinite(d) && d > 0) return d;
  return huidige?.duur || 0;
}

function toonSpeler() {
  const speelt = huidige && !el.audio.paused;
  el.spelerKnop.disabled = !huidige;
  el.spelerKnop.setAttribute('aria-label', speelt ? 'Pauzeren' : 'Afspelen');
  zetIcoon(el.spelerKnop.querySelector('svg'), speelt ? 'pauze' : 'afspelen');
  el.spelerTitel.textContent = huidige ? huidige.titel : 'Kies een opname';
  el.spelerMinisterie.textContent = huidige ? huidige.ministerie : '';
  el.voortgang.setAttribute('aria-disabled', String(!huidige));
  el.voortgang.tabIndex = huidige ? 0 : -1;
  markeerSpelend();
}

function zetPositie(seconden, totaal) {
  const deel = totaal > 0 ? Math.min(Math.max(seconden / totaal, 0), 1) : 0;
  el.voortgang.style.setProperty('--deel', String(deel));
  el.voortgang.setAttribute('aria-valuemax', String(Math.round(totaal)));
  el.voortgang.setAttribute('aria-valuenow', String(Math.round(seconden)));
  el.voortgang.setAttribute('aria-valuetext', `${tijd(seconden) || '0:00'} van ${tijd(totaal) || '0:00'}`);
  el.tijdNu.textContent = tijd(seconden) || '0:00';
  el.tijdNu.dateTime = duurAttribuut(seconden);
  el.tijdTotaal.textContent = tijd(totaal) || '0:00';
  el.tijdTotaal.dateTime = duurAttribuut(totaal);
}

function positieVanX(x) {
  const r = el.voortgang.getBoundingClientRect();
  const marge = 16;
  const deel = Math.min(Math.max((x - r.left - marge) / (r.width - 2 * marge), 0), 1);
  return deel * duurNu();
}

function bindSchuif() {
  const s = el.voortgang;
  let doel = 0;
  s.addEventListener('pointerdown', (e) => {
    if (!huidige || !duurNu()) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    sleept = true;
    doel = positieVanX(e.clientX);
    zetPositie(doel, duurNu());
  });
  s.addEventListener('pointermove', (e) => {
    if (!sleept) return;
    doel = positieVanX(e.clientX);
    zetPositie(doel, duurNu());
  });
  const los = () => {
    if (!sleept) return;
    sleept = false;
    el.audio.currentTime = doel;
  };
  s.addEventListener('pointerup', los);
  s.addEventListener('pointercancel', los);
  s.addEventListener('keydown', (e) => {
    if (!huidige) return;
    const stappen = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10 };
    let nieuw = null;
    if (e.key in stappen) nieuw = el.audio.currentTime + stappen[e.key];
    if (e.key === 'Home') nieuw = 0;
    if (e.key === 'End') nieuw = duurNu();
    if (nieuw === null) return;
    e.preventDefault();
    el.audio.currentTime = Math.min(Math.max(nieuw, 0), duurNu());
  });
}

async function houdSchermAan(aan) {
  try {
    if (aan && !wekslot && 'wakeLock' in navigator) {
      wekslot = await navigator.wakeLock.request('screen');
      wekslot.addEventListener('release', () => { wekslot = null; });
    } else if (!aan && wekslot) {
      await wekslot.release();
      wekslot = null;
    }
  } catch {
    wekslot = null;
  }
}

function bindAudio() {
  const a = el.audio;
  a.addEventListener('play', () => { toonSpeler(); houdSchermAan(true); });
  a.addEventListener('pause', () => { toonSpeler(); houdSchermAan(false); });
  a.addEventListener('ended', () => {
    a.currentTime = 0;
    zetPositie(0, duurNu());
    toonSpeler();
    meldStatus('De opname is afgelopen.');
  });
  a.addEventListener('timeupdate', () => {
    if (!sleept) zetPositie(a.currentTime, duurNu());
  });
  a.addEventListener('durationchange', () => {
    const d = a.duration;
    if (!huidige || !Number.isFinite(d) || d <= 0) return;
    if (!huidige.duur) {
      huidige.duur = d;
      bewaar(['opnames'], [['opnames', huidige]]).catch(() => {});
      if (gekozen) toonOpnames();
    }
    zetPositie(a.currentTime, d);
  });
  a.addEventListener('error', () => {
    if (huidige && a.getAttribute('src')) meldStatus('Deze opname kan niet worden afgespeeld.');
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => speel());
      navigator.mediaSession.setActionHandler('pause', () => a.pause());
    } catch { /* niet ondersteund */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !a.paused) houdSchermAan(true);
  });
}

/* ---------- Inlezen ---------- */

function deelIn(bestanden) {
  const items = bestanden.map((f) => ({
    f,
    pad: (f.webkitRelativePath || f.name).split('/').filter(Boolean),
  })).filter(({ pad }) => !pad.some((d) => d.startsWith('.')));

  const audio = [];
  const huisstijl = [];
  let overgeslagen = 0;

  const isAudio = (f) => AUDIO_EXT.test(f.name);
  const alleenLos = items.filter((x) => isAudio(x.f)).every((x) => x.pad.length <= 2);

  for (const x of items) {
    const mappen = x.pad.slice(0, -1);
    if (mappen.some((m) => HUISSTIJL_MAP.test(m))) {
      if (LETTER_EXT.test(x.f.name)) huisstijl.push({ ...x, soort: 'letter' });
      else if (LOGO_NAAM.test(x.f.name)) huisstijl.push({ ...x, soort: 'logo' });
      continue;
    }
    if (!isAudio(x.f)) {
      overgeslagen += 1;
      continue;
    }
    let map;
    if (x.pad.length >= 3) map = x.pad[1];
    else if (x.pad.length === 2 && alleenLos) map = x.pad[0];
    else map = OVERIG;
    if (map.startsWith('_')) continue;
    audio.push({ f: x.f, ministerieSleutel: map, sleutel: x.f.name });
  }

  // Namen opschonen; nummering per groep van buren bepalen.
  const mapNummering = heeftNummering([...new Set(audio.map((a) => a.ministerieSleutel))]);
  const perMap = new Map();
  for (const a of audio) {
    if (!perMap.has(a.ministerieSleutel)) perMap.set(a.ministerieSleutel, []);
    perMap.get(a.ministerieSleutel).push(a.sleutel);
  }
  const bestandNummering = new Map([...perMap].map(([map, namen]) => [map, heeftNummering(namen)]));
  for (const a of audio) {
    a.ministerie = a.ministerieSleutel === OVERIG ? OVERIG : schoneNaam(a.ministerieSleutel, false, mapNummering);
    a.titel = schoneNaam(a.sleutel, true, bestandNummering.get(a.ministerieSleutel));
  }

  const zonderMappen = items.length > 0 && items.every((x) => x.pad.length === 1);
  return { audio, huisstijl, overgeslagen, zonderMappen };
}

function letterKenmerken(naam) {
  const n = naam.toLowerCase();
  let gewicht = 400;
  if (/(bold|vet|black|heavy)/.test(n)) gewicht = 700;
  else if (/medium/.test(n)) gewicht = 500;
  else if (/light|licht/.test(n)) gewicht = 300;
  return {
    familie: /serif/.test(n) && !/sans/.test(n) ? 'RO Serif' : 'RO Sans',
    gewicht,
    stijl: /(italic|cursief|oblique)/.test(n) ? 'italic' : 'normal',
  };
}

async function leesBestand(f) {
  // Direct lezen: de toegang tot de gekozen map kan na het kiezen vervallen.
  const buffer = await f.arrayBuffer();
  return { buffer, blob: new Blob([buffer], { type: mimeVan(f.name, f.type) }) };
}

function isVolFout(e) {
  return e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
}

function zetBezig(aan) {
  bezig = aan;
  el.knopMap.classList.toggle('is-uit', aan);
  el.invoerMap.disabled = aan;
  for (const k of [el.knopUpdate, el.knopWissen, el.knopSluiten]) k.disabled = aan;
  el.inlezen.hidden = !aan;
}

function toonBeheerMelding(tekst, soort) {
  el.beheerMelding.textContent = tekst;
  el.beheerMelding.className = `melding${soort ? ` melding-${soort}` : ''}`;
  el.beheerMelding.hidden = !tekst;
}

async function leesMapIn(lijst) {
  const { audio, huisstijl, overgeslagen, zonderMappen } = deelIn(Array.from(lijst));
  if (!audio.length) {
    toonBeheerMelding('In deze map staan geen geluidsbestanden (mp3, m4a, aac of wav).', 'fout');
    return;
  }

  const batch = Date.now();
  const fouten = [];
  toonBeheerMelding('');
  zetBezig(true);
  el.inlezenBalk.max = audio.length;

  try {
    for (let i = 0; i < audio.length; i++) {
      const item = audio[i];
      el.inlezenBalk.value = i;
      el.inlezenTekst.textContent = `Bezig: ${i + 1} van ${audio.length}. ${item.titel}`;
      try {
        const { buffer, blob } = await leesBestand(item.f);
        const id = `${batch}-${i}`;
        await bewaar(['opnames', 'audio'], [
          ['audio', { id, blob }],
          ['opnames', {
            id,
            batch,
            ministerieSleutel: item.ministerieSleutel,
            ministerie: item.ministerie,
            sleutel: item.sleutel,
            titel: item.titel,
            duur: duurUitBuffer(buffer, item.f.name),
            grootte: blob.size,
            bestand: item.f.name,
          }],
        ]);
      } catch (e) {
        if (isVolFout(e)) throw e;
        fouten.push(`${item.f.name}: ${e.message || e.name}`);
      }
    }
    el.inlezenBalk.value = audio.length;

    let letters = 0;
    let logo = false;
    if (huisstijl.length) {
      el.inlezenTekst.textContent = 'Bezig met de huisstijl.';
      for (let i = 0; i < huisstijl.length; i++) {
        const h = huisstijl[i];
        const { blob } = await leesBestand(h.f);
        const record = { id: `${batch}-h${i}`, batch, soort: h.soort, bestand: h.f.name, blob };
        if (h.soort === 'letter') {
          Object.assign(record, letterKenmerken(h.f.name));
          letters += 1;
        } else {
          logo = true;
        }
        await bewaar(['huisstijl'], [['huisstijl', record]]);
      }
      await zetMeta('huisstijlBatch', batch);
    }

    const gelukt = audio.length - fouten.length;
    if (!gelukt) throw new Error('Geen enkele opname kon worden ingelezen.');
    await zetMeta('batch', batch);
    await ruimOp();

    const regels = [`Klaar. ${opnamesTekst(gelukt)} ingelezen.`];
    if (huisstijl.length) {
      regels.push(`Huisstijl: ${letters} lettertype${letters === 1 ? '' : 's'}${logo ? ' en een logo' : ''}.`);
    }
    if (overgeslagen) regels.push(`${overgeslagen} bestand${overgeslagen === 1 ? '' : 'en'} overgeslagen, want dat is geen geluid.`);
    if (zonderMappen) {
      regels.push(`Deze iPad gaf geen mappen door. Alles staat onder '${OVERIG}'. Werk iPadOS bij naar 18.4 of nieuwer.`);
    }
    if (fouten.length) {
      regels.push(`Niet gelukt (${fouten.length}):`, ...fouten.slice(0, 10).map((f) => `- ${f}`));
    }
    toonBeheerMelding(regels.join('\n'), fouten.length || zonderMappen ? 'let-op' : '');
  } catch (e) {
    console.error(e);
    await verwijderBatch(batch).catch(() => {});
    toonBeheerMelding(isVolFout(e)
      ? 'De iPad heeft niet genoeg ruimte. Er is niets veranderd. Maak ruimte vrij of kies minder opnames.'
      : `Inlezen is niet gelukt. Er is niets veranderd.\n${e.message || e.name}`, 'fout');
  } finally {
    zetBezig(false);
  }

  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* geen probleem */ }

  stopSpeler();
  gekozen = null;
  await laadHuisstijl();
  await laadBibliotheek();
  toonMinisteries();
  toonOpnames();
  toonOpslag();
}

async function verwijderBatch(batch) {
  const opnames = (await alles('opnames')).filter((o) => o.batch === batch).map((o) => o.id);
  await verwijderIds(['opnames', 'audio'], opnames);
  const huis = (await alles('huisstijl')).filter((h) => h.batch === batch).map((h) => h.id);
  await verwijderIds(['huisstijl'], huis);
}

/* ---------- Huisstijl uit de map _huisstijl ---------- */

async function laadHuisstijl() {
  const batch = await haal('meta', 'huisstijlBatch');
  const items = batch ? (await alles('huisstijl')).filter((h) => h.batch === batch) : [];

  for (const f of geladenLetters) document.fonts.delete(f);
  geladenLetters = [];
  for (const h of items.filter((i) => i.soort === 'letter')) {
    try {
      const ff = new FontFace(h.familie, await h.blob.arrayBuffer(), { weight: String(h.gewicht), style: h.stijl });
      await ff.load();
      document.fonts.add(ff);
      geladenLetters.push(ff);
    } catch (e) {
      console.warn('Lettertype niet geladen:', h.bestand, e);
    }
  }

  if (logoUrl) URL.revokeObjectURL(logoUrl);
  logoUrl = null;
  const logo = items.find((i) => i.soort === 'logo');
  el.logoStrook.replaceChildren();
  if (logo) {
    logoUrl = URL.createObjectURL(logo.blob);
    const img = maak('img');
    img.src = logoUrl;
    img.alt = 'Rijksoverheid';
    el.logoStrook.append(img);
  }
  el.logoStrook.hidden = !logo;
}

/* ---------- Beheer ---------- */

function openBeheer() {
  if (el.beheer.open) return;
  el.beheerWaarschuwing.hidden = isBeginschermApp();
  if (!bezig) toonBeheerMelding('');
  toonOpslag();
  el.beheer.showModal();
}

function sluitBeheer() {
  if (!bezig) el.beheer.close();
}

async function toonOpslag() {
  const regels = [];
  const n = [...bibliotheek.values()].reduce((som, g) => som + g.opnames.length, 0);
  regels.push(n
    ? `${opnamesTekst(n)} bij ${bibliotheek.size} ministerie${bibliotheek.size === 1 ? '' : 's'}.`
    : 'Er staan geen opnames op deze iPad.');
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      regels.push(`In gebruik: ${grootteTekst(usage)}. Maximaal: ${grootteTekst(quota)}.`);
    }
    if (navigator.storage?.persisted) {
      regels.push(await navigator.storage.persisted()
        ? 'De opslag is blijvend.'
        : 'De opslag is niet blijvend. iPadOS kan de opnames wissen als de iPad vol raakt.');
    }
  } catch { /* niet ondersteund */ }
  el.opslagTekst.textContent = regels.join('\n');
}

async function zoekUpdate() {
  if (!('serviceWorker' in navigator)) {
    toonBeheerMelding('Updates werken alleen in de app op het beginscherm.', 'let-op');
    return;
  }
  if (!navigator.onLine) {
    toonBeheerMelding('Er is geen internet. Probeer het later opnieuw.', 'let-op');
    return;
  }
  el.knopUpdate.disabled = true;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error('Geen service worker');
    handmatigeUpdate = true;
    await reg.update();
    if (reg.installing || reg.waiting) {
      toonBeheerMelding('Er is een nieuwe versie. De app start zo opnieuw.');
      setTimeout(() => location.reload(), 15000);
    } else {
      handmatigeUpdate = false;
      toonBeheerMelding(`Je hebt de nieuwste versie (${VERSIE}).`);
    }
  } catch (e) {
    handmatigeUpdate = false;
    toonBeheerMelding('Zoeken naar een update is niet gelukt. Probeer het later opnieuw.', 'let-op');
  } finally {
    el.knopUpdate.disabled = false;
  }
}

async function wisOpnames() {
  if (!window.confirm('Alle opnames en de huisstijl wissen van deze iPad?')) return;
  stopSpeler();
  await wisAlles();
  gekozen = null;
  await laadHuisstijl();
  await laadBibliotheek();
  toonMinisteries();
  toonOpnames();
  toonOpslag();
  toonBeheerMelding('Alles is gewist.');
}

function bindBeheer() {
  // Verborgen ingang: 3 seconden op de blauwe balk drukken.
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  el.balk.addEventListener('pointerdown', () => {
    stop();
    timer = setTimeout(() => { stop(); openBeheer(); }, LANG_DRUKKEN_MS);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.balk.addEventListener(t, stop);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  el.knopLeegBeheer.addEventListener('click', openBeheer);
  el.knopSluiten.addEventListener('click', sluitBeheer);
  el.beheer.addEventListener('cancel', (e) => { if (bezig) e.preventDefault(); });
  el.knopUpdate.addEventListener('click', zoekUpdate);
  el.knopWissen.addEventListener('click', () => wisOpnames().catch((e) => {
    console.error(e);
    toonBeheerMelding('Wissen is niet gelukt.', 'fout');
  }));
  el.invoerMap.addEventListener('change', () => {
    const bestanden = el.invoerMap.files;
    if (bestanden && bestanden.length) {
      leesMapIn(bestanden).finally(() => { el.invoerMap.value = ''; });
    }
  });
}

/* ---------- Rust: terug naar het begin als niemand de iPad gebruikt ---------- */

function stopSpeler() {
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.load();
  huidige = null;
  for (const url of blobUrls.values()) URL.revokeObjectURL(url);
  blobUrls.clear();
  zetPositie(0, 0);
  toonSpeler();
}

function naarBegin() {
  stopSpeler();
  gekozen = null;
  if (el.beheer.open && !bezig) el.beheer.close();
  toonMinisteries();
  toonOpnames();
  el.lijstMinisteries.parentElement.scrollTop = 0;
  el.lijstOpnames.parentElement.scrollTop = 0;
  inRust = true;
}

function bindRust() {
  const actie = () => { laatsteActie = Date.now(); inRust = false; };
  for (const t of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(t, actie, { capture: true, passive: true });
  }
  setInterval(() => {
    if (bezig || !el.audio.paused) return;
    if (Date.now() - laatsteActie < RUST_NA_MS) return;
    if (updateKlaar) {
      location.reload();
      return;
    }
    if (!inRust) naarBegin();
  }, 10000);
}

/* ---------- Service worker ---------- */

function registreerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadBeheerder = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadBeheerder) return;               // eerste installatie
    if (handmatigeUpdate) location.reload();
    else updateKlaar = true;                 // herladen zodra niemand luistert
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    setInterval(() => { if (navigator.onLine) reg.update().catch(() => {}); }, UPDATE_INTERVAL_MS);
  }).catch((e) => console.warn('Service worker niet geregistreerd', e));
}

/* ---------- Start ---------- */

async function start() {
  el.versie.textContent = VERSIE;
  // Mappen kiezen (iPadOS 18.4+). Via script, want webkitdirectory is geen HTML-standaardattribuut.
  el.invoerMap.webkitdirectory = true;
  bindAudio();
  bindSchuif();
  bindBeheer();
  bindRust();
  el.spelerKnop.addEventListener('click', wissel);
  registreerServiceWorker();

  try {
    await ruimOp();
    await laadHuisstijl();
    await laadBibliotheek();
  } catch (e) {
    console.error('Laden mislukt', e);
    meldStatus('De opnames konden niet worden geladen.');
  }
  toonMinisteries();
  toonOpnames();
  toonSpeler();
}

window.Studio1400 = { VERSIE, duurUitBuffer, schoneNaam };
start();
