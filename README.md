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

`npm test` checks copy and internal links, serves the site locally, renders the
four pages in Chromium at desktop, tablet, mobile, and 320-pixel widths, checks
color and reduced-motion preferences, runs axe-core, and rejects console
errors, unexpected network requests, broken anchors, and horizontal overflow.

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
