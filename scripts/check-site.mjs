import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repositoryRoot, "site");
const expectedPages = ["index.html", "security.html", "privacy.html", "404.html"];
const allowedExternalOrigins = new Set([
  "https://docs.github.com",
  "https://github.com",
  "https://motus-os.github.io",
  "https://www.motussupra.com",
]);
const repositoryPagesURL = new URL("https://motus-os.github.io/work-ledger-site/");
const forbiddenPhrases = [
  "ai-powered",
  "game-changing",
  "honest answers",
  "in today's fast-paced",
  "revolutionize",
  "seamless",
  "supercharge",
  "unlock the power",
  "version-1 ledger",
];
const requiredPhrases = {
  "index.html": [
    'id="findings"',
    "finding list --query stale",
    "Findings stay separate from run receipts.",
  ],
  "security.html": [
    "event and finding payload hashes",
    "Review that content before recording it.",
  ],
  "privacy.html": [
    "Finding text and closure notes are stored only when you submit them",
  ],
};
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  const fullPath = path.join(siteRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`missing ${relativePath}`);
    return "";
  }
  return fs.readFileSync(fullPath, "utf8");
}

function idsIn(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

function pageForURL(url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  return pathname.replace(/^\//, "");
}

for (const page of expectedPages) {
  const html = read(page);
  if (!html) continue;

  const label = `site/${page}`;
  if (!/^<!doctype html>/i.test(html)) fail(`${label}: missing doctype`);
  if (!/<html lang="en">/.test(html)) fail(`${label}: missing English language declaration`);
  if (!/<meta charset="utf-8">/.test(html)) fail(`${label}: missing UTF-8 declaration`);
  if (!/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(html)) {
    fail(`${label}: missing viewport declaration`);
  }
  if ((html.match(/<title>/g) || []).length !== 1) fail(`${label}: must have one title`);
  if ((html.match(/<h1(?:\s|>)/g) || []).length !== 1) fail(`${label}: must have one h1`);
  if (!/<main(?:\s|>)/.test(html)) fail(`${label}: missing main landmark`);
  if (!/<header(?:\s|>)/.test(html)) fail(`${label}: missing header landmark`);
  if (!/<footer(?:\s|>)/.test(html)) fail(`${label}: missing footer landmark`);
  if (!/class="skip-link"/.test(html)) fail(`${label}: missing skip link`);
  if (/<script(?:\s|>)/i.test(html)) fail(`${label}: production pages must not run JavaScript`);
  if (/\sstyle="/i.test(html)) fail(`${label}: inline style found`);
  if (/\son[a-z]+="/i.test(html)) fail(`${label}: inline event handler found`);
  if (/\u2013|\u2014/.test(html)) fail(`${label}: en or em dash found`);

  const lower = html.toLowerCase();
  for (const phrase of forbiddenPhrases) {
    if (lower.includes(phrase)) fail(`${label}: forbidden phrase ${JSON.stringify(phrase)}`);
  }

  for (const phrase of requiredPhrases[page] || []) {
    if (!html.includes(phrase)) fail(`${label}: missing required product fact ${JSON.stringify(phrase)}`);
  }

  const ownIDs = idsIn(html);
  const references = [...html.matchAll(/\s(?:href|src)=(["'])(.*?)\1/g)].map((match) => match[2]);
  for (const reference of references) {
    if (reference.startsWith("#")) {
      if (!ownIDs.has(reference.slice(1))) fail(`${label}: broken anchor ${reference}`);
      continue;
    }
    if (/^(mailto:|tel:)/.test(reference)) continue;
    if (/^https:\/\//.test(reference)) {
      const external = new URL(reference);
      if (external.origin === repositoryPagesURL.origin) {
        if (!external.pathname.startsWith(repositoryPagesURL.pathname)) {
          fail(`${label}: repository Pages URL escapes ${repositoryPagesURL.pathname}: ${reference}`);
          continue;
        }
        const targetPage = external.pathname.slice(repositoryPagesURL.pathname.length) || "index.html";
        if (!fs.existsSync(path.join(siteRoot, targetPage))) {
          fail(`${label}: missing repository Pages target ${reference}`);
          continue;
        }
        if (external.hash && targetPage.endsWith(".html")) {
          const targetHTML = read(targetPage);
          if (!idsIn(targetHTML).has(external.hash.slice(1))) {
            fail(`${label}: broken repository Pages anchor ${reference}`);
          }
        }
        continue;
      }
      if (!allowedExternalOrigins.has(external.origin)) {
        fail(`${label}: unapproved external origin ${external.origin}`);
      }
      continue;
    }
    if (/^[a-z]+:/i.test(reference) || reference.startsWith("//")) {
      fail(`${label}: unsupported URL ${reference}`);
      continue;
    }
    if (reference.startsWith("/")) {
      fail(`${label}: root-relative local URL is not portable to the repository Pages path: ${reference}`);
      continue;
    }

    const target = new URL(reference, `https://www.motussupra.com/${page}`);
    const targetPage = pageForURL(target);
    if (targetPage && !fs.existsSync(path.join(siteRoot, targetPage))) {
      fail(`${label}: missing local target ${reference}`);
      continue;
    }
    if (target.hash && targetPage.endsWith(".html")) {
      const targetHTML = read(targetPage);
      if (!idsIn(targetHTML).has(target.hash.slice(1))) {
        fail(`${label}: broken cross-page anchor ${reference}`);
      }
    }
  }

  for (const match of html.matchAll(/https:\/\/[^"'\s<]+/g)) {
    const external = new URL(match[0]);
    if (external.origin === repositoryPagesURL.origin
      && !external.pathname.startsWith(repositoryPagesURL.pathname)) {
      fail(`${label}: repository Pages URL escapes ${repositoryPagesURL.pathname}: ${match[0]}`);
      continue;
    }
    if (!allowedExternalOrigins.has(external.origin)) {
      fail(`${label}: unapproved external origin ${external.origin}`);
    }
  }
}

const css = read("assets/site.css");
if (/gradient\s*\(/i.test(css)) fail("site/assets/site.css: gradients are not permitted");
if (/\u2013|\u2014/.test(css)) fail("site/assets/site.css: en or em dash found");
if (/url\(["']?https?:/i.test(css)) fail("site/assets/site.css: remote asset found");
if (/url\(\s*["']?\/(?!\/)/i.test(css)) {
  fail("site/assets/site.css: root-relative asset URL is not portable to the repository Pages path");
}

for (const required of [
  "assets/site.css",
  "assets/favicon.svg",
  "assets/og-image.png",
  "robots.txt",
]) {
  if (!fs.existsSync(path.join(siteRoot, required))) fail(`missing ${required}`);
}

const trackedJunk = [".DS_Store", "Thumbs.db"];
for (const name of trackedJunk) {
  const matches = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(item);
      else if (entry.name === name) matches.push(path.relative(repositoryRoot, item));
    }
  }
  walk(siteRoot);
  for (const match of matches) fail(`junk file found: ${match}`);
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`PASS static site checks (${expectedPages.length} pages)`);
