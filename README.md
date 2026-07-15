# yashnaarora.com

Personal portfolio site for Yashna Arora. Plain static HTML/CSS/JS — no build step.

## Structure
- `*.html` — pages (index, about, mining, playground, stratagile, unlock, wall, work)
- `public/assets/css/` — stylesheets (style.css, media.css)
- `public/assets/js/` — custom.js
- `public/assets/images/` — images, videos, PDFs

## Local preview
Any static server works, e.g.:
```
npx serve .
```
Then open the printed localhost URL.

## Deploy
Connected to **Cloudflare Pages** (project `yashna-arora-com`, domain yashnaarora.com).
Every push to `main` auto-deploys. Build command: _none_. Output directory: `/` (root).

<!-- git-deploy pipeline verified test-deploy -->
