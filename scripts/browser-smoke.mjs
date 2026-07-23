import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import axe from "axe-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(root, "site");
const origin = "http://127.0.0.1:4173";
const baseURL = `${origin}/site`;
const repositoryPagesURL = new URL("https://motus-os.github.io/work-ledger-site/");
const pages = ["/", "/security.html", "/privacy.html", "/404.html"];
const profiles = [
  { name: "desktop-light", viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "desktop-dark-preference", viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "tablet-light", viewport: { width: 768, height: 1024 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "mobile-light", viewport: { width: 390, height: 844 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "mobile-dark-preference", viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "narrow-light", viewport: { width: 320, height: 700 }, colorScheme: "light", reducedMotion: "no-preference" },
];

function contentType(file) {
  const extension = path.extname(file);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  return "application/octet-stream";
}

function fileWithinSite(relativePath) {
  const candidate = path.resolve(siteRoot, relativePath);
  if (candidate !== siteRoot && !candidate.startsWith(`${siteRoot}${path.sep}`)) return null;
  return candidate;
}

function sendFile(response, file, status) {
  response.writeHead(status, { "content-type": contentType(file) });
  response.end(fs.readFileSync(file));
}

const server = http.createServer((request, response) => {
  const requested = new URL(request.url ?? "/", origin);
  const prefix = "/site/";
  if (requested.pathname === "/site") {
    response.writeHead(308, { location: `${prefix}${requested.search}` });
    response.end();
    return;
  }
  const relativePath = requested.pathname.startsWith(prefix)
    ? decodeURIComponent(requested.pathname.slice(prefix.length)) || "index.html"
    : "";
  const requestedFile = fileWithinSite(relativePath);
  if (requestedFile && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
    sendFile(response, requestedFile, 200);
    return;
  }
  sendFile(response, path.join(siteRoot, "404.html"), 404);
});

async function startServer() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4173, "127.0.0.1", resolve);
  });
}

function isRepositoryPagesURL(url) {
  return url.origin === repositoryPagesURL.origin
    && url.pathname.startsWith(repositoryPagesURL.pathname);
}

async function routeRepositoryPages(context) {
  await context.route(/^https:\/\/motus-os\.github\.io\/work-ledger-site(?:\/.*)?$/, async (route) => {
    const requested = new URL(route.request().url());
    const relativePath = decodeURIComponent(
      requested.pathname.slice(repositoryPagesURL.pathname.length),
    ) || "index.html";
    const file = fileWithinSite(relativePath);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      await route.fulfill({ status: 404, body: fs.readFileSync(path.join(siteRoot, "404.html")) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: contentType(file),
      body: fs.readFileSync(file),
    });
  });
}

function routeName(route) {
  return route === "/" ? "index" : route.replace(/^\//, "").replace(/\.html$/, "");
}

let browser;
try {
  await startServer();
  browser = await chromium.launch({ headless: true });

  for (const profile of profiles) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      colorScheme: profile.colorScheme,
      reducedMotion: profile.reducedMotion,
    });
    await routeRepositoryPages(context);

    for (const route of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
      page.on("request", (request) => {
        const requested = new URL(request.url());
        if (requested.origin !== origin && !isRepositoryPagesURL(requested)) {
          errors.push(`network: ${request.url()}`);
        }
      });
      page.on("response", (response) => {
        if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
      });

      const response = await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
      if (!response?.ok()) errors.push(`navigation returned ${response?.status()}`);
      if (await page.locator("h1").count() !== 1) errors.push("page does not have exactly one h1");
      if ((await page.title()).trim() === "") errors.push("page title is empty");

      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      if (overflow.document > 1 || overflow.body > 1) {
        errors.push(`horizontal overflow: ${JSON.stringify(overflow)}`);
      }

      await page.addScriptTag({ content: axe.source });
      const axeResults = await page.evaluate(async () => globalThis.axe.run(document, {
        resultTypes: ["violations"],
      }));
      for (const violation of axeResults.violations) {
        errors.push(`axe ${violation.id}: ${violation.help} (${violation.nodes.length})`);
      }

      if (process.env.CAPTURE_SITE === "1") {
        const output = path.join(root, "artifacts", `${routeName(route)}-${profile.name}.png`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await page.screenshot({ path: output, fullPage: true });
      }

      await page.keyboard.press("Tab");
      const activeClass = await page.evaluate(() => document.activeElement?.className ?? "");
      if (activeClass !== "skip-link") errors.push("first keyboard focus is not the skip link");

      await page.close();
      if (errors.length > 0) {
        throw new Error(`${route} ${profile.name}\n${errors.join("\n")}`);
      }
    }
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await routeRepositoryPages(context);
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator('a[href="#how-it-works"]').first().click();
  if ((await page.evaluate(() => location.hash)) !== "#how-it-works") {
    throw new Error("How it works navigation did not resolve its anchor");
  }
  await context.close();

  const fallbackContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await routeRepositoryPages(fallbackContext);
  for (const route of ["/nested/final-review-miss", "/directory-style/"]) {
    const fallbackPage = await fallbackContext.newPage();
    const navigationURL = `${baseURL}${route}`;
    const errors = [];
    fallbackPage.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    fallbackPage.on("request", (request) => {
      const requested = new URL(request.url());
      if (requested.origin !== origin && !isRepositoryPagesURL(requested)) {
        errors.push(`network: ${request.url()}`);
      }
    });
    fallbackPage.on("response", (response) => {
      if (response.status() >= 400 && response.url() !== navigationURL) {
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
      }
    });

    const response = await fallbackPage.goto(navigationURL, { waitUntil: "networkidle" });
    if (response?.status() !== 404) errors.push(`missing-page navigation returned ${response?.status()}`);
    if ((await fallbackPage.locator("h1").innerText()) !== "That page is not in the ledger.") {
      errors.push("custom 404 content was not served");
    }
    const bodyBackground = await fallbackPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bodyBackground !== "rgb(247, 248, 250)") errors.push(`custom 404 stylesheet not applied: ${bodyBackground}`);
    const expectedLinks = [
      repositoryPagesURL.href,
      new URL("security.html", repositoryPagesURL).href,
      new URL("privacy.html", repositoryPagesURL).href,
    ];
    const actualLinks = await fallbackPage.locator('a.brand, a[href$="security.html"], a[href$="privacy.html"]')
      .evaluateAll((elements) => elements.map((element) => element.href));
    for (const expected of expectedLinks) {
      if (!actualLinks.includes(expected)) errors.push(`custom 404 missing stable link ${expected}`);
    }

    await fallbackPage.locator("a.button").click();
    await fallbackPage.waitForLoadState("networkidle");
    if (fallbackPage.url() !== repositoryPagesURL.href) {
      errors.push(`custom 404 home resolved to ${fallbackPage.url()}`);
    }
    if ((await fallbackPage.locator("h1").innerText()) !== "Keep a local record of the commands that did the work.") {
      errors.push("custom 404 home link did not load the site index");
    }
    await fallbackPage.close();
    if (errors.length > 0) throw new Error(`${route} custom 404\n${errors.join("\n")}`);
  }
  await fallbackContext.close();

  console.log(`PASS browser and accessibility checks (${pages.length * profiles.length} renders, 2 custom 404 fallbacks)`);
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
