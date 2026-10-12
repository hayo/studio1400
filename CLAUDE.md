# Studio 1400 — afspraken en learnings

Lees dit aan het begin van elke sessie. Voeg nieuwe learnings onderaan toe.

## Afspraken

- Gebruiksgemak gaat voor alles. Grote tikvlakken (minimaal 56 px), geen gebaren of verborgen bediening voor bezoekers.
- Geen vet: de huisstijl heeft alleen RO Sans regular en italic. Hiërarchie met grootte en kleur; `font-synthesis: none` voorkomt nagemaakt vet.
- Rijkshuisstijl van DPC: lintblauw `#154273` voor structuur (kopbalk, speler, koppen), robijnrood `#ca005d` als accent (gekozen ministerie, afspeelknoppen, voortgang, primaire knoppen), hemelblauw `#007bc7` alleen voor focus. Tekst zwart, RO Sans. Logo boven in het midden.
- Uitstraling: witte kaarten (radius 16 px, zachte schaduw) op lichtblauwgrijze achtergrond `#edf1f6`. Kleuren staan als custom properties in `:root` van `app.css`.
- Code compact houden: geen herhaling, korte helpers, alleen commentaar dat iets uitlegt wat de code niet zegt. Achtergrond en learnings horen in dit bestand, niet in de code.
- Moet standalone draaien op een iPad. Geen Mac, geen eigen hosting, geen ontwikkelaarsaccount, geen MDM.
- Teksten in app en README: Nederlands, taalniveau B1.
- Geen vermelding van AI-hulp, nergens: geen `Co-Authored-By`, geen sessielinks, geen "generated with" in commits, PR's, code of documentatie.
- Commits op naam van `Hayo Bethlehem <mail@hayobethlehem.nl>` (zet `git config user.name/user.email` in de clone).
- Ook dit bestand niet bij naam noemen in code, README of commitberichten. Controleer voor elke push: `git grep -niE 'claude|anthropic' -- docs README.md` moet leeg zijn, en lees het commitbericht na.
- De repo is public. Dus nooit RO Sans-bestanden, logo's of opnames in de repo.
- HTML, CSS en JavaScript volgen de standaarden en zijn semantisch correct. Elke wijziging moet zonder fouten door: W3C Nu HTML Checker (`vnu`, ook met `--css`), `html-validate` (recommended), `stylelint-config-standard`, ESLint (recommended, `eqeqeq`) en axe-core (WCAG 2.2 AA + best practices).
- Semantiek: `section` met kop voor kolommen en speler (geen `nav`/`footer`), `time datetime` voor duren, `aria-current` voor het gekozen ministerie en de opname in de speler.
- CSS-klassen in kebab-case (geen BEM `--`). Iconen krijgen een eigen klasse; geen selectors op `svg`.

## Opzet

- `docs/` is de app. GitHub Pages publiceert vanaf branch `main`, map `/docs` (`.nojekyll` aanwezig). Geen buildstap.
- Bestanden: `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `iconen/`.
- Opnames: beheerder kiest een map via `<input webkitdirectory>`. Bestanden gaan als blob in IndexedDB (`studio1400`; stores `meta`, `opnames`, `audio`, `huisstijl`). Ze gaan nooit online.
- Elke inleesronde krijgt een batch-id. Oude records gaan pas weg als de nieuwe ronde gelukt is (`ruimOp`).
- Map-indeling: eerste submap = ministerie. Submappen met `_` worden overgeslagen. `_huisstijl` levert lettertypen (FontFace "RO Sans", of "RO Serif" bij `serif` zonder `sans`) en een logo (svg/png met `logo` in de naam). Fonts met `icon` in de naam worden overgeslagen.
- Aangeleverde huisstijlbestanden (staan op de iPad, niet in de repo): `header-logo.svg` (lint met beeldmerk, 50×100), `rijks-sans-regular.woff2`, `rijks-sans-italic.woff2`, `ro-serif-italic.woff2`, `ro-icons.woff2`.
- Volgnummers vooraan (`01 - `, `1. `) bepalen de volgorde en worden niet getoond. Een los nummer (`10 Titel`) alleen weg als een buur met `0` begint.
- Beheer openen: 3 s drukken op de kop (`#kop`). Rust-reset na 2 min zonder gebruik (niet tijdens afspelen); updates van de service worker gaan dan ook in.
- `VERSIE` staat in `app.js` én `sw.js`. Altijd allebei ophogen.

## Learnings iPad en Safari

