# PDF Grouper

Split PDFs and images into named groups, one output PDF per group. Runs entirely in the browser: files never leave the user's computer, and no backend or API is required.

## Run with Docker

```bash
docker compose up -d --build
```

Open **http://localhost:8090**. To use another port, change `8090:80` in `docker-compose.yml`.

Stop it with `docker compose down`.

## Run without Docker (development)

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

## How to use

1. **Add files**: click "Add PDFs / images" or drag files onto the window. PDF, JPG, PNG and other image formats are accepted; several files can be combined.
2. **Select pages**: click pages to select them; Shift-click selects a range; Esc clears the selection. Hover a page to preview or rotate it.
3. **Create a group**: click "Create group", type a name, press Enter. The pages are added to the group panel and the selection is cleared for the next group. A page may be used in several groups.
4. **Edit a group**: "Edit / preview" opens the group, where you can rename it, drag pages to reorder, rotate, preview, remove pages, add pages, set its size limit, or delete it. "+ Add N" on a group card appends the currently selected pages.
5. **Generate**: produces one PDF per group, named after the group. Download each one, or all together as a ZIP.

## Size limits and compression

- **Default limit**: set in the header (3 MB initially). Each group can use the default, its own limit, or no limit.
- Every group goes through three steps:
  1. **Lossless build**: original page content is copied unchanged. If within the limit, this is the output.
  2. **Image compression**: if over the limit, images are recompressed to 150 DPI using Ghostscript. Text, fonts and vector graphics are not touched, so text stays sharp and searchable.
  3. **Warning**: if still over the limit, the smallest readable version is kept and a warning is shown. Quality is never reduced further.
- The first compression in a session loads the engine (about 16 MB); the browser then caches it.

## Project structure

| Path | Purpose |
|---|---|
| `src/App.tsx` | Main screen: page pool, selection, group panel |
| `src/components/` | Thumbnails, group editor, preview, results, size-limit picker |
| `src/lib/pdf.ts` | Loading files, rendering pages (pdf.js), building PDFs (pdf-lib), compression worker bridge |
| `src/lib/generate.ts` | Per-group generation pipeline, file naming, ZIP |
| `public/gs/gs-worker.js` | Web worker that runs Ghostscript (WebAssembly) |
| `scripts/copy-gs.mjs` | Copies the Ghostscript engine into `public/gs` before dev/build |
| `Dockerfile`, `nginx.conf`, `docker-compose.yml` | Container build and serving |

## Notes

- **Password-protected PDFs** are rejected with a message; remove the password first.
- **Very large files** (hundreds of high-resolution pages) are limited by the browser's memory. Thumbnails render progressively to keep the page responsive.
- **Licence**: the Ghostscript engine (`@jspawn/ghostscript-wasm`) is AGPL-3.0. Internal use within the organisation is unaffected. If the tool is offered publicly over the internet, the AGPL requires making this project's source code available to its users.
