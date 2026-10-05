import { expect, test } from "@playwright/test";

const diagnostics = new WeakMap<
  object,
  { consoleErrors: string[]; pageErrors: string[]; failedRequests: string[] }
>();
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WAAAAABJRU5ErkJggg==",
  "base64",
);

const photo = {
  id: "photo-1",
  state: "ready",
  width: 1200,
  height: 800,
  mimeType: "image/png",
  mediaUrl: "/api/v1/photos/photo-1/media",
  createdAt: "2026-08-10T00:00:00.000Z",
  readyAt: "2026-08-10T00:00:01.000Z",
  documentRevision: 1,
  aiWords: [
    {
      kind: "ai-word",
      word: "Cat",
      normalizedWord: "cat",
      confidence: 0.9,
      modelRunId: "run-1",
      documentRevision: 1,
    },
  ],
  humanTags: [
    {
      kind: "human-tag",
      id: "tag-1",
      name: "favorite",
      normalizedName: "favorite",
      createdAt: "2026-08-10T00:00:02.000Z",
    },
  ],
  attribution: {
    sourceUrl: "https://example.test/source/photo-1",
    licenseName: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    authorName: "Example Author",
    authorUrl: null,
  },
};

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  diagnostics.set(page, { consoleErrors, pageErrors, failedRequests });
  let humanTags = [...photo.humanTags];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) =>
    failedRequests.push(`${request.method()} ${request.url()}`),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/v1/readiness") {
      return json({
        version: "v1",
        status: "ready",
        environment: "ci",
        publicWritesEnabled: true,
        models: {
          vision: "vision",
          embedding: "embedding",
          vectorDimensions: 768,
          vectorMetric: "cosine",
        },
        checks: [],
      });
    }
    if (pathname === "/api/v1/photos" && request.method() === "GET") {
      return json({ version: "v1", items: [photo], nextCursor: null });
    }
    if (pathname === "/api/v1/photos/photo-1/media") {
      return route.fulfill({ status: 200, contentType: "image/png", body: pixel });
    }
    // PhotoCard fetches this eagerly on mount (#73's AI caption) and
    // RelatedPhotosPanel fetches it too (#72), sharing one request via
    // fetchPhotoDetail's cache — without a handler here every card render
    // hits the catch-all 500 below and fails every test's console-error guard.
    const detailMatch =
      request.method() === "GET" && pathname.match(/^\/api\/v1\/photos\/([^/]+)$/);
    if (detailMatch) {
      const photoId = detailMatch[1]!;
      return json({
        version: "v1",
        photo: {
          ...photo,
          id: photoId,
          humanTags: photoId === "photo-1" ? humanTags : [],
          byteSize: 10,
          sha256: "x",
          aiCaption: "A tabby cat on a windowsill",
          canonicalIndexedRevision: 1,
          reindexRequiredRevision: null,
        },
      });
    }
    const relatedMatch =
      request.method() === "GET" && pathname.match(/^\/api\/v1\/photos\/([^/]+)\/related$/);
    if (relatedMatch) {
      return json({
        version: "v1",
        photoId: relatedMatch[1]!,
        items: [],
        nextCursor: null,
        degraded: false,
        degradedReason: null,
      });
    }
    if (pathname === "/api/v1/photos" && request.method() === "POST") {
      return json(
        {
          version: "v1",
          operationId: "operation-1",
          photoId: "photo-2",
          state: "completed",
          retryable: false,
          errorCode: null,
          updatedAt: "2026-08-10T00:00:01.000Z",
        },
        202,
      );
    }
    if (pathname === "/api/v1/uploads/operation-1") {
      return json({
        version: "v1",
        operationId: "operation-1",
        photoId: "photo-2",
        state: "completed",
        photoState: "ready",
        retryable: false,
        errorCode: null,
        updatedAt: "2026-08-10T00:00:02.000Z",
      });
    }
    if (pathname === "/api/v1/human-tags/bulk") {
      const payload = request.postDataJSON() as {
        action: "attach" | "remove";
        humanTagNames: string[];
      };
      const name = payload.humanTagNames[0] ?? "";
      humanTags =
        payload.action === "attach"
          ? [
              ...humanTags.filter((tag) => tag.normalizedName !== name.toLowerCase()),
              {
                kind: "human-tag",
                id: `tag-${name}`,
                name,
                normalizedName: name.toLowerCase(),
                createdAt: "2026-08-10T00:00:03.000Z",
              },
            ]
          : humanTags.filter((tag) => tag.normalizedName !== name.toLowerCase());
      return json({
        version: "v1",
        results: [
          {
            photoId: "photo-1",
            status: "updated",
            documentRevision: 2,
            humanTags,
          },
        ],
      });
    }
    if (pathname === "/api/v1/search") {
      return json({
        version: "v1",
        query: "cat",
        nextCursor: null,
        degraded: true,
        degradedReason: "Vector provider unavailable",
        items: [
          { photo, reason: { tier: "exact_human_tag", normalizedTag: "cat" } },
          {
            photo: { ...photo, id: "photo-2" },
            reason: { tier: "exact_ai_word", normalizedWord: "cat", modelRunId: "run-1" },
          },
        ],
      });
    }
    return json(
      {
        version: "v1",
        error: { code: "unexpected_route", message: pathname, requestId: "test", retryable: false },
      },
      500,
    );
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await expect.poll(() => consoleErrors, { message: "unexpected console errors" }).toEqual([]);
  await expect.poll(() => pageErrors, { message: "unexpected page errors" }).toEqual([]);
});