- HTML lokaal openen (file://) werkt niet op iPad. Daarom een web-app via een URL, daarna offline.
- Sinds iPadOS 26 opent elke site op het beginscherm als web-app. In de EU werkt dit nog (Apple draaide de verwijdering in 2024 terug).
- Een beginscherm-app heeft eigen opslag, los van Safari. Inlezen moet in de geïnstalleerde app. Beheer waarschuwt als dat niet zo is.
- WebKit-quotum: tot ongeveer 60% van de schijf per origin. Na inlezen `navigator.storage.persist()` vragen.
- `webkitdirectory` werkt op iOS/iPadOS vanaf 18.4. Zonder mappen komt alles onder "Overige opnames" en meldt de app dat.
- iPadOS laadt geen audiometadata zonder tik. Daarom leest de app de duur zelf uit het bestand: MP3 (Xing/Info, VBRI, anders CBR), MP4/M4A (`mvhd`), WAV. Lukt het niet, dan vult `durationchange` het later aan.
- `play()` moet direct in de tik. Daarom maakt `bereidAfspelenVoor` de object-URL's al klaar bij het kiezen van een ministerie.
- Audio niet via de service worker serveren: Safari vraagt media in stukken (Range) en dan hapert het. Audio komt als blob uit IndexedDB.
- Bestanden meteen lezen met `arrayBuffer()`. De toegang tot een gekozen map kan later vervallen.
- Volume kan niet via JavaScript op iOS. Volumeknoppen aan laten in Begeleide toegang.
- `input type=range` op iOS kent geen tik-om-te-zoeken. Daarom een eigen schuif (`div role=slider`) met pointer events.
- GitHub Pages is gratis voor public repo's. De site is altijd openbaar, daarom `robots: noindex`.
- `.melding` heeft `white-space: pre-line`: geen inspringende HTML-tekst in die elementen zetten.
- `webkitdirectory` is geen HTML-standaardattribuut. Zet het in JS (`input.webkitdirectory = true`), dan valideert de bron.
- Een `<img>` zonder `src` is ongeldig. Het logo maakt JS pas aan als er een logo is.
- Safari op iPadOS heeft voor `user-select` nog `-webkit-user-select` nodig (met `stylelint-disable-next-line`).
- `:has()` (Safari 15.4+) gebruiken we om de lege ministeriekaart te verbergen: `.inhoud:has(> .ministeries[hidden])`.
- Overgangen op knoppen (150 ms): wacht in tests even voor een schermafbeelding. `prefers-reduced-motion` zet alle animaties uit.
- De meldingen na inlezen pas tonen als de bibliotheek opnieuw is geladen, anders laat Beheer verouderde opslaggegevens zien.
- Een iconenfont in `_huisstijl` zou zonder filter als gewone RO Sans laden en tekst in iconen veranderen. Daarom slaat `LETTER` namen met `icon` over.
- Kop is één witte balk van 72 px: titel links, logo (72 px) in het midden vanaf de bovenrand, lintblauwe lijn met robijnrood stukje eronder. Een aparte blauwe balk plus logostrook kostte zo veel hoogte dat liggend maar 4 ministeries zichtbaar waren.
- Hoogtebudget liggend (1180×820): kop 76, speler 100, marges 32. Dan passen 8 van de 12 ministeries; de rest scrollt, met een schaduw onderaan als hint. Staand passen alle 12. Uitleg staat in de kolomkop ("Kies een ministerie"), niet in de kop.
- Ministerie en titel staan in de speler op één regel om hoogte te sparen.
- Beheer moet zonder scrollen passen op 1133×744 (iPad mini liggend): letter 17 px, knoppen 48 px (alleen voor de beheerder), Sluiten bovenin naast de titel, Opslag en App naast elkaar. Gemeten: 679 px hoog met waarschuwing en een lange melding.
- `vnu` weigert localhost-URL's. Controleer bestanden direct; de CSP-meldingen (info) zijn dan een bijeffect van `file:`.

## Testen

- Validatie: alle vijf de controles hierboven zonder fouten (bron én gerenderde DOM, op `webkitdirectory` na).
- Getest in Chromium met Playwright: inlezen (mp3 CBR/VBR/MPEG-2, mp3 met hoes, m4a, wav), duur gelijk aan ffprobe, afspelen, zoeken, pauze, lang drukken, rust-reset, twee keer inlezen zonder dubbelingen, wissen, offline herladen.
- Playwright kan bij het uploaden van een map geen bestanden lezen uit mappen met een trema (`Financiën`). Dat is een testprobleem; de app meldt het netjes onder "Niet gelukt".
- WebKit kon in de testomgeving niet worden gedownload. Een test op een echte iPad is nog nodig.

## Open punten

- Testen op een echte iPad: afspelen na tik, map inlezen, blijvende opslag, Begeleide toegang.
- Kleuren van communicatierijk.nl zijn niet bekeken (browser niet gebruikt). Robijnrood komt uit de Rijkshuisstijl; nog vergelijken met de site.
- VoiceOver op iPad: controleren of de lijsten als lijst worden voorgelezen (WebKit laat dat soms vallen bij `list-style: none`).
