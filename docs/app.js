'use strict';

/*
 * Studio 1400: opnames per ministerie kiezen en afspelen op een iPad.
 * De app-bestanden komen offline uit de service worker. De beheerder leest de opnames in
 * vanuit een map; ze staan daarna in IndexedDB en gaan nooit online.
 * Verhoog VERSIE hier én in sw.js bij elke wijziging.
 */

const VERSIE = '1.1.3';
const RUST_NA_MS = 2 * 60 * 1000;
const LANG_DRUKKEN_MS = 3000;
const UPDATE_ELKE_MS = 6 * 60 * 60 * 1000;
const OVERIG = 'Overige opnames';
const WINKELS = ['meta', 'opnames', 'audio', 'huisstijl'];
const AUDIO = /\.(mp3|m4a|aac|wav)$/i;
const LETTER = /^(?!.*icon).*\.(woff2?|ttf|otf)$/i; // iconenfonts niet als tekstletter laden
const LOGO = /logo.*\.(svg|png|jpe?g|webp)$/i;
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
const vergelijk = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' }).compare;

// Elk element met een id, bijvoorbeeld #speler-knop als el.spelerKnop.
const el = {};
for (const e of document.querySelectorAll('[id]')) el[e.id.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = e;

let bibliotheek = new Map(); // ministerie-sleutel -> { naam, opnames }
let gekozen = null;
let huidige = null;
const blobUrls = new Map();
let sleept = false, bezig = false, inRust = true, updateKlaar = false, handmatigeUpdate = false;
let laatsteActie = Date.now();
let wekslot = null, logoUrl = null, geladenLetters = [];

/* ---------- IndexedDB ---------- */

let dbBelofte;
const db = () => (dbBelofte ??= new Promise((ok, fout) => {
  const req = indexedDB.open('studio1400', 1);
  req.onupgradeneeded = () => WINKELS.forEach((w) => req.result.createObjectStore(w, w === 'meta' ? undefined : { keyPath: 'id' }));
  req.onsuccess = () => ok(req.result);
  req.onerror = () => fout(req.error);
}));

const verzoek = (r) => new Promise((ok, fout) => {
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fout(r.error);
});

// Eén transactie. Klaar pas als alles echt is opgeslagen.
async function tx(winkels, modus, werk) {
  const t = (await db()).transaction(winkels, modus);
  const uitkomst = werk((w) => t.objectStore(w));
  await new Promise((ok, fout) => {
    t.oncomplete = ok;
    t.onerror = t.onabort = (e) => fout(e.target.error || t.error || new Error('Opslaan afgebroken'));
  });
  return uitkomst;
}

const haal = (w, k) => tx(w, 'readonly', (st) => verzoek(st(w).get(k)));
const alles = (w) => tx(w, 'readonly', (st) => verzoek(st(w).getAll()));
const zetMeta = (k, v) => tx('meta', 'readwrite', (st) => { st('meta').put(v, k); });
const bewaar = (records) => tx([...new Set(records.map(([w]) => w))], 'readwrite', (st) => records.forEach(([w, r]) => st(w).put(r)));

async function verwijder(winkels, test) {
  const ids = (await alles(winkels[0])).filter(test).map((r) => r.id);
  if (ids.length) await tx(winkels, 'readwrite', (st) => winkels.forEach((w) => ids.forEach((id) => st(w).delete(id))));
}

// Resten van oude of afgebroken inleesrondes weghalen.
async function ruimOp() {
  const batch = await haal('meta', 'batch');
  const huis = await haal('meta', 'huisstijlBatch');
  await verwijder(['opnames', 'audio'], (o) => o.batch !== batch);
  await verwijder(['huisstijl'], (h) => h.batch !== huis);
}

async function verwijderBatch(batch) {
  await verwijder(['opnames', 'audio'], (o) => o.batch === batch);
  await verwijder(['huisstijl'], (h) => h.batch === batch);
}

/* ---------- Duur uit het bestand: iPadOS laadt geen audiometadata zonder tik ---------- */

const KBPS = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
const HZ = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const ascii = (b, p, n) => (p < 0 ? '' : String.fromCharCode(...b.subarray(p, p + n)));

function mp3Kop(b, p) {
  if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const versie = (b[p + 1] >> 3) & 3, laag = (b[p + 1] >> 1) & 3, br = b[p + 2] >> 4, hz = (b[p + 2] >> 2) & 3;
  if (versie === 1 || laag !== 1 || br === 0 || br === 15 || hz === 3) return null;
  const mpeg1 = versie === 3, samples = mpeg1 ? 1152 : 576, kbps = KBPS[mpeg1 ? 0 : 1][br], freq = HZ[versie][hz];
  return { mpeg1, kbps, freq, samples, mono: (b[p + 3] >> 6) === 3, lengte: Math.floor((samples / 8) * kbps * 1000 / freq) + ((b[p + 2] >> 1) & 1) };
}

function duurMp3(b, dv) {
  let p = 0;
  while (ascii(b, p, 3) === 'ID3') {
    p += 10 + (((b[p + 6] & 0x7f) << 21) | ((b[p + 7] & 0x7f) << 14) | ((b[p + 8] & 0x7f) << 7) | (b[p + 9] & 0x7f)) + (b[p + 5] & 0x10 ? 10 : 0);
  }
  for (const grens = Math.min(b.length - 4, p + 512 * 1024); p < grens; p++) {
    const k = mp3Kop(b, p);
    if (!k || (p + k.lengte + 4 <= b.length && !mp3Kop(b, p + k.lengte))) continue;
    const x = p + 4 + (k.mpeg1 ? (k.mono ? 17 : 32) : (k.mono ? 9 : 17));
    if (/^(Xing|Info)$/.test(ascii(b, x, 4)) && dv.getUint32(x + 4) & 1) return (dv.getUint32(x + 8) * k.samples) / k.freq || null;
    if (ascii(b, p + 36, 4) === 'VBRI') return (dv.getUint32(p + 50) * k.samples) / k.freq || null;
    const eind = b.length - (ascii(b, b.length - 128, 3) === 'TAG' ? 128 : 0);
    return ((eind - p) * 8) / (k.kbps * 1000);
  }
  return null;
}

function duurMp4(b, dv) {
  const zoek = (van, tot, soort) => {
    for (let p = van; p + 8 <= tot;) {
      let grootte = dv.getUint32(p), kop = 8;
      if (grootte === 1) [grootte, kop] = [Number(dv.getBigUint64(p + 8)), 16];
      else if (grootte === 0) grootte = tot - p;
      if (grootte < kop) return null;
      if (ascii(b, p + 4, 4) === soort) return [p + kop, Math.min(p + grootte, tot)];
      p += grootte;
    }
    return null;
  };
  const moov = zoek(0, b.length, 'moov');
  const m = moov && zoek(...moov, 'mvhd');
  if (!m) return null;
  const v1 = b[m[0]] === 1, schaal = dv.getUint32(m[0] + (v1 ? 20 : 12));
  return schaal ? (v1 ? Number(dv.getBigUint64(m[0] + 24)) : dv.getUint32(m[0] + 16)) / schaal : null;
}

function duurWav(b, dv) {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  let perSeconde = 0;
  for (let p = 12; p + 8 <= b.length;) {
    const id = ascii(b, p, 4), grootte = dv.getUint32(p + 4, true);
    if (id === 'fmt ') perSeconde = dv.getUint32(p + 16, true);
    if (id === 'data') return perSeconde ? Math.min(grootte, b.length - p - 8) / perSeconde : null;
    p += 8 + grootte + (grootte & 1);
  }
  return null;
}

function duurUitBuffer(buffer, naam) {
  const b = new Uint8Array(buffer), dv = new DataView(buffer), ext = extensie(naam);
  try {
    const d = ext === 'wav' ? duurWav(b, dv) : ext === 'm4a' ? duurMp4(b, dv) : (duurMp3(b, dv) ?? duurMp4(b, dv));
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/* ---------- Hulpjes ---------- */

const extensie = (naam) => (/\.([a-z0-9]+)$/i.exec(naam)?.[1] || '').toLowerCase();
const meervoud = (n, een, veel) => `${n} ${n === 1 ? een : veel}`;

/*
 * Een volgnummer vooraan bepaalt de volgorde, maar tonen we niet: "01 - Pers_conferentie.mp3" wordt "Pers conferentie".
 * "10 Titel" verliest zijn nummer alleen als een buur met 0 begint, zodat "100 dagen" heel blijft.
 */
const NR_TEKEN = /^\s*\d{1,3}\s*[-._)]\s*/, NR_LOS = /^\s*\d{1,3}\s+/, NR_NUL = /^\s*0\d{0,2}[\s._)-]/;
const heeftNummering = (namen) => namen.some((n) => NR_NUL.test(n));

function schoneNaam(naam, isBestand, nummering = false) {
  let s = isBestand ? naam.replace(/\.[^.]+$/, '') : naam;
  if (NR_TEKEN.test(s)) s = s.replace(NR_TEKEN, '');
  else if (nummering || NR_NUL.test(s)) s = s.replace(NR_LOS, '');
  return s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || naam;
}

function delen(s) {
  s = Math.floor(Number.isFinite(s) && s > 0 ? s : 0);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
}

function tijd(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  const [u, m, sec] = delen(s), ss = String(sec).padStart(2, '0');
  return u ? `${u}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Machineleesbare duur voor <time datetime>, bijvoorbeeld PT1M5S.
function duurAttribuut(s) {
  const [u, m, sec] = delen(s);
  return `PT${u ? `${u}H` : ''}${m ? `${m}M` : ''}${sec || (!u && !m) ? `${sec}S` : ''}`;
}

function minutenTekst(s) {
  const min = Math.round(s / 60), u = Math.floor(min / 60), rest = min % 60;
  if (min < 1) return 'minder dan een minuut';
  if (min < 90) return meervoud(min, 'minuut', 'minuten');
  return rest ? `${u} uur en ${rest} minuten` : `${u} uur`;
}

const grootteTekst = (b) => (b >= 1e9 ? `${(b / 1e9).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} GB`
  : `${(Math.max(b, 0) / 1e6).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} MB`);

function maak(tag, klasse, inhoud) {
  const e = document.createElement(tag);
  if (klasse) e.className = klasse;
  if (inhoud !== undefined) e.textContent = inhoud;
  return e;
}

function nieuweKnop(klasse) {
  const k = maak('button', klasse);
  k.type = 'button';
  return k;
}

function inLijst(inhoud) {
  const li = maak('li');
  li.append(inhoud);
  return li;
}

function icoon(naam, klasse) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', klasse);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.append(document.createElementNS(ns, 'use'));
  zetIcoon(svg, naam);
  return svg;
}

function zetIcoon(svg, naam) {
  svg.firstElementChild.setAttribute('href', `#i-${naam}`);
  svg.classList.toggle('afspelen', naam === 'afspelen');
}

const zetHuidig = (e, aan) => (aan ? e.setAttribute('aria-current', 'true') : e.removeAttribute('aria-current'));

function meldStatus(tekst) {
  el.status.textContent = '';
  requestAnimationFrame(() => { el.status.textContent = tekst; });
}

const isBeginschermApp = () => ['standalone', 'fullscreen'].some((m) => matchMedia(`(display-mode: ${m})`).matches) || navigator.standalone === true;

/* ---------- Bibliotheek tonen ---------- */

async function laadBibliotheek() {
  const batch = await haal('meta', 'batch');
  const groepen = new Map();
  for (const o of batch ? (await alles('opnames')).filter((r) => r.batch === batch) : []) {
    if (!groepen.has(o.ministerieSleutel)) groepen.set(o.ministerieSleutel, { naam: o.ministerie, opnames: [] });
    groepen.get(o.ministerieSleutel).opnames.push(o);
  }
  groepen.forEach((g) => g.opnames.sort((a, b) => vergelijk(a.sleutel, b.sleutel)));
  bibliotheek = new Map([...groepen].sort(([a], [b]) => (a === OVERIG) - (b === OVERIG) || vergelijk(a, b)));
  if (!bibliotheek.has(gekozen)) gekozen = null;
}

function toonMinisteries() {
  el.lijstMinisteries.replaceChildren(...[...bibliotheek].map(([sleutel, g]) => {
    const k = nieuweKnop('ministerie'), aantal = maak('span', 'aantal', String(g.opnames.length));
    k.dataset.sleutel = sleutel;
    zetHuidig(k, sleutel === gekozen);
    aantal.append(maak('span', 'verborgen', g.opnames.length === 1 ? ' opname' : ' opnames'));
    k.append(maak('span', 'naam', g.naam), aantal, icoon('pijl', 'ministerie-pijl'));
    k.addEventListener('click', () => kiesMinisterie(sleutel));
    return inLijst(k);
  }));
}

function kiesMinisterie(sleutel) {
  gekozen = sleutel;
  for (const k of el.lijstMinisteries.querySelectorAll('.ministerie')) zetHuidig(k, k.dataset.sleutel === sleutel);
  toonOpnames();
  el.lijstOpnames.parentElement.scrollTop = 0;
  bereidAfspelenVoor(bibliotheek.get(sleutel));
}

function toonOpnames() {
  const g = bibliotheek.get(gekozen);
  el.leeg.hidden = bibliotheek.size > 0;
  el.lijstMinisteries.parentElement.hidden = !el.leeg.hidden;
  el.hint.hidden = !el.leeg.hidden || Boolean(g);
  el.opnamesKop.hidden = !g;
  el.kopOpnames.textContent = g ? g.naam : 'Opnames';
  if (!g) return el.lijstOpnames.replaceChildren();

  const n = meervoud(g.opnames.length, 'opname', 'opnames');
  el.samenvatting.textContent = g.opnames.every((o) => o.duur > 0)
    ? `${n}, samen ${minutenTekst(g.opnames.reduce((som, o) => som + o.duur, 0))}` : n;
  el.lijstOpnames.replaceChildren(...g.opnames.map((o) => {
    const k = nieuweKnop('opname'), rondje = maak('span', 'icoon'), golf = maak('span', 'golf'), duur = maak('time', 'duur', tijd(o.duur));
    k.dataset.id = o.id;
    rondje.append(icoon('afspelen', 'opname-teken'));
    golf.setAttribute('aria-hidden', 'true');
    golf.append(maak('span'), maak('span'), maak('span'));
    duur.dateTime = duurAttribuut(o.duur);
    k.append(rondje, maak('span', 'naam', o.titel), golf, duur);
    k.addEventListener('click', () => speelOpname(o));
    return inLijst(k);
  }));
  markeerSpelend();
}

function markeerSpelend() {
  const speelt = Boolean(huidige) && !el.audio.paused;
  for (const k of el.lijstOpnames.querySelectorAll('.opname')) {
    const isHuidig = k.dataset.id === huidige?.id;
    zetHuidig(k, isHuidig);
    k.classList.toggle('is-spelend', isHuidig && speelt);
    zetIcoon(k.querySelector('svg'), isHuidig && speelt ? 'pauze' : 'afspelen');
  }
}

/* ---------- Afspelen ---------- */

// play() moet direct in de tik. Daarom staan de object-URL's al klaar als iemand een ministerie kiest.
async function bereidAfspelenVoor(g) {
  if (!g) return;
  const nodig = new Set(g.opnames.map((o) => o.id));
  for (const [id, url] of blobUrls) {
    if (!nodig.has(id) && id !== huidige?.id) {
      URL.revokeObjectURL(url);
      blobUrls.delete(id);
    }
  }
  const ontbrekend = [...nodig].filter((id) => !blobUrls.has(id));
  if (!ontbrekend.length) return;
  try {
    const records = await tx('audio', 'readonly', (st) => Promise.all(ontbrekend.map((id) => verzoek(st('audio').get(id)))));
    for (const r of records) if (r && !blobUrls.has(r.id)) blobUrls.set(r.id, URL.createObjectURL(r.blob));
  } catch (e) {
    console.error('Voorbereiden mislukt', e);
  }
}

function speelOpname(o) {
  if (huidige?.id === o.id) return wissel();
  if (blobUrls.has(o.id)) {
    laadInSpeler(o, blobUrls.get(o.id));
    return speel();
  }
  // Terugval: ontgrendel de speler binnen de tik en laad daarna.
  el.audio.removeAttribute('src');
  el.audio.load();
  el.audio.play().catch(() => {});
  haal('audio', o.id).then((r) => {
    if (!r) return meldStatus('Deze opname is niet gevonden. Lees de map opnieuw in.');
    blobUrls.set(o.id, URL.createObjectURL(r.blob));
    laadInSpeler(o, blobUrls.get(o.id));
    speel();
  }).catch(console.error);
}

function laadInSpeler(o, url) {
  huidige = o;
  el.audio.src = url;
  zetPositie(0, o.duur || 0);
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: o.titel, artist: o.ministerie, album: 'Studio 1400' });
  }
  toonSpeler();
}

