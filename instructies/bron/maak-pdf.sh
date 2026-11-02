#!/bin/sh
# Maakt de pdf's in instructies/ opnieuw. Nodig: WeasyPrint en in huisstijl/ de bestanden
# header-logo.svg, rijks-sans-regular.woff2 en rijks-sans-italic.woff2 uit de map _huisstijl.
set -e
cd "$(dirname "$0")"
for f in ipad-als-kiosk opnames-bijwerken-op-de-ipad; do
  weasyprint "$f.html" "../$f.pdf"
done
