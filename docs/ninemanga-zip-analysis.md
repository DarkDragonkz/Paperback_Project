# NineManga ZIP analysis

Analisi basata su `www.ninemanga.zip`, estratto da `www.ninemanga.com_20260526_134154`.

## Copertura ZIP

- `source_profile.json`: presente, 140 record, 80 pagine visitate.
- `extraction_summary.md`: presente, include riepilogo ruoli, endpoint e selector hints.
- `pages/`: presenti pagine home, list, category, search, manga detail, capitolo e frammenti AJAX.
- `assets/`: presenti 6 file JavaScript mobile/site. Non sono presenti CSS o immagini statiche del sito, oltre agli screenshot.
- `reports/resources.csv`: presente, usato per verificare URL, ruoli e path locali.

## Endpoint verificati

- Listing iniziali: `/list/New-Update/`, `/list/Hot-Book/`, `/list/New-Book/`.
- Directory: `/category/`, `/category/updated.html`, `/category/completed.html`, `/category/A.html` ... `/category/Z.html`, `/category/0-9.html`.
- Listing AJAX: `next_url_pre` inline conferma `/ajax/lastest/page-`, `/ajax/hot_manga/page-`, `/ajax/new_manga/page-`, `/ajax/category/category-*-page-`.
- Search page: `/search/?type=high`, form GET `/search/`.
- Search mobile JSON: il JS `base.js` conferma `$.getJSON("/search/mobile/", {"wd": kw}, ...)` e il formato array usato dal frontend.

## Selettori verificati

### Listing

- Container: `ul#list_container li` oppure frammenti AJAX con `li`.
- Manga URL: `dt a[href]`, fallback `dd.book-list a[href]`.
- Titolo: `dd.book-list b`, fallback `dt a[title]`.
- Cover: `dt img[src]`.
- Generi: `dd.book-list span`.
- Ultimo capitolo: `dd.chapter a`.

### Manga detail

- Titolo: `div.book-info h1 b`.
- Cover: `div.book-info dt img[src]`.
- Metadata: `dd.about-book p`, con label in `span`.
- Descrizione: `dd.short-info p span`, fallback `dd.short-info span` e `dd.short-info p`.
- Capitoli: `ul.chapter-box li`.
- Link capitolo: `div.chapter-name.long a`.
- Short chapter label: `div.chapter-name.short a`.

### Reader

- Titolo capitolo: `h1.chapter_title`.
- Select pagine: `select.sl-page option[value]`.
- Immagine pagina: `img.manga_pic[src]`.

## Warning adult

Lo ZIP conferma `is_warning = "1"` su varie pagine e pagine manga con blocco adult. Il link di bypass usa `?waring=1`, non `?warning=1`.

La sorgente implementa un retry solo quando una pagina manga contiene warning e non espone capitoli.

## Dati non completamente coperti

Non c'e nello ZIP una risposta reale di `/search/mobile/?wd=QUERY` con query non vuota. Il contratto e pero visibile nel JavaScript incluso: `item[0]` cover, `item[1]` titolo, `item[2]` URL manga, `item[4]` autore. Per questo la sorgente usa l'endpoint mobile JSON invece di inventare selettori search non presenti.
