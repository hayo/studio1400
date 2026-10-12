# Studio 1400

Een app voor de iPad. Bezoekers kiezen een ministerie en luisteren naar opnames. De app werkt zonder internet.

- Op GitHub Pages staat alleen de code van de app. Er staan geen opnames online.
- Op de iPad zet je de app één keer op het beginscherm.
- De opnames lees je in vanuit een map op de iPad. Ze blijven op de iPad.

## Eenmalig: GitHub Pages aanzetten

1. Ga in deze repo naar **Settings → Pages**.
2. Kies bij **Source** voor **Deploy from a branch**.
3. Kies branch `main` en map `/docs`. Tik op **Save**.
4. Na een paar minuten staat de app op <https://hayo.github.io/studio1400/>.

## De iPad klaarmaken

Je hebt iPadOS 18.4 of nieuwer nodig, en één keer internet.

1. Open <https://hayo.github.io/studio1400/> in Safari.
2. Tik op **Deel → Zet op beginscherm**. Laat **Open als webapp** aan staan.
3. Open de app vanaf het beginscherm. Lees de opnames vanaf daar in, niet in Safari. Safari en de app delen geen opslag.

## De map met opnames

```
Studio1400/
├── 01 Algemene Zaken/
│   ├── 01 - Persconferentie na de ministerraad.mp3
│   └── 02 - Toespraak minister-president.mp3
├── 02 Binnenlandse Zaken en Koninkrijksrelaties/
│   └── Interview.mp3
├── _huisstijl/
│   ├── RO Sans Regular.woff2
│   ├── RO Sans Bold.woff2
│   └── logo.svg
└── _archief/
    └── oude opname.mp3
```

- Elke submap is een ministerie. De naam van de map is de naam in de app.
- De bestandsnaam is de titel. Een liggend streepje (`_`) wordt een spatie.
- Wil je een vaste volgorde? Zet een nummer vooraan: `01`, `02`, `03`. Dat nummer toont de app niet.
- De app leest mp3, m4a, aac en wav.
- Submappen die met `_` beginnen, toont de app niet. Handig voor een archief.
- Losse bestanden buiten een submap komen onder **Overige opnames**.

### Lettertype en logo

RO Sans en het logo horen niet in een openbare repo. Zet ze daarom in de submap `_huisstijl`:

- de lettertypebestanden van RO Sans (woff2, woff, ttf of otf). Staat `bold` in de naam, dan wordt het vet. Staat `italic` in de naam, dan wordt het cursief.
- het logo als `logo.svg` of `logo.png`.

Zonder deze map gebruikt de app Verdana en toont hij geen logo.

## Opnames inlezen of bijwerken

1. Zet de map op de iPad, bijvoorbeeld in **Bestanden → Op mijn iPad**. Dat kan met een USB-stick, AirDrop of OneDrive.
2. Open **Beheer**: houd de blauwe balk bovenaan 3 seconden ingedrukt. Staan er nog geen opnames op de iPad, dan zie je meteen een knop.
3. Tik op **Map kiezen** en kies de map `Studio1400`.
4. Wacht tot de app **Klaar** meldt.

De nieuwe opnames vervangen alle oude. Gaat er iets mis, dan blijven de oude opnames staan.

## Vastzetten voor bezoekers

Gebruik **Begeleide toegang** (Instellingen → Toegankelijkheid).

1. Zet Begeleide toegang aan en stel een toegangscode in.
2. Zet het automatisch vergrendelen van het scherm op **Nooit**.
3. Open de app en druk drie keer op de zijknop.
4. Zet bij **Opties** de volumeknoppen aan en tik op **Start**.

Het geluid regel je met de volumeknoppen van de iPad. Een volumeknop in de app kan niet: iPadOS staat dat niet toe.

## Wat bezoekers zien

- Links staan de ministeries, rechts de opnames. Eén tik op een opname start het afspelen.
- Onderaan staat de speler. Tik of sleep op de balk om te zoeken.
- Na een opname stopt de app. Hij speelt niet vanzelf de volgende.
- Na 2 minuten zonder gebruik gaat de app terug naar het begin. Dat gebeurt niet als er iets speelt.

## Updates

- Heeft de iPad internet, dan zoekt de app zelf naar een nieuwe versie. Die gaat in als niemand de app gebruikt.
- In **Beheer** kun je ook op **Zoek naar update** tikken.
- Wijzig je de code? Verhoog dan `VERSIE` in `docs/app.js` én `docs/sw.js`. Anders haalt de iPad de nieuwe versie niet op.

## Lokaal testen

```sh
python3 -m http.server 8000 --directory docs
```

Open daarna <http://localhost:8000> in een browser.