const speel = () => el.audio.play().catch((e) => {
  if (e.name !== 'AbortError') meldStatus('Afspelen lukt niet. Tik nog een keer op de opname.');
});

function wissel() {
  if (!huidige) return;
  if (el.audio.paused) speel();
  else el.audio.pause();
}

const duurNu = () => (Number.isFinite(el.audio.duration) && el.audio.duration > 0 ? el.audio.duration : huidige?.duur || 0);

function toonSpeler() {
  const speelt = Boolean(huidige) && !el.audio.paused;
  el.spelerKnop.disabled = !huidige;
  el.spelerKnop.setAttribute('aria-label', speelt ? 'Pauzeren' : 'Afspelen');
  zetIcoon(el.spelerKnop.querySelector('svg'), speelt ? 'pauze' : 'afspelen');
  el.spelerTitel.textContent = huidige ? huidige.titel : 'Kies een opname';
  el.spelerMinisterie.textContent = huidige ? huidige.ministerie : 'Speler';
  el.voortgang.setAttribute('aria-disabled', String(!huidige));
  el.voortgang.tabIndex = huidige ? 0 : -1;
  markeerSpelend();
}

function zetPositie(s, totaal) {
  const v = el.voortgang;
  v.style.setProperty('--deel', String(totaal > 0 ? Math.min(Math.max(s / totaal, 0), 1) : 0));
  v.setAttribute('aria-valuemax', String(Math.round(totaal)));
  v.setAttribute('aria-valuenow', String(Math.round(s)));
  v.setAttribute('aria-valuetext', `${tijd(s) || '0:00'} van ${tijd(totaal) || '0:00'}`);
  for (const [t, w] of [[el.tijdNu, s], [el.tijdTotaal, totaal]]) {
    t.textContent = tijd(w) || '0:00';
    t.dateTime = duurAttribuut(w);
  }
}

