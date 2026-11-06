import { expect, test } from "@playwright/test";

test("the browser can install the app shell and only caches static resources", async ({
  page,
}) => {
  await page.goto("/");
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/manifest.webmanifest");
    return response.json();
  });
  expect(manifest.name).toBe("Tank Arena");
  expect(manifest.display).toBe("standalone");
  expect(
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.active?.scriptURL.endsWith("/sw.js") ?? false;
    }),
  ).toBe(true);

  const cachedApiResponse = await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      if (await cache.match("/api/rooms")) return true;
    }
    return false;
  });
  expect(cachedApiResponse).toBe(false);
});
