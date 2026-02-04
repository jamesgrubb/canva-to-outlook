# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A single-page web app that converts Canva email exports into Outlook-compatible HTML. The user uploads a Canva export (folder or ZIP containing an HTML file and an `images/` directory). The server uploads the images to Cloudinary and rewrites all image paths in the HTML to point to the Cloudinary CDN URLs. The result is copy-paste-ready HTML for use in Outlook or similar email clients.

## Running the Server

```bash
npm install
npm start          # starts Express on PORT (default 3000)
```

There are no test or lint scripts configured in this project.

## Environment Configuration

The server requires Cloudinary credentials. Copy `.env.example` to `.env` and fill in your values. Two upload modes are supported, selected automatically at startup:

- **Signed uploads**: Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. This is the more secure option.
- **Unsigned uploads**: Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_UPLOAD_PRESET` (leave `API_SECRET` empty). Requires a preset configured in the Cloudinary dashboard.

The startup validation logic in `server.js` (top of file) will log which mode is active and fail early if the configuration is incomplete.

**WARNING**: The checked-in `.env` file currently contains real Cloudinary credentials. These should be rotated and the file should remain in `.gitignore` only (via `.env.example`).

## Architecture

Everything lives at the top level — there is no `src/` directory or build step.

- **`server.js`** — The entire backend. Express app with two meaningful routes:
  - `POST /api/process` — accepts multipart form data (HTML file + images), uploads images to Cloudinary into a timestamped folder (`emails/{timestamp}/`), uses cheerio to rewrite `<img src>` and `<link rel="preload" as="image" href>` attributes, returns `{ html, imageCount, folder }`.
  - `GET /api/health` — returns current Cloudinary config status (useful for debugging auth issues).
- **`public/index.html`** — The entire frontend in a single file (~1000 lines). No framework, no bundler. Key external deps loaded from CDN: JSZip (for ZIP extraction) and Lucide (icons). State is managed via plain JS variables (`selectedFiles`, `processedHtml`, `isZipFile`).

### Request flow

1. User drags a folder or ZIP onto the frontend drop zone.
2. Frontend validates that an HTML file and at least one image in `images/` are present.
3. Frontend POSTs a `FormData` payload to `/api/process`. Image paths are preserved as `images/<filename>` in the multipart field names.
4. Server extracts the HTML file (prefers `index.html`, then `email.html`, then any `.html`), uploads images to Cloudinary, builds a `localPath → cloudinaryURL` map, rewrites the HTML with cheerio, and returns the processed HTML.
5. Frontend stores the result and offers copy-to-clipboard / download.

### Key implementation details

- **Multer** is configured with memory storage (no files written to disk). Limits: 10 MB per file, 50 MB total.
- Image file validation (`isImageFile`) checks extensions: `.png .jpg .jpeg .gif .webp`.
- Cloudinary uploads run in parallel via `Promise.all`.
- The frontend's drag-and-drop uses the Entry API (`webkitGetAsEntry`) for recursive directory reading. ZIP handling uses JSZip. Both paths normalize file paths before submission.
- Lucide icon initialization has retry logic (100ms → 500ms → 5s) with an SVG fallback if it never loads.

## Sample files

- `email.html` and `email.txt` in the repo root are example outputs from a previous conversion run. They are not used by the app at runtime.
- The `images/` directory contains sample images from a Canva export.
