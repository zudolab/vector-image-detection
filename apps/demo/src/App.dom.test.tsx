import { createIslandTest, type IslandTest } from "@takazudo/zfb/zudo-react/testing";
import { intersectionObservers, intersectObservedElements } from "../tests/dom-setup";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ApiClientError, type PhotoLibraryClient } from "./lib/photo-library-client";
import type { PhotoSummary } from "./worker/contracts/domain";

const islands: IslandTest[] = [];
async function renderApp(client: PhotoLibraryClient) {
  function TestApp() {
    return <App client={client} />;
  }
  const island = createIslandTest(TestApp, {}, { document });
  islands.push(island);
  expect(island.hydrate()).not.toBeNull();
  await island.flush();
  expect(island.diagnostics).toEqual([]);
  return island;
}
afterEach(() => {
  for (const island of islands.splice(0)) island.dispose();
});

const photo = (id = "photo-1"): PhotoSummary => ({
  id,
  state: "ready",
  width: 1200,
  height: 800,
  mimeType: "image/jpeg",
  mediaUrl: `/api/v1/photos/${id}/media`,
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
    sourceUrl: "https://example.com/photo",
    licenseName: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    authorName: "Example Author",
    authorUrl: null,
  },
});

function fakeClient(overrides: Partial<PhotoLibraryClient> = {}): PhotoLibraryClient {
  const item = photo();
  const client: PhotoLibraryClient = {
    readiness: async () => ({
      version: "v1",
      status: "ready",
      environment: "local",
      publicWritesEnabled: true,
      models: {
        vision: "vision",
        embedding: "embedding",
        vectorDimensions: 768,
        vectorMetric: "cosine",
      },
      checks: [],
    }),
    listPhotos: async () => ({ version: "v1", items: [item], nextCursor: null }),
    uploadPhoto: async () => ({
      version: "v1",
      operationId: "operation-1",
      photoId: "photo-2",
      state: "completed",
      retryable: false,
      errorCode: null,
      updatedAt: "2026-08-10T00:00:01.000Z",
    }),
    uploadStatus: async () => ({
      version: "v1",
      operationId: "operation-1",
      photoId: "photo-2",
      state: "completed",
      photoState: "ready",
      retryable: false,
      errorCode: null,
      updatedAt: "2026-08-10T00:00:02.000Z",
    }),
    getPhoto: async () => ({
      version: "v1",
      photo: {
        ...photo("photo-2"),
        byteSize: 10,
        sha256: "x",
        aiCaption: "cat",
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    }),
    mutateTags: async (request) => ({
      version: "v1",
      results: request.photoIds.map((photoId) => ({
        photoId,
        status: "updated",
        documentRevision: 2,
        humanTags:
          request.action === "attach"
            ? [
                {
                  kind: "human-tag" as const,
                  id: "tag-2",
                  name: request.humanTagNames[0]!,
                  normalizedName: request.humanTagNames[0]!,
                  createdAt: "2026-08-10T00:00:03.000Z",
                },
              ]
            : [],
      })),
    }),
    search: async () => ({
      version: "v1",
      query: "cat",
      items: [],
      nextCursor: null,
      degraded: false,
      degradedReason: null,
    }),
    relatedPhotos: async (photoId) => ({
      version: "v1",
      photoId,
      items: [],
      nextCursor: null,
      degraded: false,
      degradedReason: null,
    }),
  };
  return Object.assign(client, overrides);
}

beforeEach(() => {
  Object.defineProperty(File.prototype, "arrayBuffer", {
    configurable: true,
    value: async () => new ArrayBuffer(1),
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { subtle: { digest: async () => new Uint8Array(32).buffer } },
  });
});

describe("public photo library", () => {
  it("keeps the native multi-file input baseline and gives local validation before API upload", async () => {
    const uploadPhoto = vi.fn<PhotoLibraryClient["uploadPhoto"]>();
    const client = fakeClient({ uploadPhoto });
    await renderApp(client);
    const input = await screen.findByLabelText(/choose photos/i);
    expect((input as HTMLInputElement).type).toBe("file");
    expect((input as HTMLInputElement).multiple).toBe(true);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Upload status").textContent).toContain(
        "notes.txt: choose a JPEG, PNG, or WebP image",
      ),
    );
    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it("announces upload transitions and authoritative quota/rate errors with retry policy", async () => {
    const client = fakeClient({
      uploadPhoto: vi.fn(async () => {
        throw new ApiClientError("Daily upload quota reached", "quota_exceeded", false, 429);
      }),
    });
    const user = userEvent.setup();
    await renderApp(client);
    await user.upload(
      await screen.findByLabelText(/choose photos/i),
      new File(["image"], "cat.jpg", { type: "image/jpeg" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Upload status").textContent).toContain(
        "cat.jpg — Upload failed: Daily upload quota reached",
      ),
    );
    expect(screen.queryByRole("button", { name: /retry upload/i })).toBeNull();
  });

  it("shows a deliberate read-only state while leaving search enabled", async () => {
    const readiness: PhotoLibraryClient["readiness"] = async () => ({
      version: "v1",
      status: "not_ready",
      environment: "production",
      publicWritesEnabled: false,
      models: { vision: "v", embedding: "e", vectorDimensions: 768, vectorMetric: "cosine" },
      checks: [],
    });
    const client = fakeClient({ readiness });
    await renderApp(client);
    expect(await screen.findByText(/Gallery is read-only/)).toBeTruthy();
    expect((screen.getByLabelText(/choose photos/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole("button", { name: /remove human tag favorite/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("supports selection plus bulk attachment/removal and reports partial outcomes", async () => {
    const mutateTags = vi.fn(async (request: Parameters<PhotoLibraryClient["mutateTags"]>[0]) => ({
      version: "v1" as const,
      results: [
        {
          photoId: request.photoIds[0]!,
          status: "conflict" as const,
          documentRevision: null,
          humanTags: null,
        },
      ],
    }));
    const user = userEvent.setup();
    await renderApp(fakeClient({ mutateTags }));
    await user.click(await screen.findByRole("checkbox", { name: /select photo photo-1/i }));
    const form = screen.getByRole("heading", { name: /edit selected photos/i }).closest("section")!;
    await user.type(within(form).getByLabelText("Human tag"), "garden");
    await user.click(within(form).getByRole("button", { name: "Attach human tag" }));
    expect(
      await screen.findByText(/Attached “garden”: 0 updated, 0 unchanged, 1 failed/),
    ).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "Remove human tag" }));
    expect(mutateTags).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "remove", humanTagNames: ["garden"] }),
      expect.any(AbortSignal),
    );
  });

  it("separates provenance, attribution, tiered reasons, degradation, and tier empty states", async () => {
    const item = photo();
    const client = fakeClient({
      search: async () => ({
        version: "v1",
        query: "cat",
        nextCursor: null,
        degraded: true,
        degradedReason: "Vector provider unavailable",
        items: [
          { photo: item, reason: { tier: "exact_human_tag", normalizedTag: "cat" } },
          {
            photo: { ...item, id: "photo-2" },
            reason: { tier: "exact_ai_word", normalizedWord: "cat", modelRunId: "run-1" },
          },
        ],
      }),
    });
    const user = userEvent.setup();
    await renderApp(client);
    expect((await screen.findAllByLabelText("AI suggested words"))[0]?.textContent).toContain(
      "AI · Cat",
    );
    expect(screen.getAllByLabelText("Human tags")[0]?.textContent).toContain("Human · favorite");
    expect((screen.getByRole("link", { name: "Example Author" }) as HTMLAnchorElement).href).toBe(
      "https://example.com/photo",
    );
    await user.type(screen.getByLabelText("Words or description"), "cat");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { name: "Human tag" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AI word" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Related" })).toBeTruthy();
    expect(screen.getByText(/Matched human tag “cat”/)).toBeTruthy();
    expect(
      screen.getByText(/Related results are incomplete: Vector provider unavailable/),
    ).toBeTruthy();
    expect(screen.getByText("No related matches.")).toBeTruthy();
  });

  it("ignores a stale search response after a newer query completes", async () => {
    let resolveOld!: (value: Awaited<ReturnType<PhotoLibraryClient["search"]>>) => void;
    const old = new Promise<Awaited<ReturnType<PhotoLibraryClient["search"]>>>((resolve) => {
      resolveOld = resolve;
    });
    const search = vi.fn((query: string) =>
      query === "old"
        ? old
        : Promise.resolve({
            version: "v1" as const,
            query,
            nextCursor: null,
            degraded: false,
            degradedReason: null,
            items: [],
          }),
    );
    const user = userEvent.setup();
    const view = await renderApp(fakeClient({ search }));
    const field = await screen.findByLabelText("Words or description");
    await user.type(field, "old");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.clear(field);
    await user.type(field, "new");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByLabelText("Search results for new");
    resolveOld({
      version: "v1",
      query: "old",
      nextCursor: null,
      degraded: true,
      degradedReason: "stale warning",
      items: [],
    });
    await old;
    await view.flush();
    await waitFor(() => expect(screen.queryByText(/stale warning/)).toBeNull());
    expect(screen.getByLabelText("Search results for new")).toBeTruthy();
  });

  it("opens a per-photo related panel from the gallery card and closes it again", async () => {
    const relatedPhotos = vi.fn<PhotoLibraryClient["relatedPhotos"]>(async (photoId) => ({
      version: "v1",
      photoId,
      nextCursor: null,
      degraded: false,
      degradedReason: null,
      items: [
        {
          photo: { ...photo("photo-7"), aiWords: [] },
          reason: {
            tier: "semantic",
            score: 0.64,
            vectorId: "photo-7:1",
            indexedDocumentRevision: 1,
          },
        },
      ],
    }));
    const user = userEvent.setup();
    await renderApp(fakeClient({ relatedPhotos }));

    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(
      await screen.findByRole("button", {
        name: /Show photos related to photo photo-1 by AI description/i,
      }),
    );
    const panel = await screen.findByRole("complementary");
    expect(within(panel).getByRole("heading", { name: "Related by AI description" })).toBeTruthy();
    expect(relatedPhotos).toHaveBeenCalledWith("photo-1", expect.anything());
    expect(
      await within(panel).findByRole("button", { name: /Show photos related to favorite/i }),
    ).toBeTruthy();

    await user.click(
      within(panel).getByRole("button", { name: /close the related photos panel/i }),
    );
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
  });

  it("shares one detail fetch between the gallery card and its related panel for the same photo", async () => {
    const getPhoto = vi.fn(async (photoId: string) => ({
      version: "v1" as const,
      photo: {
        ...photo(photoId),
        byteSize: 10,
        sha256: "x",
        aiCaption: "A cat sitting on a sunlit windowsill",
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    }));
    const relatedPhotos = vi.fn<PhotoLibraryClient["relatedPhotos"]>(async (photoId) => ({
      version: "v1",
      photoId,
      nextCursor: null,
      degraded: false,
      degradedReason: null,
      items: [],
    }));
    const user = userEvent.setup();
    await renderApp(fakeClient({ getPhoto, relatedPhotos }));

    await screen.findByRole("img", { name: /uploaded library photo/i });
    intersectObservedElements();
    // Resolve the gallery caption before opening the panel for the same photo.
    await screen.findByText("A cat sitting on a sunlit windowsill");
    expect(getPhoto).toHaveBeenCalledTimes(1);

    await user.click(
      await screen.findByRole("button", {
        name: /Show photos related to photo photo-1 by AI description/i,
      }),
    );
    const panel = await screen.findByRole("complementary");
    await waitFor(() =>
      expect(panel.textContent).toContain("A cat sitting on a sunlit windowsill"),
    );

    // The panel reused PhotoCard's cached detail request instead of issuing a
    // second one — the WeakMap cache in fetchPhotoDetail
    // (src/lib/photo-library-client.ts) is what turns this into a single
    // request rather than two.
    expect(getPhoto).toHaveBeenCalledTimes(1);
    expect(getPhoto).toHaveBeenCalledWith("photo-1");
  });

  it("cancels pending upload polling so stale responses cannot update an unmounted workspace", async () => {
    let pollingSignal: AbortSignal | undefined;
    const uploadStatus: PhotoLibraryClient["uploadStatus"] = (_operationId, signal) => {
      pollingSignal = signal;
      return new Promise(() => undefined);
    };
    const user = userEvent.setup();
    const view = await renderApp(fakeClient({ uploadStatus }));
    await user.upload(
      await screen.findByLabelText(/choose photos/i),
      new File(["image"], "pending.jpg", { type: "image/jpeg" }),
    );
    await waitFor(() => expect(pollingSignal).toBeDefined());
    view.dispose();
    expect(pollingSignal?.aborted).toBe(true);
  });

  it("renders the AI-generated caption once the photo's detail loads", async () => {
    const getPhoto = vi.fn(async (photoId: string) => ({
      version: "v1" as const,
      photo: {
        ...photo(photoId),
        byteSize: 10,
        sha256: "x",
        aiCaption: "A cat sitting on a sunlit windowsill",
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    }));
    await renderApp(fakeClient({ getPhoto }));
    await screen.findByRole("img", { name: /uploaded library photo/i });
    intersectObservedElements();
    expect(await screen.findByText("A cat sitting on a sunlit windowsill")).toBeTruthy();
    expect(intersectionObservers[0]?.disconnect).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "AI description" })).toBeTruthy();
    expect(getPhoto).toHaveBeenCalledWith("photo-1");
  });

  it("renders no caption block, placeholder, or heading for a photo without an AI caption", async () => {
    const getPhoto = vi.fn(async (photoId: string) => ({
      version: "v1" as const,
      photo: {
        ...photo(photoId),
        byteSize: 10,
        sha256: "x",
        aiCaption: null,
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    }));
    await renderApp(fakeClient({ getPhoto }));
    await screen.findByRole("img", { name: /uploaded library photo/i });
    intersectObservedElements();
    await waitFor(() => expect(getPhoto).toHaveBeenCalledWith("photo-1"));
    expect(screen.queryByRole("heading", { name: "AI description" })).toBeNull();
    expect(screen.queryByText(/A cat sitting/)).toBeNull();
  });

  it("disconnects pending caption observers and ignores late detail results after disposal", async () => {
    let resolveDetail!: (detail: Awaited<ReturnType<PhotoLibraryClient["getPhoto"]>>) => void;
    const detail = new Promise<Awaited<ReturnType<PhotoLibraryClient["getPhoto"]>>>((resolve) => {
      resolveDetail = resolve;
    });
    const getPhoto = vi.fn<PhotoLibraryClient["getPhoto"]>(() => detail);
    const view = await renderApp(fakeClient({ getPhoto }));
    const image = await screen.findByRole("img", { name: /uploaded library photo/i });
    const article = image.closest("article")!;
    expect(getPhoto).not.toHaveBeenCalled();
    expect(intersectionObservers[0]?.targets.has(article)).toBe(true);
    intersectObservedElements();
    await waitFor(() => expect(getPhoto).toHaveBeenCalledTimes(1));
    expect(intersectionObservers[0]?.disconnect).toHaveBeenCalledTimes(1);
    view.dispose();
    expect(intersectionObservers[0]?.disconnect).toHaveBeenCalledTimes(2);
    resolveDetail({
      version: "v1",
      photo: {
        ...photo(),
        byteSize: 10,
        sha256: "x",
        aiCaption: "Late caption",
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    });
    await detail;
    await view.flush();
    expect(article.textContent).not.toContain("Late caption");
    expect(screen.queryByRole("img", { name: /uploaded library photo/i })).toBeNull();
  });

  it("keeps selection and keyed card tags live across mutations and search navigation", async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    await renderApp(client);
    const checkbox = (await screen.findByRole("checkbox", {
      name: /select photo photo-1/i,
    })) as HTMLInputElement;
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText("1 selected")).toBeTruthy();
    await user.type(screen.getByLabelText("Human tag"), "garden");
    await user.click(screen.getByRole("button", { name: "Attach human tag" }));
    await screen.findByRole("button", { name: /remove human tag garden/i });
    expect(screen.getByRole("checkbox", { name: /select photo photo-1/i })).toBe(checkbox);
    expect(screen.queryByRole("button", { name: /remove human tag favorite/i })).toBeNull();
    await user.type(screen.getByLabelText("Words or description"), "cat");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByLabelText("Search results for cat");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    const restored = (await screen.findByRole("checkbox", {
      name: /select photo photo-1/i,
    })) as HTMLInputElement;
    expect(restored.checked).toBe(true);
    expect(screen.getByRole("button", { name: /remove human tag garden/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(restored.checked).toBe(false);
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("copies native selected files before clearing the input and uploads their original objects", async () => {
    const uploadPhoto = vi.fn<PhotoLibraryClient["uploadPhoto"]>(async () => ({
      version: "v1",
      operationId: "operation-1",
      photoId: "photo-2",
      state: "completed",
      retryable: false,
      errorCode: null,
      updatedAt: "2026-08-10T00:00:01.000Z",
    }));
    const user = userEvent.setup();
    await renderApp(fakeClient({ uploadPhoto }));
    const input = (await screen.findByLabelText(/choose photos/i)) as HTMLInputElement;
    const files = [
      new File(["first"], "first.jpg", { type: "image/jpeg" }),
      new File(["second"], "second.png", { type: "image/png" }),
    ];
    await user.upload(input, files);
    expect(input.value).toBe("");
    expect(uploadPhoto).toHaveBeenCalledTimes(2);
    expect(uploadPhoto.mock.calls[0]?.[0]).toBe(files[0]);
    expect(uploadPhoto.mock.calls[1]?.[0]).toBe(files[1]);
    expect(uploadPhoto.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    await screen.findByText("first.jpg");
    await screen.findByText("second.png");
  });

  it("aborts pending tag mutation on disposal and cannot update a later App instance", async () => {
    let release!: (value: Awaited<ReturnType<PhotoLibraryClient["mutateTags"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<PhotoLibraryClient["mutateTags"]>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const mutateTags = vi.fn<PhotoLibraryClient["mutateTags"]>(() => pending);
    const user = userEvent.setup();
    const first = await renderApp(fakeClient({ mutateTags }));
    await user.click(await screen.findByRole("checkbox", { name: /select photo photo-1/i }));
    await user.type(screen.getByLabelText("Human tag"), "old-tag");
    await user.click(screen.getByRole("button", { name: "Attach human tag" }));
    expect(mutateTags).toHaveBeenCalledTimes(1);
    const abortSignal = mutateTags.mock.calls[0]?.[1];
    expect(abortSignal?.aborted).toBe(false);
    first.dispose();
    expect(abortSignal?.aborted).toBe(true);
    await renderApp(fakeClient());
    release({ version: "v1", results: [] });
    await pending;
    await first.flush();
    expect(screen.queryByText(/Attached “old-tag”/)).toBeNull();
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove human tag favorite/i })).toBeTruthy();
  });

  it("retains the related panel while following a neighbour and restores the original opener", async () => {
    const relatedPhotos = vi.fn<PhotoLibraryClient["relatedPhotos"]>(async (photoId) => ({
      version: "v1",
      photoId,
      nextCursor: null,
      degraded: false,
      degradedReason: null,
      items:
        photoId === "photo-1"
          ? [
              {
                photo: { ...photo("photo-2"), humanTags: [] },
                reason: {
                  tier: "semantic",
                  score: 0.8,
                  vectorId: "photo-2:1",
                  indexedDocumentRevision: 1,
                },
              },
            ]
          : [],
    }));
    const user = userEvent.setup();
    await renderApp(fakeClient({ relatedPhotos }));
    const opener = await screen.findByRole("button", {
      name: /Show photos related to photo photo-1 by AI description/i,
    });
    await user.click(opener);
    const panel = await screen.findByRole("complementary");
    await user.click(
      await within(panel).findByRole("button", { name: "Show photos related to Cat" }),
    );
    await waitFor(() =>
      expect(relatedPhotos).toHaveBeenLastCalledWith("photo-2", expect.any(AbortSignal)),
    );
    expect(screen.getByRole("complementary")).toBe(panel);
    expect(document.activeElement).toBe(panel);
    expect(within(panel).getByRole("presentation").getAttribute("src")).toBe(
      "/api/v1/photos/photo-2/media",
    );
    await user.click(
      within(panel).getByRole("button", { name: /close the related photos panel/i }),
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("exposes deterministic responsive intent in markup", async () => {
    await renderApp(fakeClient());
    const image = await screen.findByRole("img", { name: /uploaded library photo/i });
    expect((image as HTMLImageElement).width).toBe(1200);
    expect((image as HTMLImageElement).height).toBe(800);
    const grid = image.closest("[data-layout='bounded-responsive-grid']");
    expect(grid?.className).toContain("auto-fill");
    expect(grid?.className).toContain("20rem");
    expect(screen.getByRole("button", { name: "Search" }).className).toContain("min-h-control");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
  });
});
