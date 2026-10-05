"use client";

import {
  signal,
  computed,
  getScope,
  Show,
  For,
  type ReadonlySignal,
} from "@takazudo/zfb/zudo-react";
import { PhotoCard } from "./components/PhotoCard";
import { RelatedPhotosPanel } from "./components/RelatedPhotosPanel";
import { StatusBanner } from "./components/StatusBanner";
import {
  ApiClientError,
  browserPhotoLibraryClient,
  type PhotoLibraryClient,
} from "./lib/photo-library-client";
import { validateUploadFile } from "./lib/upload-validation";
import type { BulkHumanTagMutationResult, SearchResult, SearchTier } from "./worker/contracts/api";
import type { PhotoSummary } from "./worker/contracts/domain";

type UploadPhase = "queued" | "uploading" | "processing" | "ready" | "retryable" | "failed";
interface UploadItem {
  key: string;
  file: File;
  phase: UploadPhase;
  message: string;
  generation: number;
}

const phaseLabel: Record<UploadPhase, string> = {
  queued: "Queued",
  uploading: "Uploading",
  processing: "Processing AI words",
  ready: "Ready",
  retryable: "Upload interrupted — retry available",
  failed: "Upload failed",
};

const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function App({ client = browserPhotoLibraryClient }: { client?: PhotoLibraryClient }) {
  const photos = signal<PhotoSummary[]>([]);
  const loading = signal(true);
  const loadError = signal<string | null>(null);
  const readinessWarning = signal<string | null>(null);
  const writesEnabled = signal(false);
  const uploads = signal<UploadItem[]>([]);
  const selected = signal<Set<string>>(new Set());
  const mutationMessage = signal<string | null>(null);
  const mutationBusy = signal(false);
  const searchResults = signal<SearchResult[] | null>(null);
  const searchQuery = signal("");
  const searchError = signal<string | null>(null);
  const searchBusy = signal(false);
  const degradedReason = signal<string | null>(null);
  const relatedPhoto = signal<PhotoSummary | null>(null);
  const dragging = signal(false);
  const uploadGenerations = new Map<string, number>();
  const uploadControllers = new Map<string, AbortController>();
  const scope = getScope();
  let mounted = false;
  let searchGeneration = 0;
  let searchController: AbortController | undefined;

  async function reloadPhotos(abortSignal?: AbortSignal) {
    if (!mounted || abortSignal?.aborted) return;
    const response = await client.listPhotos(abortSignal);
    if (mounted && !abortSignal?.aborted)
      photos.value = response.items.filter((photo) => photo.state !== "tombstoned");
  }

  scope.onActivate(() => {
    mounted = true;
    const controller = new AbortController();
    loading.value = true;
    void client
      .readiness(controller.signal)
      .then((readiness) => {
        if (controller.signal.aborted) return;
        writesEnabled.value = readiness.publicWritesEnabled;
        readinessWarning.value = null;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          writesEnabled.value = false;
          readinessWarning.value = `Write availability could not be confirmed: ${messageFor(error)}`;
        }
      });
    void client
      .listPhotos(controller.signal)
      .then((gallery) => {
        if (controller.signal.aborted) return;
        photos.value = gallery.items.filter((photo) => photo.state !== "tombstoned");
        loadError.value = null;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) loadError.value = messageFor(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) loading.value = false;
      });
    return () => {
      mounted = false;
      ++searchGeneration;
      controller.abort();
      searchController?.abort();
      for (const uploadController of uploadControllers.values()) uploadController.abort();
      uploadControllers.clear();
    };
  });

  const updateUpload = (key: string, generation: number, patch: Partial<UploadItem>) => {
    if (!mounted || uploadGenerations.get(key) !== generation) return;
    uploads.value = uploads.value.map((item) => (item.key === key ? { ...item, ...patch } : item));
  };

  const runUpload = async (key: string, file: File, generation: number) => {
    const controller = new AbortController();
    uploadControllers.get(key)?.abort();
    uploadControllers.set(key, controller);
    try {
      updateUpload(key, generation, { phase: "uploading", message: "Uploading securely" });
      const created = await client.uploadPhoto(file, controller.signal);
      if (!mounted || controller.signal.aborted || uploadGenerations.get(key) !== generation)
        return;
      updateUpload(key, generation, {
        phase: "processing",
        message: "Upload stored; waiting for processing",
      });

      let status = await client.uploadStatus(created.operationId, controller.signal);
      while (
        status.photoState !== "ready" &&
        !["failed", "expired", "purge_pending"].includes(status.state) &&
        !["failed", "enqueue_failed"].includes(status.photoState ?? "")
      ) {
        await sleep(1_000, controller.signal);
        if (!mounted || controller.signal.aborted || uploadGenerations.get(key) !== generation)
          return;
        status = await client.uploadStatus(created.operationId, controller.signal);
      }
      if (!mounted || controller.signal.aborted || uploadGenerations.get(key) !== generation)
        return;
      if (
        ["enqueue_failed", "failed", "expired", "purge_pending"].includes(status.state) ||
        ["failed", "enqueue_failed"].includes(status.photoState ?? "")
      ) {
        updateUpload(key, generation, {
          phase: status.retryable ? "retryable" : "failed",
          message: status.errorCode ?? phaseLabel[status.retryable ? "retryable" : "failed"],
        });
        return;
      }

      updateUpload(key, generation, { phase: "ready", message: "Added to the public library" });
      await reloadPhotos(controller.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const retryable = !(error instanceof ApiClientError) || error.retryable;
      updateUpload(key, generation, {
        phase: retryable ? "retryable" : "failed",
        message: messageFor(error),
      });
    } finally {
      if (uploadControllers.get(key) === controller) uploadControllers.delete(key);
    }
  };

  const queueFiles = (files: FileList | File[]) => {
    const candidates = Array.from(files);
    const additions = candidates.map((file, index): UploadItem => {
      const key = `${file.name}:${file.size}:${file.lastModified}:${index}:${Date.now()}`;
      const error = validateUploadFile(file);
      uploadGenerations.set(key, 1);
      return {
        key,
        file,
        generation: 1,
        phase: error ? "failed" : "queued",
        message: error ?? "Waiting to upload",
      };
    });
    uploads.value = [...additions, ...uploads.value];
    for (const item of additions)
      if (item.phase === "queued") void runUpload(item.key, item.file, 1);
  };

  const retryUpload = (item: UploadItem) => {
    const generation = (uploadGenerations.get(item.key) ?? item.generation) + 1;
    uploadGenerations.set(item.key, generation);
    uploads.value = uploads.value.map((candidate) =>
      candidate.key === item.key
        ? { ...candidate, generation, phase: "queued", message: "Retry queued" }
        : candidate,
    );
    void runUpload(item.key, item.file, generation);
  };

  const toggleSelection = (photoId: string) => {
    const next = new Set(selected.value);
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
    selected.value = next;
  };

  const mutateTags = async (action: "attach" | "remove", tag: string, photoIds: string[]) => {
    const normalized = tag.trim();
    if (!normalized || photoIds.length === 0) return;
    mutationBusy.value = true;
    mutationMessage.value = null;
    try {
      const response = await client.mutateTags(
        {
          version: "v1",
          action,
          photoIds,
          humanTagNames: [normalized],
          expectedRevisions: Object.fromEntries(
            photos.value
              .filter((photo) => photoIds.includes(photo.id))
              .map((photo) => [photo.id, photo.documentRevision]),
          ),
        },
        scope.abortSignal,
      );
      if (!mounted) return;
      photos.value = photos.value.map((photo) => applyMutationResult(photo, response.results));
      searchResults.value =
        searchResults.value &&
        searchResults.value.map((result) => ({
          ...result,
          photo: applyMutationResult(result.photo, response.results),
        }));
      const updated = response.results.filter((result) => result.status === "updated").length;
      const unchanged = response.results.filter((result) => result.status === "unchanged").length;
      const failed = response.results.length - updated - unchanged;
      mutationMessage.value = `${action === "attach" ? "Attached" : "Removed"} “${normalized}”: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`;
    } catch (error) {
      if (!mounted) return;
      mutationMessage.value = messageFor(error);
    } finally {
      if (mounted) mutationBusy.value = false;
    }
  };

  const submitSearch = async (query: string) => {
    const normalized = query.trim();
    const generation = ++searchGeneration;
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searchQuery.value = normalized;
    searchError.value = null;
    if (!normalized) {
      searchBusy.value = false;
      searchResults.value = null;
      degradedReason.value = null;
      return;
    }
    searchBusy.value = true;
    try {
      const response = await client.search(normalized, controller.signal);
      if (!mounted || generation !== searchGeneration) return;
      searchResults.value = response.items;
      degradedReason.value = response.degraded
        ? (response.degradedReason ?? "Related search is temporarily unavailable.")
        : null;
    } catch (error) {
      if (mounted && generation === searchGeneration) searchError.value = messageFor(error);
    } finally {
      if (mounted && generation === searchGeneration) searchBusy.value = false;
    }
  };

  const visiblePhotos = computed(() => (searchResults.value === null ? photos.value : []));
  const selectedCount = computed(() => selected.value.size);
  const showRelated = (photo: PhotoSummary) => {
    relatedPhoto.value = photo;
  };

  return (
    <div class="mx-auto max-w-screen-2xl px-[clamp(1rem,4vw,2rem)] py-lg">
      <header class="grid gap-sm border-b border-line pb-lg">
        <p class="m-0 text-xs font-semibold uppercase tracking-wide text-accent">
          Public AI photo library
        </p>
        <h1 class="m-0 text-[clamp(1.75rem,5vw,3rem)] tracking-tight">
          Upload, describe, and find photos together.
        </h1>
        <p class="m-0 max-w-prose text-muted">
          This anonymous public demo keeps original image files, including metadata. AI suggestions
          are automatic; moderation is reactive operator purge only.
        </p>
      </header>

      <main class="mt-xl grid gap-xl">
        <Show
          when={computed(() => !writesEnabled.value && !loading.value)}
          children={() => (
            <StatusBanner tone="warning">
              <strong>Gallery is read-only.</strong> Public uploads and tag changes are currently
              disabled; search remains available.
            </StatusBanner>
          )}
        />
        <Show
          when={computed(() => !!readinessWarning.value)}
          children={() => (
            <StatusBanner tone="warning">
              {readinessWarning} Gallery and search can still be used.
            </StatusBanner>
          )}
        />
        <Show
          when={computed(() => !!loadError.value)}
          children={() => (
            <StatusBanner tone="error">Could not load the library: {loadError}</StatusBanner>
          )}
        />

        <section
          aria-labelledby="upload-heading"
          class="grid gap-md rounded-lg border border-line bg-surface p-[clamp(1rem,4vw,1.5rem)]"
        >
          <div>
            <h2 id="upload-heading" class="m-0 text-title">
              Add photos
            </h2>
            <p class="mt-3xs mb-0 text-sm text-muted">
              JPEG, PNG, or WebP · up to 5 MiB each · originals may retain metadata
            </p>
          </div>
          <label
            class={computed(
              () =>
                `drop-zone grid cursor-pointer place-items-center rounded-lg border-2 border-dashed px-md py-xl text-center ${dragging.value ? "border-accent bg-accent-soft" : "border-line-strong bg-sunken"} ${!writesEnabled.value ? "cursor-not-allowed opacity-60" : ""}`,
            )}
            on:dragenter={(event) => {
              event.preventDefault();
              if (writesEnabled.value) dragging.value = true;
            }}
            on:dragover={(event) => event.preventDefault()}
            on:dragleave={() => {
              dragging.value = false;
            }}
            on:drop={(event) => {
              event.preventDefault();
              dragging.value = false;
              if (writesEnabled.value) queueFiles(event.dataTransfer!.files);
            }}
          >
            <span>
              <strong>Choose photos</strong> or drag and drop them here
            </span>
            <input
              class="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              disabled={computed(() => !writesEnabled.value)}
              on:change={(event) => {
                if (event.currentTarget.files) queueFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <Show
            when={computed(() => uploads.value.length > 0)}
            children={() => (
              <ul
                class="m-0 grid list-none gap-xs p-0"
                aria-label="Upload status"
                aria-live="polite"
              >
                <For
                  each={uploads}
                  by={(item) => item.key}
                  children={(item) => (
                    <li class="flex min-w-0 flex-wrap items-center justify-between gap-xs rounded-md bg-sunken px-sm py-xs text-sm">
                      <span class="min-w-0">
                        <strong class="break-words">{computed(() => item.value.file.name)}</strong>{" "}
                        — {computed(() => phaseLabel[item.value.phase])}
                        {computed(() => (item.value.message ? `: ${item.value.message}` : ""))}
                      </span>
                      <Show
                        when={computed(() => item.value.phase === "retryable")}
                        children={() => (
                          <button
                            class="min-h-control rounded-md border border-line-strong px-sm font-semibold"
                            type="button"
                            on:click={() => retryUpload(item.value)}
                          >
                            Retry upload
                          </button>
                        )}
                      />
                    </li>
                  )}
                />
              </ul>
            )}
          />
        </section>

        <section aria-labelledby="search-heading" class="grid gap-md">
          <h2 id="search-heading" class="m-0 text-title">
            Search the library
          </h2>
          <form
            class="flex flex-wrap gap-xs"
            aria-busy={searchBusy}
            on:submit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void submitSearch(String(data.get("query") ?? ""));
            }}
          >
            <label class="grid min-w-[min(100%,20rem)] flex-1 gap-3xs text-sm font-semibold">
              Words or description
              <input
                class="min-h-control min-w-0 rounded-md border border-line-strong bg-surface px-sm text-ink"
                name="query"
                type="search"
                placeholder="Try cat, flowers, or sunset"
              />
            </label>
            <button
              class="min-h-control self-end rounded-md bg-accent px-lg font-semibold text-accent-ink"
              type="submit"
            >
              Search
            </button>
            <Show
              when={computed(() => searchResults.value !== null)}
              children={() => (
                <button
                  class="min-h-control self-end rounded-md border border-line-strong px-lg font-semibold"
                  type="button"
                  on:click={() => void submitSearch("")}
                >
                  Clear search
                </button>
              )}
            />
          </form>
          <Show
            when={computed(() => !!searchError.value)}
            children={() => <StatusBanner tone="error">Search failed: {searchError}</StatusBanner>}
          />
          <div class="sr-only" aria-live="polite">
            {computed(() => (searchBusy.value ? "Searching the photo library" : ""))}
          </div>
        </section>

        <div
          class={computed(() =>
            relatedPhoto.value
              ? "grid items-start gap-xl wide:grid-workspace-panel"
              : "grid gap-xl",
          )}
        >
          <Show
            when={computed(() => searchResults.value !== null)}
            children={() => (
              <SearchResults
                query={searchQuery}
                results={computed(() => searchResults.value ?? [])}
                degradedReason={degradedReason}
                selected={selected}
                writesEnabled={writesEnabled}
                client={client}
                onSelect={toggleSelection}
                onRemoveTag={(id, tag) => void mutateTags("remove", tag, [id])}
                onShowRelated={showRelated}
              />
            )}
            fallback={() => (
              <section aria-labelledby="gallery-heading" class="grid gap-md">
                <div class="flex flex-wrap items-center justify-between gap-sm">
                  <div>
                    <h2 id="gallery-heading" class="m-0 text-title">
                      Latest photos
                    </h2>
                    <p class="mt-3xs mb-0 text-sm text-muted">
                      {computed(() =>
                        loading.value ? "Loading…" : `${photos.value.length} photos`,
                      )}
                    </p>
                  </div>
                  <Show
                    when={computed(() => photos.value.length > 0)}
                    children={() => (
                      <div class="flex flex-wrap gap-xs">
                        <button
                          type="button"
                          class="min-h-control rounded-md border border-line-strong px-sm font-semibold"
                          on:click={() => {
                            selected.value = new Set(photos.value.map((photo) => photo.id));
                          }}
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          class="min-h-control rounded-md border border-line-strong px-sm font-semibold"
                          on:click={() => {
                            selected.value = new Set();
                          }}
                        >
                          Clear selection
                        </button>
                      </div>
                    )}
                  />
                </div>
                <Show
                  when={computed(() => !loading.value && visiblePhotos.value.length === 0)}
                  children={() => <EmptyState>No photos are available yet.</EmptyState>}
                  fallback={() => (
                    <PhotoGrid
                      photos={visiblePhotos}
                      selected={selected}
                      writesEnabled={writesEnabled}
                      client={client}
                      onSelect={toggleSelection}
                      onRemoveTag={(id, tag) => void mutateTags("remove", tag, [id])}
                      onShowRelated={showRelated}
                    />
                  )}
                />
              </section>
            )}
          />
          <Show
            when={computed(() => relatedPhoto.value !== null)}
            children={() => (
              <RelatedPhotosPanel
                photo={computed(() => {
                  const photo = relatedPhoto.value;
                  if (!photo) throw new Error("Related photo panel requires an open photo");
                  return photo;
                })}
                client={client}
                onClose={() => (relatedPhoto.value = null)}
                onOpenRelated={showRelated}
              />
            )}
          />
        </div>

        <BulkTagBar
          selectedCount={selectedCount}
          disabled={computed(() => !writesEnabled.value || mutationBusy.value)}
          onMutate={(action, tag) => void mutateTags(action, tag, Array.from(selected.value))}
        />
        <div aria-live="polite">
          <Show
            when={computed(() => !!mutationMessage.value)}
            children={() => (
              <StatusBanner
                tone={computed(() =>
                  mutationMessage.value?.includes("failed") &&
                  !mutationMessage.value.includes("0 failed")
                    ? "warning"
                    : "success",
                )}
              >
                {mutationMessage}
              </StatusBanner>
            )}
          />
        </div>
      </main>
    </div>
  );
}

