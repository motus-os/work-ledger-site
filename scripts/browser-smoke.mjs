import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";
import axe from "axe-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(root, "site");
const productionURL = new URL("https://www.motussupra.com/");
const pages = ["/", "/security.html", "/privacy.html", "/404.html"];
const chromiumProfiles = [
  { name: "280-light", viewport: { width: 280, height: 700 } },
  { name: "320-light", viewport: { width: 320, height: 700 } },
  { name: "360-light", viewport: { width: 360, height: 800 } },
  { name: "390-light", viewport: { width: 390, height: 844 } },
  { name: "412-dark-reduced", viewport: { width: 412, height: 915 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "680-light", viewport: { width: 680, height: 800 } },
  { name: "768-light", viewport: { width: 768, height: 1024 } },
  { name: "940-light", viewport: { width: 940, height: 700 } },
  { name: "999-light", viewport: { width: 999, height: 800 } },
  { name: "1000-light", viewport: { width: 1000, height: 800 } },
  { name: "1001-light", viewport: { width: 1001, height: 800 } },
  { name: "1024-light", viewport: { width: 1024, height: 768 } },
  { name: "1280-light", viewport: { width: 1280, height: 900 } },
  { name: "1440-light", viewport: { width: 1440, height: 1000 } },
  { name: "1920-dark-reduced", viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "2560-light", viewport: { width: 2560, height: 1440 } },
];
const secondaryProfiles = [
  { name: "390-light", viewport: { width: 390, height: 844 } },
  { name: "1000-light", viewport: { width: 1000, height: 800 } },
  { name: "1440-dark-reduced", viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" },
];
const browserSpecs = process.env.BROWSER_SET === "all"
  ? [
      { name: "chromium", type: chromium, profiles: chromiumProfiles },
      { name: "firefox", type: firefox, profiles: secondaryProfiles },
      { name: "webkit", type: webkit, profiles: secondaryProfiles },
    ]
  : [{ name: "chromium", type: chromium, profiles: chromiumProfiles }];

let origin = "";
let baseURL = "";

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
  const requested = new URL(request.url ?? "/", origin || "http://127.0.0.1");
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
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("site test server did not expose a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  baseURL = `${origin}/site`;
}

function isProductionURL(url) {
  return url.origin === productionURL.origin
    && url.pathname.startsWith(productionURL.pathname);
}

async function routeProductionSite(context) {
  await context.route(/^https:\/\/www\.motussupra\.com(?:\/.*)?$/, async (route) => {
    const requested = new URL(route.request().url());
    const relativePath = decodeURIComponent(
      requested.pathname.slice(productionURL.pathname.length),
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

function captureName(browserName, route, profileName) {
  return `${routeName(route)}-${browserName}-${profileName}.png`;
}

async function inspectPage(browserName, browser, profile, route) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    colorScheme: profile.colorScheme ?? "light",
    reducedMotion: profile.reducedMotion ?? "no-preference",
  });
  await routeProductionSite(context);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("request", (request) => {
    const requested = new URL(request.url());
    if (requested.origin !== origin && !isProductionURL(requested)) {
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

  if (route === "/") {
    const codeOverflow = await page.locator("pre").evaluateAll((elements) =>
      elements.map((element) => element.scrollWidth - element.clientWidth),
    );
    const overflowingCode = codeOverflow.filter((amount) => amount > 1);
    if (overflowingCode.length > 0) {
      errors.push(`code examples require horizontal scrolling: ${overflowingCode.join(", ")}px`);
    }

    await page.locator("a.button").focus();
    const focusStyle = await page.locator("a.button").evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth };
    });
    if (focusStyle.color !== "rgb(36, 86, 230)" || focusStyle.style !== "solid" || parseFloat(focusStyle.width) < 3) {
      errors.push(`button focus indicator is not the reviewed high-contrast outline: ${JSON.stringify(focusStyle)}`);
    }

    if (profile.viewport.width <= 680) {
      const installVisible = await page.locator('.site-nav a[href="#install"]').isVisible();
      const githubVisible = await page.locator('.site-nav a[href^="https://github.com/"]').isVisible();
      if (!installVisible || !githubVisible) errors.push("mobile navigation must show Install and GitHub");
    }
  }

  if (route === "/404.html" && profile.viewport.width <= 680) {
    const footerGap = await page.evaluate(() => {
      const footer = document.querySelector("footer");
      if (!footer) return Number.POSITIVE_INFINITY;
      return Math.abs(document.body.scrollHeight - (footer.getBoundingClientRect().bottom + window.scrollY));
    });
    if (footerGap > 1) errors.push(`mobile 404 footer leaves ${footerGap}px after the page content`);
  }

  await page.addScriptTag({ content: axe.source });
  const axeResults = await page.evaluate(async () => globalThis.axe.run(document, {
    resultTypes: ["violations"],
  }));
  for (const violation of axeResults.violations) {
    errors.push(`axe ${violation.id}: ${violation.help} (${violation.nodes.length})`);
  }

  if (process.env.CAPTURE_SITE === "1") {
    const output = path.join(root, "artifacts", captureName(browserName, route, profile.name));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await page.screenshot({ path: output, fullPage: true });
  }

  await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
  if (browserName === "chromium") {
    await page.keyboard.press("Tab");
  } else {
    await page.locator(".skip-link").focus();
  }
  const activeClass = await page.evaluate(() => document.activeElement?.className ?? "");
  if (activeClass !== "skip-link") errors.push("first keyboard focus is not the skip link");

  await context.close();
  if (errors.length > 0) {
    throw new Error(`${browserName} ${route} ${profile.name}\n${errors.join("\n")}`);
  }
}

async function inspectTextSpacing(browser) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
    const context = await browser.newContext({ viewport });
    await routeProductionSite(context);
    const page = await context.newPage();
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.addStyleTag({
      content: "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}",
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await context.close();
    if (overflow > 1) throw new Error(`text-spacing check overflowed by ${overflow}px at ${viewport.width}px`);
  }
}

async function inspectNavigationAndFallbacks(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await routeProductionSite(context);
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator('a[href="#example"]').first().click();
  if ((await page.evaluate(() => location.hash)) !== "#example") {
    throw new Error("Example navigation did not resolve its anchor");
  }
  await page.locator('a[href="#install"]').first().click();
  if ((await page.evaluate(() => location.hash)) !== "#install") {
    throw new Error("Install navigation did not resolve its anchor");
  }
  await context.close();

  const fallbackContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await routeProductionSite(fallbackContext);
  for (const route of ["/nested/final-review-miss", "/directory-style/"]) {
    const fallbackPage = await fallbackContext.newPage();
    const navigationURL = `${baseURL}${route}`;
    const errors = [];
    fallbackPage.on("pageerror", (error) => errors.push(`page: ${error.message}`));
    fallbackPage.on("request", (request) => {
      const requested = new URL(request.url());
      if (requested.origin !== origin && !isProductionURL(requested)) {
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
    if ((await fallbackPage.locator("h1").innerText()) !== "Page not found.") {
      errors.push("custom 404 content was not served");
    }
    const bodyBackground = await fallbackPage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bodyBackground !== "rgb(247, 248, 250)") errors.push(`custom 404 stylesheet not applied: ${bodyBackground}`);
    const expectedLinks = [
      productionURL.href,
      new URL("security.html", productionURL).href,
      new URL("privacy.html", productionURL).href,
    ];
    const actualLinks = await fallbackPage.locator('a.brand, a[href$="security.html"], a[href$="privacy.html"]')
      .evaluateAll((elements) => elements.map((element) => element.href));
    for (const expected of expectedLinks) {
      if (!actualLinks.includes(expected)) errors.push(`custom 404 missing stable link ${expected}`);
    }

    await fallbackPage.locator("a.button").click();
    await fallbackPage.waitForLoadState("networkidle");
    if (fallbackPage.url() !== productionURL.href) {
      errors.push(`custom 404 home resolved to ${fallbackPage.url()}`);
    }
    if ((await fallbackPage.locator("h1").innerText()) !== "Use earlier findings when similar work comes back.") {
      errors.push("custom 404 home link did not load the site index");
    }
    await fallbackPage.close();
    if (errors.length > 0) throw new Error(`${route} custom 404\n${errors.join("\n")}`);
  }
  await fallbackContext.close();
}

const browsers = [];
let renderCount = 0;
try {
  await startServer();
  for (const spec of browserSpecs) {
    const browser = await spec.type.launch({ headless: true });
    browsers.push(browser);
    for (const profile of spec.profiles) {
      for (const route of pages) {
        await inspectPage(spec.name, browser, profile, route);
        renderCount += 1;
      }
    }
    if (spec.name === "chromium") {
      await inspectTextSpacing(browser);
      await inspectNavigationAndFallbacks(browser);
    }
  }
  console.log(`PASS browser and accessibility checks (${renderCount} renders across ${browserSpecs.length} browser engine(s), 2 text-spacing views, 2 custom 404 fallbacks)`);
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
