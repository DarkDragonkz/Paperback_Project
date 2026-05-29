# Paperback_Project

Repository multi-source per estensioni Paperback iOS 0.9. Il progetto contiene source dedicate e source basate su helper comuni per siti Manga/Comic/Scanlation.

## Struttura

```text
src/
  common/
    http/
    parsing/
    models/
    utils/
    foolslide/
    pizzareader/
  AnimeGDRClub/
  DigitalTeam/
  MangaWorld/
  NineManga/
  RCOStation/
  ReadAllComics/
  ZeurelScan/
  DDTTeam/
  GTO/
  HastaTeam/
  JuinJutsuTeamReader/
  LupiTeam/
  NIFTeam/
  PhoenixScans/
  TuttoAnimeManga/
```

`src/common/` contiene helper riutilizzabili: richieste HTTP, header, normalizzazione URL, deduplica, parsing HTML sicuro e due basi condivise (`foolslide`, `pizzareader`). Endpoint, selettori e workaround specifici restano nelle cartelle delle singole source.

## Source incluse

- Source dedicate: AnimeGDRClub, DigitalTeam, MangaWorld, NineManga, RCOStation, ReadAllComics, ZeurelScan.
- Source PizzaReader: DDTTeam, GTO, HastaTeam, LupiTeam, PhoenixScans, TuttoAnimeManga.
- Source FoolSlide: JuinJutsuTeamReader, NIFTeam.

L'analisi dello ZIP usato per costruire la prima sorgente e in `docs/ninemanga-zip-analysis.md`.

## Materiale locale

La cartella `.local-reference/` puo contenere ZIP o repository di riferimento usati solo durante lo sviluppo. Anche `_reference_repos/` e ignorata da Git. Questi file non vengono letti a runtime da Paperback, non fanno parte del bundle e non devono essere caricati su GitHub.

## Installazione

```bash
npm install
```

Il progetto usa `@paperback/toolchain` e `@paperback/types` alla stessa versione. Lo script `postinstall` applica una patch locale al toolchain per correggere gli import ESM di percorsi assoluti su Windows; senza questa patch `npm run bundle` puo fallire con `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

## Sviluppo locale

```bash
npm run dev
```

Per servire senza watch:

```bash
npm run serve
```

Log da Paperback:

```bash
npm run logcat
```

Controllo TypeScript:

```bash
npm run tsc
```

## Build

```bash
npm run bundle
```

Il bundle viene generato in `bundles/`.

## Test

```bash
npm test
```

Il comando esegue TypeScript in modalita `--noEmit` e poi crea il bundle.

## Deploy GitHub Pages

Il workflow `.github/workflows/bundle-deploy.yaml` parte su push verso `main`, usa Node 22, esegue `npm ci`, `npm run bundle` e pubblica `bundles/` sul branch `gh-pages`.

URL repository Paperback previsto:

```text
https://DarkDragonkz.github.io/Paperback_Project/
```

## Creazione repository GitHub

```bash
git init
git branch -M main
git remote add origin https://github.com/DarkDragonkz/Paperback_Project.git
git add .
git commit -m "Initial Paperback extensions repository"
git push -u origin main
```

## Aggiungere nuove sorgenti

1. Crea una nuova cartella in `src/NomeSorgente/`.
2. Aggiungi `main.ts`, `pbconfig.ts`, client, parser, modelli e `static/icon.png`.
3. Riusa `src/common/` solo per helper generici.
4. Mantieni selettori, endpoint, workaround e regole del sito dentro la cartella della sorgente.
5. Esegui `npm test` prima del push.
