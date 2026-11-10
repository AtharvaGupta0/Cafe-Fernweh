/**
 * Browser-level end-to-end checks for the admin dashboard and embeddable widget.
 *
 * Playwright is intentionally not a project dependency: this script expects a
 * Playwright installation supplied through PLAYWRIGHT_MODULE, e.g.
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   E2E_ADMIN_TOKEN=... node tests/browser/e2e.mjs
 *
 * It starts a tiny static server for the fixtures on :5199 and expects the
 * Worker dev server (with demo AI provider, SEED_DEMO_DATA=true and CORS
 * allowing http://127.0.0.1:5199) on :8787.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";
const HOST = process.env.HOST_URL || "http://127.0.0.1:5199";
const TOKEN = process.env.E2E_ADMIN_TOKEN || "";
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

let failures = 0;
function check(condition, label, detail = "") {
  if (condition) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForHttp(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

if (!TOKEN) {
  console.error("E2E_ADMIN_TOKEN is required");
  process.exit(2);
}

const staticServer = spawn(
  "python3",
  ["-m", "http.server", "5199", "--bind", "127.0.0.1", "--directory", FIXTURES],
  { stdio: "ignore" }
);

const browser = await chromium.launch({ headless: true });

try {
  await waitForHttp(`${HOST}/widget-host.html`);

  // ---------------------------------------------------------------- admin UI
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const adminPage = await adminContext.newPage();
  const consoleErrors = [];
  adminPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await adminPage.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
  await adminPage.getByPlaceholder("Enter admin token").waitFor({ timeout: 15_000 });
  check(true, "admin dashboard loads at /admin/");
  check(
    await adminPage.getByText("Café Fernweh Admin").first().isVisible(),
    "admin login screen renders"
  );

  const preLoginCookies = await adminContext.cookies();
  check(
    !preLoginCookies.some((cookie) => cookie.name === "cafe_session"),
    "no session cookie before login"
  );

  await adminPage.getByPlaceholder("Enter admin token").fill(TOKEN);
  await adminPage.getByText("Menu Management").waitFor({ timeout: 15_000 });
  check(true, "login succeeds and dashboard loads");

  const cookies = await adminContext.cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === "cafe_session");
  const csrfCookie = cookies.find((cookie) => cookie.name === "csrf_token");
  check(Boolean(sessionCookie), "session cookie is set");
  check(sessionCookie?.httpOnly === true, "session cookie is HttpOnly");
  check(sessionCookie?.sameSite === "Lax", "session cookie is SameSite=Lax");
  check(Boolean(csrfCookie), "CSRF cookie is set");
  check(csrfCookie?.httpOnly === false, "CSRF cookie is JS-readable for double submit");

  const rowCount = await adminPage.locator("table tr").count();
  check(rowCount >= 20, "authenticated dashboard loads menu rows", `rows=${rowCount}`);

  const badCsrfStatus = await adminPage.evaluate(async () => {
    const response = await fetch("/admin/menu", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "not-the-token" },
      body: JSON.stringify({
        category_id: 1,
        name: "CSRF should reject this",
        description: "test",
        price_cents: 1,
      }),
    });
    return response.status;
  });
  check(badCsrfStatus === 403, "state-changing API rejects an invalid CSRF token", `status=${badCsrfStatus}`);

  const goodCsrfStatus = await adminPage.evaluate(async () => {
    const csrf = document.cookie
      .split("; ")
      .find((part) => part.startsWith("csrf_token="))
      ?.split("=")[1];
    const response = await fetch("/admin/menu", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf || "" },
      body: JSON.stringify({
        category_id: 1,
        name: `Browser Test ${Date.now()}`,
        description: "created by the browser test",
        price_cents: 123,
      }),
    });
    return response.status;
  });
  check(goodCsrfStatus === 200, "state-changing API accepts the session-bound CSRF token", `status=${goodCsrfStatus}`);

  await adminPage.reload({ waitUntil: "domcontentloaded" });
  await adminPage.getByText("Menu Management").waitFor({ timeout: 15_000 });
  check(true, "dashboard stays authenticated across a reload");

  const scriptSources = await adminPage.evaluate(() =>
    Array.from(document.scripts)
      .map((script) => script.src)
      .filter(Boolean)
  );
  let bundlesContainSecrets = false;
  for (const source of scriptSources) {
    const response = await adminPage.request.get(source);
    const body = await response.text();
    if (/AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY|GEMINI_API_KEY=/.test(body)) {
      bundlesContainSecrets = true;
    }
  }
  check(!bundlesContainSecrets, "admin JS bundles contain no Gemini credentials");

  await adminPage.getByRole("button", { name: "Sign out" }).click();
  await adminPage.getByPlaceholder("Enter admin token").waitFor({ timeout: 10_000 });
  const afterLogoutStatus = await adminPage.evaluate(async () => {
    const response = await fetch("/admin/menu");
    return response.status;
  });
  check(afterLogoutStatus === 401, "logout invalidates the session", `status=${afterLogoutStatus}`);

  const afterLogoutCookies = await adminContext.cookies();
  check(
    !afterLogoutCookies.some((cookie) => cookie.name === "cafe_session" && cookie.value),
    "logout clears the session cookie"
  );

  const unexpectedConsole = consoleErrors.filter(
    (line) => !line.includes("favicon") && !line.includes("Failed to load resource")
  );
  check(unexpectedConsole.length === 0, "admin page has no unexpected console errors", unexpectedConsole.join(" | "));

  await adminContext.close();

  // -------------------------------------------------------------- widget UI
  const widgetContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const widgetPage = await widgetContext.newPage();
  await widgetPage.goto(`${HOST}/widget-host.html`, { waitUntil: "domcontentloaded" });
  await widgetPage.locator("#launcher").waitFor({ timeout: 10_000 });

  const defined = await widgetPage.evaluate(async () => {
    await customElements.whenDefined("cafe-chatbot");
    const element = document.querySelector("cafe-chatbot");
    return Boolean(element && element.shadowRoot);
  });
  check(defined, "widget script registers <cafe-chatbot> with a shadow root");

  const hostProbeColor = await widgetPage
    .locator("#host-probe")
    .evaluate((element) => getComputedStyle(element).color);
  check(hostProbeColor === "rgb(255, 0, 0)", "host page CSS still applies to the host", hostProbeColor);

  const widgetBackground = await widgetPage
    .locator("#wrap")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  check(
    widgetBackground !== "rgb(255, 255, 0)",
    "host page CSS does not leak into the widget shadow DOM",
    widgetBackground
  );

  check(await widgetPage.locator("#launcher").isVisible(), "launcher is visible on load");
  check(!(await widgetPage.locator("#wrap").isVisible()), "chat panel is closed on load");

  await widgetPage.locator("#launcher").click();
  check(await widgetPage.locator("#wrap").isVisible(), "launcher opens the chat panel");
  const inputFocused = await widgetPage.evaluate(() => {
    const root = document.querySelector("cafe-chatbot")?.shadowRoot;
    return root?.activeElement?.id === "input";
  });
  check(inputFocused, "opening the panel focuses the message input");

  const chatResponse = widgetPage.waitForResponse(
    (response) => response.url().endsWith("/chat") && response.request().method() === "POST"
  );
  await widgetPage.locator("#input").fill("What is the cheapest cold drink?");
  await widgetPage.locator("#input").press("Enter");
  const response = await chatResponse;
  check(response.status() === 200, "widget reaches the chat API", `status=${response.status()}`);
  await widgetPage.locator(".msg.assistant").first().waitFor({ timeout: 20_000 });
  const replyText = (await widgetPage.locator(".msg.assistant").first().textContent()) ?? "";
  check(replyText.trim().length > 0, "assistant reply renders in the panel");

  await widgetPage
    .locator("#input")
    .fill('<img src=x onerror="window.__widgetXss = true">');
  await widgetPage.locator("#input").press("Enter");
  await widgetPage.locator(".msg.customer").nth(1).waitFor({ timeout: 10_000 });
  const xssState = await widgetPage.evaluate(() => {
    const root = document.querySelector("cafe-chatbot")?.shadowRoot;
    return {
      flag: window.__widgetXss === true,
      images: root?.querySelectorAll("img").length ?? -1,
    };
  });
  check(!xssState.flag && xssState.images === 0, "message rendering is XSS-safe", JSON.stringify(xssState));

  await widgetPage.locator("#close").click();
  check(!(await widgetPage.locator("#wrap").isVisible()), "close button hides the chat panel");
  check(await widgetPage.locator("#launcher").isVisible(), "launcher reappears after closing");
  const focusReturned = await widgetPage.evaluate(() => {
    const root = document.querySelector("cafe-chatbot")?.shadowRoot;
    return root?.activeElement?.id === "launcher";
  });
  check(focusReturned, "closing returns focus to the launcher");

  await widgetPage.keyboard.press("Enter");
  check(await widgetPage.locator("#wrap").isVisible(), "keyboard activation opens the panel");
  await widgetPage.keyboard.press("Escape");
  check(!(await widgetPage.locator("#wrap").isVisible()), "Escape closes the panel");

  const widgetScript = await (await widgetPage.request.get(`${BASE}/widget/cafe-chatbot-widget.iife.js`)).text();
  check(!/AIza[0-9A-Za-z_-]{20,}|GEMINI_API_KEY/.test(widgetScript), "widget bundle contains no API credentials");

  await widgetContext.close();

  // ------------------------------------------------------------- mobile size
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${HOST}/widget-host.html`, { waitUntil: "domcontentloaded" });
  await mobilePage.locator("#launcher").waitFor({ timeout: 10_000 });
  await mobilePage.locator("#launcher").click();
  const box = await mobilePage.locator("#wrap").boundingBox();
  const fits =
    Boolean(box) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= 390 &&
    box.y + box.height <= 844;
  check(fits, "mobile layout fits a 390x844 viewport", JSON.stringify(box));
  await mobileContext.close();

  // ----------------------------------------------------------- error handling
  const offlineContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const offlinePage = await offlineContext.newPage();
  await offlinePage.goto(`${HOST}/widget-host-offline.html`, { waitUntil: "domcontentloaded" });
  await offlinePage.locator("#launcher").waitFor({ timeout: 10_000 });
  await offlinePage.locator("#launcher").click();
  await offlinePage.locator("#input").fill("hello");
  await offlinePage.locator("#input").press("Enter");
  await offlinePage.locator(".msg.error").waitFor({ timeout: 15_000 });
  const errorText = (await offlinePage.locator(".msg.error").first().textContent()) ?? "";
  check(/couldn't reach/i.test(errorText), "widget shows a friendly error when the API is unreachable");
  await offlineContext.close();
} catch (error) {
  failures += 1;
  console.error(`FAIL  browser suite threw — ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await browser.close();
  staticServer.kill("SIGTERM");
}

if (failures > 0) {
  console.error(`\n${failures} browser check(s) failed`);
  process.exit(1);
}
console.log("\nAll browser checks passed");
