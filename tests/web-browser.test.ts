/**
 * A smoke test of the web host in a real browser: build carver-street, open it from disk, start a new game offline,
 * play a few keys and come back to it. Skips itself where no Chromium is installed (PLAYWRIGHT_BROWSERS_PATH, or
 * /opt/pw-browsers); `ONEBLOCK_SCREENSHOT=<file.png>` saves a picture of the play screen.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWeb } from "../tools/web.js";
import { EXAMPLE } from "./helpers.js";

function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)
    .filter((n) => /^chromium-\d+$/.test(n))
    .sort()
    .reverse()) {
    const exe = join(root, d, "chrome-linux", "chrome");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const executablePath = findChromium();

/** The log's paragraphs. */
const logLength = (page: Page) => page.locator(".log .lines p").count();

/** Whether the scene canvas has anything but one colour on it. */
const sceneDrawn = (page: Page) =>
  page.locator(".scene canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 4; i < d.length; i += 4) {
      if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) return true;
    }
    return false;
  });

describe.skipIf(!executablePath)("the web host in a browser", () => {
  const out = mkdtempSync(join(tmpdir(), "oneblock-browser-"));
  let browser: Browser;
  beforeAll(async () => {
    await buildWeb([EXAMPLE], out);
    browser = await chromium.launch({ executablePath: executablePath! });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    rmSync(out, { recursive: true, force: true });
  });

  it("starts offline, plays from the keyboard and resumes after a reload", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(pathToFileURL(join(out, "carver-street", "index.html")).href);

    await page.getByLabel("Offline").check();
    await page.getByRole("button", { name: "New game" }).click();
    // The introduction, then a preset character.
    await page.getByRole("dialog", { name: "41 Carver Street" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Who are you?" }).waitFor();
    await page.keyboard.press("1");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await expect.poll(() => page.locator(".side").textContent()).toMatch(/Day 1/);

    const before = await logLength(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("l");
    await expect.poll(() => page.locator(".log .prompt").textContent()).toMatch(/Look at what/);
    await page.keyboard.press("Enter");
    await expect.poll(() => logLength(page)).toBeGreaterThan(before);
    await expect.poll(() => sceneDrawn(page)).toBe(true);
    if (process.env.ONEBLOCK_SCREENSHOT) await page.screenshot({ path: process.env.ONEBLOCK_SCREENSHOT });

    await page.reload();
    await page.getByLabel("Offline").check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".game").waitFor();
    await expect.poll(() => page.locator(".log").textContent()).toMatch(/Resumed/);
    expect(errors).toEqual([]);
  }, 60_000);
});
