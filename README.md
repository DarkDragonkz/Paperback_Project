# Paperback_Project

Repository multi-source per estensioni Paperback iOS 0.9. NineManga e la prima sorgente inclusa, ma la struttura resta pronta per aggiungere altri siti senza spostare logica specifica nel livello globale.

## Struttura

```text
src/
  common/
    http/
    parsing/
    models/
    utils/
  NineManga/
    main.ts
    pbconfig.ts
    NineMangaClient.ts
    NineMangaParser.ts
    NineMangaModels.ts
    static/icon.png
```

`src/common/` contiene solo helper riutilizzabili: richieste HTTP, header, normalizzazione URL, deduplica e parsing HTML sicuro. Endpoint, selettori e regole come `?waring=1` restano dentro `src/NineManga/`.

L'analisi dello ZIP usato per costruire la prima sorgente e in `docs/ninemanga-zip-analysis.md`.

## Installazione

```bash
npm install
```

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