function PhotoGrid({
  photos,
  selected,
  writesEnabled,
  client,
  onSelect,
  onRemoveTag,
  onShowRelated,
}: {
  photos: ReadonlySignal<PhotoSummary[]>;
  selected: ReadonlySignal<Set<string>>;
  writesEnabled: ReadonlySignal<boolean>;
  client: PhotoLibraryClient;
  onSelect(id: string): void;
  onRemoveTag(id: string, tag: string): void;
  onShowRelated(photo: PhotoSummary): void;
}) {
  return (
    <div
      class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),20rem))] justify-start gap-md"
      data-layout="bounded-responsive-grid"
    >
      <For
        each={photos}
        by={(photo) => photo.id}
        children={(photo) => (
          <PhotoCard
            photo={photo}
            selected={computed(() => selected.value.has(photo.value.id))}
            disabled={computed(() => !writesEnabled.value)}
            client={client}
            onSelect={onSelect}
            onRemoveTag={onRemoveTag}
            onShowRelated={onShowRelated}
          />
        )}
      />
    </div>
  );
}

function BulkTagBar({
  selectedCount,
  disabled,
  onMutate,
}: {
  selectedCount: ReadonlySignal<number>;
  disabled: ReadonlySignal<boolean>;
  onMutate(action: "attach" | "remove", tag: string): void;
}) {
  return (
    <section
      aria-labelledby="bulk-heading"
      class="sticky bottom-sm grid gap-sm rounded-lg border border-line bg-surface/95 p-md shadow-popover"
    >
      <div>
        <h2 id="bulk-heading" class="m-0 text-body">
          Edit selected photos
        </h2>
        <p class="m-0 text-sm text-muted">{selectedCount} selected</p>
      </div>
      <form
        class="flex flex-wrap gap-xs"
        on:submit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const tag = String(new FormData(form).get("tag") ?? "");
          const submitter = event.submitter;
          onMutate(
            submitter instanceof HTMLButtonElement && submitter.value === "remove"
              ? "remove"
              : "attach",
            tag,
          );
        }}
      >
        <label class="grid min-w-[min(100%,16rem)] flex-1 gap-3xs text-sm font-semibold">
          Human tag
          <input
            class="min-h-control rounded-md border border-line-strong bg-surface px-sm"
            name="tag"
            required
            maxlength={64}
          />
        </label>
        <button
          class="min-h-control self-end rounded-md bg-accent px-md font-semibold text-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
          disabled={computed(() => disabled.value || selectedCount.value === 0)}
          name="action"
          value="attach"
        >
          Attach human tag
        </button>
        <button
          class="min-h-control self-end rounded-md border border-line-strong px-md font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          disabled={computed(() => disabled.value || selectedCount.value === 0)}
          name="action"
          value="remove"
        >
          Remove human tag
        </button>
      </form>
    </section>
  );
}