// Eigen schuif: op iPad kan een standaard range-invoer niet zoeken met één tik.
function bindSchuif() {
  const s = el.voortgang;
  let doel = 0;
  const naar = (e) => {
    const r = s.getBoundingClientRect();
    doel = Math.min(Math.max((e.clientX - r.left - 16) / (r.width - 32), 0), 1) * duurNu();
    zetPositie(doel, duurNu());
  };
  const los = () => {
    if (!sleept) return;
    sleept = false;
    el.audio.currentTime = doel;
  };
  s.addEventListener('pointerdown', (e) => {
    if (!huidige || !duurNu()) return;
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    sleept = true;
    naar(e);
  });
  s.addEventListener('pointermove', (e) => { if (sleept) naar(e); });
  s.addEventListener('pointerup', los);
  s.addEventListener('pointercancel', los);
  s.addEventListener('keydown', (e) => {
    const stap = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10 }[e.key];
    const nieuw = e.key === 'Home' ? 0 : e.key === 'End' ? duurNu() : stap ? el.audio.currentTime + stap : null;
    if (!huidige || nieuw === null) return;
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
  a.addEventListener('timeupdate', () => { if (!sleept) zetPositie(a.currentTime, duurNu()); });
  a.addEventListener('durationchange', () => {
    if (!huidige || !Number.isFinite(a.duration) || a.duration <= 0) return;
    if (!huidige.duur) {
      huidige.duur = a.duration;
      bewaar([['opnames', huidige]]).catch(() => {});
      toonOpnames();
    }
    zetPositie(a.currentTime, a.duration);
  });
  a.addEventListener('error', () => { if (huidige && a.getAttribute('src')) meldStatus('Deze opname kan niet worden afgespeeld.'); });
  try {
    navigator.mediaSession?.setActionHandler('play', speel);
    navigator.mediaSession?.setActionHandler('pause', () => a.pause());
  } catch { /* niet ondersteund */ }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !a.paused) houdSchermAan(true);
  });
}