test.afterEach(async ({ page }) => {
  const current = diagnostics.get(page);
  expect(current?.consoleErrors, "unexpected console errors").toEqual([]);
  expect(current?.pageErrors, "unexpected page errors").toEqual([]);
  expect(current?.failedRequests, "unexpected failed network requests").toEqual([]);
});

test("uploads through the multipart API and presents distinct provenance and search tiers", async ({
  page,
}) => {
  await expect(page.getByLabel("AI suggested words")).toContainText("AI · Cat");
  await expect(page.getByLabel("Human tags")).toContainText("Human · favorite");
  await expect(page.getByRole("link", { name: "Example Author" })).toHaveAttribute(
    "href",
    "https://example.test/source/photo-1",
  );
  await expect(page.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/",
  );
  await page.getByLabel("Choose photos").setInputFiles({
    name: "cat.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("photo"),
  });
  await expect(page.getByLabel("Upload status")).toContainText("cat.jpg — Ready");

  await page.getByLabel("Words or description").fill("cat");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "Human tag", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI word", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Related", exact: true })).toBeVisible();
  await expect(page.getByText(/Related results are incomplete/)).toBeVisible();
});

test("bulk-attaches and removes only human tags from selected photos", async ({ page }) => {
  await expect(page.getByLabel("AI suggested words").getByRole("button")).toHaveCount(0);
  await page.getByLabel("Select photo photo-1").check();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByLabel("Human tag", { exact: true }).fill("reviewed");
  await page.getByRole("button", { name: "Attach human tag" }).click();
  await expect(page.getByLabel("Human tags")).toContainText("Human · reviewed");
  await expect(page.getByLabel("AI suggested words")).toContainText("AI · Cat");

  await page.getByRole("button", { name: "Remove human tag", exact: true }).click();
  await expect(page.getByLabel("Human tags")).not.toContainText("Human · reviewed");
  await expect(page.getByLabel("Human tags")).toContainText("Human · favorite");
});

test("keeps the responsive library within its viewport", async ({ page }) => {
  const metrics = await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      document: {
        documentElement: { scrollWidth: number };
        querySelector(selector: string): {
          getBoundingClientRect(): { width: number; height: number };
          getAttribute(name: string): string | null;
        } | null;
      };
      innerWidth: number;
      getComputedStyle(element: object): { objectFit: string };
    };
    const searchButton = browser.document.querySelector('button[type="submit"]');
    const image = browser.document.querySelector("img");
    return {
      documentWidth: browser.document.documentElement.scrollWidth,
      viewportWidth: browser.innerWidth,
      cardWidth: browser.document.querySelector("article")?.getBoundingClientRect().width ?? 0,
      searchTargetHeight: searchButton?.getBoundingClientRect().height ?? 0,
      imageWidth: image?.getAttribute("width"),
      imageHeight: image?.getAttribute("height"),
      imageObjectFit: image ? browser.getComputedStyle(image).objectFit : "",
      gridLayout: browser.document
        .querySelector('[data-layout="bounded-responsive-grid"]')
        ?.getAttribute("data-layout"),
    };
  });
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.cardWidth).toBeGreaterThan(0);
  expect(metrics.cardWidth).toBeLessThanOrEqual(420);
  expect(metrics.searchTargetHeight).toBeGreaterThanOrEqual(44);
  expect(metrics.imageWidth).toBe("1200");
  expect(metrics.imageHeight).toBe("800");
  expect(metrics.imageObjectFit).toBe("cover");
  expect(metrics.gridLayout).toBe("bounded-responsive-grid");
  await page.getByRole("button", { name: "Search" }).focus();
  await expect(page.getByRole("button", { name: "Search" })).toHaveCSS("outline-style", "solid");
});

