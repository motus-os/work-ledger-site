# Motus Work Ledger website

Static website for [Motus Work Ledger](https://github.com/motus-os/work-ledger).
The production site is plain HTML and CSS with no client-side JavaScript,
cookies, forms, or analytics.

## Develop

Use Node.js 24, then install the locked development dependencies:

```console
$ npm ci
$ npm test
```

`npm test` checks copy and internal links, serves the site on an available
local port, and renders all four pages in Chromium from 280 through 2560
pixels, including both sides of the main responsive breakpoint. It checks
color and reduced-motion preferences, keyboard focus, text spacing, axe-core,
custom 404 behavior, mobile navigation, console errors, unexpected network
requests, broken anchors, horizontal overflow, and nested text clipping. The
real example's four retrieval facts are checked in the accessibility tree; the
same assertion is required to fail when their container is hidden from that
tree.

Before publishing, run the same browser checks in Chromium, Firefox, and
WebKit:

```console
$ npm run check:browser:full
```

Start a local server with:

```console
$ npm run serve
```

Open <http://127.0.0.1:4173/>.

## Publishing

After GitHub Pages is configured to use GitHub Actions, the `Deploy Pages`
workflow publishes `site/` from `main` when started manually. Deploy only
after the reviewed commit passes the local and GitHub checks.

## License

Apache License 2.0. See [LICENSE](LICENSE).
