import { signal } from "@takazudo/zfb/zudo-react";
import { createIslandTest, type IslandTest } from "@takazudo/zfb/zudo-react/testing";
import { screen, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelatedPhotosPanel } from "./RelatedPhotosPanel";
import { ApiClientError, type PhotoLibraryClient } from "../lib/photo-library-client";
import type { RelatedPhotoResult, RelatedPhotosResponse } from "../worker/contracts/api";
import type { PhotoSummary } from "../worker/contracts/domain";

const islands: IslandTest[] = [];
async function renderPanel(client: PhotoLibraryClient, initialPhoto: PhotoSummary) {
  const selectedPhoto = signal(initialPhoto);
  function TestPanel() {
    return (
      <RelatedPhotosPanel
        photo={selectedPhoto}
        client={client}
        onClose={() => undefined}
        onOpenRelated={() => undefined}
      />
    );
  }
  const island = createIslandTest(TestPanel, {}, { document });
  islands.push(island);
  expect(island.hydrate()).not.toBeNull();
  await island.flush();
  expect(island.diagnostics).toEqual([]);
  return { island, selectedPhoto };
}
afterEach(() => {
  for (const island of islands.splice(0)) island.dispose();
});

const photo = (id: string, word: string): PhotoSummary => ({
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
      word,
      normalizedWord: word.toLowerCase(),
      confidence: 0.9,
      modelRunId: "run-1",
      documentRevision: 1,
    },
  ],
  humanTags: [],
  attribution: null,
});

const neighbour = (id: string, word: string, score = 0.82): RelatedPhotoResult => ({
  photo: photo(id, word),
  reason: {
    tier: "semantic",
    score,
    vectorId: `${id}:1`,
    indexedDocumentRevision: 1,
  },
});

const page = (overrides: Partial<RelatedPhotosResponse> = {}): RelatedPhotosResponse => ({
  version: "v1",
  photoId: "photo-1",
  items: [],
  nextCursor: null,
  degraded: false,
  degradedReason: null,
  ...overrides,
});

/** The panel touches only these two client methods; the rest stay unstubbed. */
function panelClient(
  relatedPhotos: PhotoLibraryClient["relatedPhotos"],
  aiCaption: string | null = "A tabby cat on a windowsill",
): PhotoLibraryClient {
  const stub: Pick<PhotoLibraryClient, "relatedPhotos" | "getPhoto"> = {
    relatedPhotos,
    getPhoto: async (photoId) => ({
      version: "v1",
      photo: {
        ...photo(photoId, "Cat"),
        byteSize: 10,
        sha256: "x",
        aiCaption,
        canonicalIndexedRevision: 1,
        reindexRequiredRevision: null,
      },
    }),
  };
  return stub as PhotoLibraryClient;
}

const panelState = () => screen.getByRole("complementary").getAttribute("data-related-state");