/* ---------- Inlezen ---------- */

function deelIn(bestanden) {
  const items = bestanden.map((f) => ({ f, pad: (f.webkitRelativePath || f.name).split('/').filter(Boolean) }))
    .filter(({ pad }) => !pad.some((d) => d.startsWith('.')));
  const alleenLos = items.filter((x) => AUDIO.test(x.f.name)).every((x) => x.pad.length <= 2);
  const audio = [], huisstijl = [];
  let overgeslagen = 0;

  for (const { f, pad } of items) {
    if (pad.slice(0, -1).some((m) => /^_huisstijl$/i.test(m))) {
      if (LETTER.test(f.name) || LOGO.test(f.name)) huisstijl.push({ f, soort: LETTER.test(f.name) ? 'letter' : 'logo' });
    } else if (!AUDIO.test(f.name)) {
      overgeslagen++;
    } else {
      const map = pad.length >= 3 ? pad[1] : pad.length === 2 && alleenLos ? pad[0] : OVERIG;
      if (!map.startsWith('_')) audio.push({ f, ministerieSleutel: map, sleutel: f.name });
    }
  }

  const mappen = [...new Set(audio.map((a) => a.ministerieSleutel))];
  const mapNummering = heeftNummering(mappen);
  const bestandNummering = new Map(mappen.map((m) => [m, heeftNummering(audio.filter((a) => a.ministerieSleutel === m).map((a) => a.sleutel))]));
  for (const a of audio) {
    a.ministerie = a.ministerieSleutel === OVERIG ? OVERIG : schoneNaam(a.ministerieSleutel, false, mapNummering);
    a.titel = schoneNaam(a.sleutel, true, bestandNummering.get(a.ministerieSleutel));
  }
  return { audio, huisstijl, overgeslagen, zonderMappen: items.length > 0 && items.every((x) => x.pad.length === 1) };
}

