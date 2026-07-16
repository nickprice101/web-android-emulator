import path from "node:path";
import { test, expect } from "@playwright/test";

test("debug log filter exposes modes and AND/OR syntax help", async ({ page }, testInfo) => {
  const logRequests = [];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/logcat") {
      logRequests.push(url);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, entries: ["ActivityManager: fatal crash"] }),
      });
      return;
    }
    if (url.pathname === "/api/health") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    if (url.pathname === "/api/device-info") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          screen: { width: 1080, height: 2340 },
          device_profile: { id: "phone", label: "Phone" },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Display unavailable in UI test" }),
    });
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const filterInput = page.getByRole("textbox", { name: "Log text filter", exact: true });
  await filterInput.scrollIntoViewIfNeeded();
  await filterInput.fill("ActivityManager AND crash OR timeout");
  await page.getByRole("button", { name: "Exclude" }).click();

  await expect.poll(() => logRequests.some((url) => (
    url.searchParams.get("filter") === "ActivityManager AND crash OR timeout"
      && url.searchParams.get("filter_mode") === "exclude"
  ))).toBeTruthy();

  await expect(page.getByRole("button", { name: "Exclude" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Filter syntax information" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("uppercase AND");
  await expect(page.getByRole("tooltip")).toContainText("uppercase OR");

  if (process.env.CAPTURE_UI_PATH) {
    await page.screenshot({
      path: path.resolve(testInfo.config.rootDir, process.env.CAPTURE_UI_PATH),
      fullPage: false,
    });
  }
});