function SearchResults({
  query,
  results,
  degradedReason,
  selected,
  writesEnabled,
  client,
  onSelect,
  onRemoveTag,
  onShowRelated,
}: {
  query: ReadonlySignal<string>;
  results: ReadonlySignal<SearchResult[]>;
  degradedReason: ReadonlySignal<string | null>;
  selected: ReadonlySignal<Set<string>>;
  writesEnabled: ReadonlySignal<boolean>;
  client: PhotoLibraryClient;
  onSelect(id: string): void;
  onRemoveTag(id: string, tag: string): void;
  onShowRelated(photo: PhotoSummary): void;
}) {
  const sections: { tier: SearchTier; heading: string; empty: string }[] = [
    { tier: "exact_human_tag", heading: "Human tag", empty: "No exact human-tag matches." },
    { tier: "exact_ai_word", heading: "AI word", empty: "No exact AI-word matches." },
    { tier: "semantic", heading: "Related", empty: "No related matches." },
  ];
  return (
    <section aria-label={computed(() => `Search results for ${query.value}`)} class="grid gap-xl">
      {sections.map((section) => {
        const tierResults = computed(() =>
          results.value.filter((result) => result.reason.tier === section.tier),
        );
        return (
          <section aria-labelledby={`results-${section.tier}`} class="grid gap-sm">
            <h2 id={`results-${section.tier}`} class="m-0 text-title">
              {section.heading}
            </h2>
            <Show
              when={computed(() => section.tier === "semantic" && !!degradedReason.value)}
              children={() => (
                <StatusBanner tone="warning">
                  Related results are incomplete: {degradedReason}
                </StatusBanner>
              )}
            />
            <Show
              when={computed(() => tierResults.value.length === 0)}
              children={() => <EmptyState>{section.empty}</EmptyState>}
              fallback={() => (
                <>
                  <p class="m-0 text-sm text-muted">
                    {computed(() => (tierResults.value[0] ? reasonText(tierResults.value[0]) : ""))}
                  </p>
                  <PhotoGrid
                    photos={computed(() => tierResults.value.map((result) => result.photo))}
                    selected={selected}
                    writesEnabled={writesEnabled}
                    client={client}
                    onSelect={onSelect}
                    onRemoveTag={onRemoveTag}
                    onShowRelated={onShowRelated}
                  />
                </>
              )}
            />
          </section>
        );
      })}
    </section>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <p class="m-0 rounded-lg border border-dashed border-line-strong bg-sunken p-lg text-center text-muted">
      {children}
    </p>
  );
}

function reasonText(result: SearchResult): string {
  if (result.reason.tier === "exact_human_tag")
    return `Matched human tag “${result.reason.normalizedTag}”.`;
  if (result.reason.tier === "exact_ai_word")
    return `Matched AI suggested word “${result.reason.normalizedWord}”.`;
  return `Related by description · score ${result.reason.score.toFixed(2)}.`;
}

function applyMutationResult(
  photo: PhotoSummary,
  results: BulkHumanTagMutationResult[],
): PhotoSummary {
  const result = results.find((candidate) => candidate.photoId === photo.id);
  return result?.humanTags && result.documentRevision
    ? { ...photo, humanTags: result.humanTags, documentRevision: result.documentRevision }
    : photo;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected request error";
}