function letterKenmerken(naam) {
  const n = naam.toLowerCase();
  return {
    familie: /serif/.test(n) && !/sans/.test(n) ? 'RO Serif' : 'RO Sans',
    stijl: /italic|cursief|oblique/.test(n) ? 'italic' : 'normal',
  };
}

// Meteen lezen: de toegang tot de gekozen map kan later vervallen.
async function leesBestand(f) {
  const buffer = await f.arrayBuffer();
  return { buffer, blob: new Blob([buffer], { type: MIME[extensie(f.name)] || f.type || 'application/octet-stream' }) };
}

const isVol = (e) => e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');

function zetBezig(aan) {
  bezig = aan;
  el.knopMap.classList.toggle('is-uit', aan);
  for (const k of [el.invoerMap, el.knopUpdate, el.knopWissen, el.knopSluiten]) k.disabled = aan;
  el.inlezen.hidden = !aan;
}

function toonBeheerMelding(tekst, soort = '') {
  el.beheerMelding.textContent = tekst;
  el.beheerMelding.className = soort ? `melding melding-${soort}` : 'melding';
  el.beheerMelding.hidden = !tekst;
}

async function leesMapIn(lijst) {
  const { audio, huisstijl, overgeslagen, zonderMappen } = deelIn([...lijst]);
  if (!audio.length) return toonBeheerMelding('In deze map staan geen geluidsbestanden (mp3, m4a, aac of wav).', 'fout');

  const batch = Date.now(), fouten = [];
  let melding;
  toonBeheerMelding('');
  zetBezig(true);
  el.inlezenBalk.max = audio.length;
  try {
    for (const [i, a] of audio.entries()) {
      el.inlezenBalk.value = i;
      el.inlezenTekst.textContent = `Bezig: ${i + 1} van ${audio.length}. ${a.titel}`;
      try {
        const { buffer, blob } = await leesBestand(a.f), id = `${batch}-${i}`;
        const { ministerieSleutel, ministerie, sleutel, titel } = a;
        await bewaar([['audio', { id, blob }], ['opnames', {
          id, batch, ministerieSleutel, ministerie, sleutel, titel, duur: duurUitBuffer(buffer, a.f.name), grootte: blob.size, bestand: a.f.name,
        }]]);
      } catch (e) {
        if (isVol(e)) throw e;
        fouten.push(`${a.f.name}: ${e.message || e.name}`);
      }
    }
    el.inlezenBalk.value = audio.length;
    if (huisstijl.length) el.inlezenTekst.textContent = 'Bezig met de huisstijl.';
    for (const [i, h] of huisstijl.entries()) {
      const { blob } = await leesBestand(h.f);
      await bewaar([['huisstijl', { id: `${batch}-h${i}`, batch, soort: h.soort, bestand: h.f.name, blob, ...(h.soort === 'letter' ? letterKenmerken(h.f.name) : {}) }]]);
    }

    const gelukt = audio.length - fouten.length;
    if (!gelukt) throw new Error('Geen enkele opname kon worden ingelezen.');
    await zetMeta('batch', batch);
    if (huisstijl.length) await zetMeta('huisstijlBatch', batch);
    await ruimOp();

    const letters = huisstijl.filter((h) => h.soort === 'letter').length;
    const regels = [`Klaar. ${meervoud(gelukt, 'opname', 'opnames')} ingelezen.`];
    if (huisstijl.length) regels.push(`Huisstijl: ${meervoud(letters, 'lettertype', 'lettertypes')}${huisstijl.some((h) => h.soort === 'logo') ? ' en een logo' : ''}.`);
    if (overgeslagen) regels.push(`${meervoud(overgeslagen, 'bestand', 'bestanden')} overgeslagen, want dat is geen geluid.`);
    if (zonderMappen) regels.push(`Deze iPad gaf geen mappen door. Alles staat onder '${OVERIG}'. Werk iPadOS bij naar 18.4 of nieuwer.`);
    if (fouten.length) regels.push(`Niet gelukt (${fouten.length}):`, ...fouten.slice(0, 10).map((f) => `- ${f}`));
    melding = [regels.join('\n'), fouten.length || zonderMappen ? 'let-op' : ''];
  } catch (e) {
    console.error(e);
    await verwijderBatch(batch).catch(() => {});
    melding = [isVol(e)
      ? 'De iPad heeft niet genoeg ruimte. Er is niets veranderd. Maak ruimte vrij of kies minder opnames.'
      : `Inlezen is niet gelukt. Er is niets veranderd.\n${e.message || e.name}`, 'fout'];
  }
  try { await navigator.storage?.persist?.(); } catch { /* geen probleem */ }
  await herlaad().finally(() => zetBezig(false));
  toonBeheerMelding(...melding);
}