test("keeps search usable while displaying server/readiness failure states", async ({ page }) => {
  await page.unroute("**/api/v1/**");
  await page.route("**/api/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = JSON.stringify({
      version: "v1",
      error: {
        code: "temporarily_unavailable",
        message: pathname,
        requestId: "test",
        retryable: true,
      },
    });
    await route.fulfill({
      status: pathname === "/api/v1/readiness" ? 503 : 429,
      contentType: "application/json",
      body,
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText(/Gallery is read-only/)).toBeVisible();
  await expect(page.getByText(/Could not load the library/)).toBeVisible();
  await expect(page.getByLabel("Choose photos")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Search" })).toBeEnabled();
  const current = diagnostics.get(page);
  expect(current?.consoleErrors).toEqual([
    "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    "Failed to load resource: the server responded with a status of 429 (Too Many Requests)",
  ]);
  current?.consoleErrors.splice(0);
});

test("keeps the related panel focused through a photo chain and restores its original opener", async ({
  page,
}) => {
  const requestedPhotos: string[] = [];
  await page.route("**/api/v1/photos/*/related?*", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[4]!;
    requestedPhotos.push(id);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: "v1",
        photoId: id,
        items:
          id === "photo-1"
            ? [
                {
                  photo: { ...photo, id: "photo-2", humanTags: [] },
                  reason: { tier: "semantic", score: 0.87 },
                },
              ]
            : [],
        nextCursor: null,
        degraded: false,
        degradedReason: null,
      }),
    });
  });
  const opener = page.getByRole("button", {
    name: "Show photos related to photo photo-1 by AI description",
  });
  await opener.focus();
  await opener.press("Enter");
  const panel = page.getByRole("complementary", { name: "Related by AI description" });
  await expect(panel).toBeFocused();
  const nextPhoto = panel.getByRole("button", { name: /^Show photos related to / });
  await expect(nextPhoto).toHaveCount(1);
  await nextPhoto.focus();
  await nextPhoto.press("Enter");
  await expect.poll(() => requestedPhotos).toEqual(["photo-1", "photo-2"]);
  await expect(panel).toHaveAttribute("data-related-state", "ready");
  await expect(panel).toBeFocused();
  await expect(nextPhoto).toHaveCount(0);
  await panel.getByRole("button", { name: "Close the related photos panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.press("Enter");
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("button", { name: /^Show photos related to / })).toHaveCount(1);
  await panel.getByRole("button", { name: "Close the related photos panel" }).click();
  await expect(opener).toBeFocused();
});

test("accepts a dropped image through multipart upload and reaches its ready state", async ({
  page,
}) => {
  const dataTransfer = await page.evaluateHandle(
    (bytes) => {
      const browser = globalThis as typeof globalThis & {
        DataTransfer: new () => { items: { add(file: File): void } };
      };
      const transfer = new browser.DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "dropped-cat.png", { type: "image/png" }),
      );
      return transfer;
    },
    [...pixel],
  );
  const dropZone = page.locator("label").filter({ has: page.getByLabel("Choose photos") });
  const uploaded = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/v1/photos" && request.method() === "POST",
  );
  await dropZone.dispatchEvent("dragenter", { dataTransfer });
  await dropZone.dispatchEvent("dragover", { dataTransfer });
  await dropZone.dispatchEvent("drop", { dataTransfer });
  const request = await uploaded;
  expect(request.headers()["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  expect(request.postDataBuffer()?.toString()).toContain('filename="dropped-cat.png"');
  await expect(page.getByLabel("Upload status")).toContainText("dropped-cat.png — Ready");
  await expect(page.getByLabel("Upload status")).toContainText("Added to the public library");
  await dataTransfer.dispose();
});

test("retains selection across search and updates keyed cards after tag mutations", async ({
  page,
}) => {
  await page.getByLabel("Select photo photo-1").check();
  await page.getByLabel("Words or description").fill("cat");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Human tag", exact: true })).toBeVisible();
  await expect(page.getByLabel("Select photo photo-1")).toBeChecked();
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.getByRole("textbox", { name: "Human tag", exact: true }).fill("reviewed");
  await page.getByRole("button", { name: "Attach human tag", exact: true }).click();
  const firstCard = page
    .locator("article")
    .filter({ has: page.getByLabel("Select photo photo-1") });
  await expect(firstCard.getByLabel("Human tags")).toContainText("Human · reviewed");
  await expect(page.getByLabel("Select photo photo-1")).toBeChecked();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Latest photos" })).toBeVisible();
  await expect(page.getByLabel("Select photo photo-1")).toBeChecked();
  await expect(page.getByLabel("Human tags")).toContainText("Human · reviewed");
  await page.getByRole("button", { name: "Remove human tag", exact: true }).click();
  await expect(page.getByLabel("Human tags")).not.toContainText("Human · reviewed");
  await expect(page.getByLabel("Select photo photo-1")).toBeChecked();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.getByLabel("Select photo photo-1")).not.toBeChecked();
  await expect(page.getByText("0 selected")).toBeVisible();
});