describe("related photos panel", () => {
  it("names the surface after AI description and lists neighbours with thumbnails", async () => {
    const client = panelClient(async () =>
      page({ items: [neighbour("photo-2", "Kitten"), neighbour("photo-3", "Sofa", 0.71)] }),
    );
    const view = await renderPanel(client, photo("photo-1", "Cat"));

    expect(screen.getByRole("heading", { name: "Related by AI description" })).toBeTruthy();
    await waitFor(() => expect(panelState()).toBe("ready"));
    expect(screen.getByRole("button", { name: "Show photos related to Kitten" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show photos related to Sofa" })).toBeTruthy();
    expect(screen.getByText("0.71")).toBeTruthy();
    // Header thumbnail plus one per neighbour, all pointing at the media route.
    const images = Array.from(view.island.host.querySelectorAll("img"));
    expect(images.map((image) => new URL(image.src).pathname)).toEqual([
      "/api/v1/photos/photo-1/media",
      "/api/v1/photos/photo-2/media",
      "/api/v1/photos/photo-3/media",
    ]);
    await waitFor(() =>
      expect(screen.getByRole("complementary").textContent).toContain(
        "A tabby cat on a windowsill",
      ),
    );
  });

  it("shows loading, then a genuine-empty state distinct from both degraded states", async () => {
    let release!: (response: RelatedPhotosResponse) => void;
    const pending = new Promise<RelatedPhotosResponse>((resolve) => {
      release = resolve;
    });
    await renderPanel(
      panelClient(() => pending),
      photo("photo-1", "Cat"),
    );

    expect(panelState()).toBe("loading");
    expect(screen.getByText(/Finding photos with related descriptions/)).toBeTruthy();
    expect(screen.getByRole("complementary").getAttribute("aria-busy")).toBe("true");

    release(page());
    await waitFor(() => expect(panelState()).toBe("ready"));
    expect(
      screen.getByText(/Nothing else in the library has a close enough AI description/),
    ).toBeTruthy();
    expect(screen.queryByText(/Not indexed yet/)).toBeNull();
    expect(screen.queryByText(/vector index could not be reached/)).toBeNull();
  });

  it("renders vector_pending as a transient not-indexed state, not an outage", async () => {
    const client = panelClient(async () =>
      page({ degraded: true, degradedReason: "vector_pending" }),
    );
    await renderPanel(client, photo("photo-1", "Cat"));

    await waitFor(() => expect(panelState()).toBe("not_indexed"));
    expect(screen.getByText(/Not indexed yet/)).toBeTruthy();
    expect(screen.getByText(/normally takes a few seconds after processing/)).toBeTruthy();
    // A transient index lag must not be dressed up as a provider outage.
    expect(screen.queryByText(/unavailable/i)).toBeNull();
    expect(screen.getByRole("status").className).toContain("bg-sunken");
  });

  it("renders provider_unavailable as a degraded outage, visibly distinct from not-indexed", async () => {
    const client = panelClient(async () =>
      page({ degraded: true, degradedReason: "provider_unavailable" }),
    );
    await renderPanel(client, photo("photo-1", "Cat"));

    await waitFor(() => expect(panelState()).toBe("provider_unavailable"));
    expect(screen.getByText(/Related photos are unavailable right now/)).toBeTruthy();
    expect(screen.getByText(/vector index could not be reached/)).toBeTruthy();
    expect(screen.queryByText(/Not indexed yet/)).toBeNull();
    expect(screen.getByRole("status").className).toContain("bg-warning-soft");
  });

  it("treats a degraded response with an unknown reason as an outage", async () => {
    const client = panelClient(async () => page({ degraded: true, degradedReason: null }));
    await renderPanel(client, photo("photo-1", "Cat"));
    await waitFor(() => expect(panelState()).toBe("provider_unavailable"));
  });

  it("reports a vanished source photo instead of a bare request failure", async () => {
    const client = panelClient(async () => {
      throw new ApiClientError("Photo not found", "not_found", false, 404);
    });
    await renderPanel(client, photo("photo-1", "Cat"));
    await waitFor(() => expect(panelState()).toBe("error"));
    expect(screen.getByText(/This photo is no longer available/)).toBeTruthy();
  });

  it("ends the caption placeholder when the detail request fails but neighbours load", async () => {
    const client = panelClient(async () => page({ items: [neighbour("photo-2", "Kitten")] }));
    client.getPhoto = async () => {
      throw new ApiClientError("Detail unavailable", "request_failed", true, 503);
    };
    await renderPanel(client, photo("photo-1", "Cat"));

    await waitFor(() => expect(panelState()).toBe("ready"));
    expect(await screen.findByText(/The AI description could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/Loading the AI description/)).toBeNull();
    expect(screen.getByRole("button", { name: "Show photos related to Kitten" })).toBeTruthy();
  });

  it("moves focus to the panel so the narrow-screen stacked layout does not look inert", async () => {
    const client = panelClient(async () => page());
    const view = await renderPanel(client, photo("photo-1", "Cat"));
    const panel = screen.getByRole("complementary");
    expect(document.activeElement).toBe(panel);

    (document.body.querySelector("button") as HTMLButtonElement).focus();
    view.selectedPhoto.value = photo("photo-2", "Boat");
    await view.island.flush();
    expect(document.activeElement).toBe(screen.getByRole("complementary"));
  });

  it("discards a superseded response so photo A's neighbours never render under photo B", async () => {
    let releaseFirst!: (response: RelatedPhotosResponse) => void;
    const first = new Promise<RelatedPhotosResponse>((resolve) => {
      releaseFirst = resolve;
    });
    // Ignores the AbortSignal on purpose: the guard must not depend on the
    // client honouring cancellation.
    const relatedPhotos = vi.fn((photoId: string) =>
      photoId === "photo-1"
        ? first
        : Promise.resolve(page({ photoId, items: [neighbour("photo-9", "Harbour")] })),
    );
    const client = panelClient(relatedPhotos);
    const view = await renderPanel(client, photo("photo-1", "Cat"));

    view.selectedPhoto.value = photo("photo-2", "Boat");
    await view.island.flush();
    expect(
      await screen.findByRole("button", { name: "Show photos related to Harbour" }),
    ).toBeTruthy();

    releaseFirst(page({ items: [neighbour("photo-8", "Stale")] }));
    await first;
    await view.island.flush();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Show photos related to Stale" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Show photos related to Harbour" })).toBeTruthy();
    expect(relatedPhotos).toHaveBeenCalledTimes(2);
  });

  it("hands focus back to whatever opened it when it closes", async () => {
    const client = panelClient(async () => page({ items: [neighbour("photo-2", "Kitten")] }));
    // Stands in for the gallery card's "Related by AI description" trigger. In
    // the stacked layout the panel renders after the whole gallery, so letting
    // focus fall to <body> on close strands the user at the gallery bottom.
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const view = await renderPanel(client, photo("photo-1", "Cat"));
    await waitFor(() => expect(panelState()).toBe("ready"));
    expect(document.activeElement).not.toBe(opener);

    view.island.dispose();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("aborts the active request on close and suppresses a late result", async () => {
    let requestSignal: AbortSignal | undefined;
    let release!: (response: RelatedPhotosResponse) => void;
    const pending = new Promise<RelatedPhotosResponse>((resolve) => {
      release = resolve;
    });
    const client = panelClient((_photoId, abortSignal) => {
      requestSignal = abortSignal;
      return pending;
    });
    const view = await renderPanel(client, photo("photo-1", "Cat"));
    expect(requestSignal?.aborted).toBe(false);
    const panel = screen.getByRole("complementary");
    view.island.dispose();
    expect(requestSignal?.aborted).toBe(true);
    release(page({ items: [neighbour("photo-8", "Stale")] }));
    await pending;
    await view.island.flush();
    expect(panel.textContent).not.toContain("Stale");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("never implies the system compares images to each other", async () => {
    const client = panelClient(async () => page({ items: [neighbour("photo-2", "Kitten")] }));
    await renderPanel(client, photo("photo-1", "Cat"));
    await waitFor(() => expect(panelState()).toBe("ready"));

    const panel = screen.getByRole("complementary");
    const copy = `${panel.textContent ?? ""} ${panel.innerHTML}`.toLowerCase();
    for (const forbidden of ["similar photo", "visually similar", "looks like", "image-to-image"])
      expect(copy).not.toContain(forbidden);
    expect(panel.textContent).toContain("never compares the images themselves");
  });
});