/* ---------- Huisstijl uit de submap _huisstijl ---------- */

async function laadHuisstijl() {
  const batch = await haal('meta', 'huisstijlBatch');
  const items = batch ? (await alles('huisstijl')).filter((h) => h.batch === batch) : [];
  geladenLetters.forEach((f) => document.fonts.delete(f));
  geladenLetters = [];
  for (const h of items.filter((i) => i.soort === 'letter')) {
    try {
      const ff = new FontFace(h.familie, await h.blob.arrayBuffer(), { style: h.stijl });
      document.fonts.add(await ff.load());
      geladenLetters.push(ff);
    } catch (e) {
      console.warn('Lettertype niet geladen:', h.bestand, e);
    }
  }
  if (logoUrl) URL.revokeObjectURL(logoUrl);
  const logo = items.find((i) => i.soort === 'logo');
  logoUrl = logo ? URL.createObjectURL(logo.blob) : null;
  el.logoStrook.replaceChildren();
  if (logo) {
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

async function toonOpslag() {
  const n = [...bibliotheek.values()].reduce((som, g) => som + g.opnames.length, 0);
  const regels = [n ? `${meervoud(n, 'opname', 'opnames')} bij ${meervoud(bibliotheek.size, 'ministerie', 'ministeries')}.` : 'Er staan geen opnames op deze iPad.'];
  try {
    const { usage = 0, quota = 0 } = (await navigator.storage?.estimate?.()) || {};
    if (quota) regels.push(`In gebruik: ${grootteTekst(usage)}. Maximaal: ${grootteTekst(quota)}.`);
    if (navigator.storage?.persisted) {
      regels.push(await navigator.storage.persisted() ? 'De opslag is blijvend.' : 'De opslag is niet blijvend. iPadOS kan de opnames wissen als de iPad vol raakt.');
    }
  } catch { /* niet ondersteund */ }
  el.opslagTekst.textContent = regels.join('\n');
}

async function zoekUpdate() {
  if (!navigator.onLine) return toonBeheerMelding('Er is geen internet. Probeer het later opnieuw.', 'let-op');
  el.knopUpdate.disabled = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
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
  } catch {
    handmatigeUpdate = false;
    toonBeheerMelding('Zoeken naar een update is niet gelukt. Probeer het later opnieuw.', 'let-op');
  } finally {
    el.knopUpdate.disabled = false;
  }
}

async function wisOpnames() {
  if (!confirm('Alle opnames en de huisstijl wissen van deze iPad?')) return;
  await tx(WINKELS, 'readwrite', (st) => WINKELS.forEach((w) => st(w).clear()));
  await herlaad();
  toonBeheerMelding('Alles is gewist.');
}

function bindBeheer() {
  // Verborgen ingang voor de beheerder: 3 seconden op de kop drukken.
  let timer;
  const stop = () => clearTimeout(timer);
  el.kop.addEventListener('pointerdown', () => {
    stop();
    timer = setTimeout(openBeheer, LANG_DRUKKEN_MS);
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) el.kop.addEventListener(t, stop);
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  el.knopLeegBeheer.addEventListener('click', openBeheer);
  el.knopSluiten.addEventListener('click', () => { if (!bezig) el.beheer.close(); });
  el.beheer.addEventListener('cancel', (e) => { if (bezig) e.preventDefault(); });
  el.knopUpdate.addEventListener('click', zoekUpdate);
  el.knopWissen.addEventListener('click', () => wisOpnames().catch((e) => {
    console.error(e);
    toonBeheerMelding('Wissen is niet gelukt.', 'fout');
  }));
  el.invoerMap.addEventListener('change', () => {
    if (el.invoerMap.files?.length) leesMapIn(el.invoerMap.files).finally(() => { el.invoerMap.value = ''; });
  });
}

/* ---------- Rust: terug naar het begin als niemand de iPad gebruikt ---------- */

function stopSpeler() {
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.load();
  huidige = null;
  blobUrls.forEach((url) => URL.revokeObjectURL(url));
  blobUrls.clear();
  zetPositie(0, 0);
  toonSpeler();
}

async function herlaad() {
  stopSpeler();
  gekozen = null;
  await laadHuisstijl();
  await laadBibliotheek();
  toonMinisteries();
  toonOpnames();
  await toonOpslag();
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
  const actie = () => {
    laatsteActie = Date.now();
    inRust = false;
  };
  for (const t of ['pointerdown', 'keydown', 'wheel']) addEventListener(t, actie, { capture: true, passive: true });
  setInterval(() => {
    if (bezig || !el.audio.paused || Date.now() - laatsteActie < RUST_NA_MS) return;
    if (updateKlaar) location.reload();
    else if (!inRust) naarBegin();
  }, 10000);
}

/* ---------- Service worker en start ---------- */

function registreerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadBeheerder = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadBeheerder) return; // eerste installatie
    if (handmatigeUpdate) location.reload();
    else updateKlaar = true; // herladen zodra niemand luistert
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    setInterval(() => { if (navigator.onLine) reg.update().catch(() => {}); }, UPDATE_ELKE_MS);
  }).catch((e) => console.warn('Service worker niet geregistreerd', e));
}

async function start() {
  el.versie.textContent = VERSIE;
  el.invoerMap.webkitdirectory = true; // Mappen kiezen (iPadOS 18.4+). Geen HTML-standaard, dus via script.
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
