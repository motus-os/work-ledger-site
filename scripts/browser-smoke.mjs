import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import axe from "axe-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:4173";
const baseURL = `${origin}/site`;
const pages = ["/", "/security.html", "/privacy.html", "/404.html"];
const profiles = [
  { name: "desktop-light", viewport: { width: 1440, height: 1000 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "desktop-dark-preference", viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "tablet-light", viewport: { width: 768, height: 1024 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "mobile-light", viewport: { width: 390, height: 844 }, colorScheme: "light", reducedMotion: "no-preference" },
  { name: "mobile-dark-preference", viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" },
  { name: "narrow-light", viewport: { width: 320, height: 700 }, colorScheme: "light", reducedMotion: "no-preference" },
];

const server = spawn("python3", ["-m", "http.server", "4173", "--bind", "127.0.0.1", "--directory", "."], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
});
let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseURL);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local server did not start\n${serverErrors}`);
}

function routeName(route) {
  return route === "/" ? "index" : route.replace(/^\//, "").replace(/\.html$/, "");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  for (const profile of profiles) {
    const context = await browser.newContext({
      viewport: profile.viewport,
      colorScheme: profile.colorScheme,
      reducedMotion: profile.reducedMotion,
    });

    for (const route of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== origin) errors.push(`network: ${request.url()}`);
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
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.locator('a[href="#how-it-works"]').first().click();
  if ((await page.evaluate(() => location.hash)) !== "#how-it-works") {
    throw new Error("How it works navigation did not resolve its anchor");
  }
  await context.close();

  console.log(`PASS browser and accessibility checks (${pages.length * profiles.length} renders)`);
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else {
      server.once("exit", resolve);
      setTimeout(resolve, 2_000);
    }
  });
}
