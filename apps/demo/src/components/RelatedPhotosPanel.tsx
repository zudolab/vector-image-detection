import {
  computed,
  For,
  getScope,
  Show,
  signal,
  type ReadonlySignal,
  type Ref,
} from "@takazudo/zfb/zudo-react";
import {
  ApiClientError,
  fetchPhotoDetail,
  type PhotoLibraryClient,
} from "../lib/photo-library-client";
import type { RelatedPhotoResult, RelatedPhotosResponse } from "../worker/contracts/api";
import type { PhotoSummary } from "../worker/contracts/domain";
import { StatusBanner } from "./StatusBanner";

/**
 * `not_indexed` mirrors the contract's `vector_pending` degradation and is
 * transient (Vectorize is eventually consistent), so it must never be styled
 * or worded as an outage — `provider_unavailable` is the outage.
 */
type RelatedListStatus = "loading" | "ready" | "not_indexed" | "provider_unavailable" | "error";

interface RelatedListState {
  status: RelatedListStatus;
  items: RelatedPhotoResult[];
  message: string | null;
}

const loadingState: RelatedListState = { status: "loading", items: [], message: null };

/** Mirrors `--breakpoint-wide` in `styles/global.css`, where this panel stops
 * stacking under the gallery and becomes a sticky aside beside it. */
const WIDE_BREAKPOINT = "68rem";

/** The source photo's AI caption, which explains what the neighbours matched on. */
type CaptionState =
  { status: "loading" } | { status: "ready"; caption: string | null } | { status: "unavailable" };

export function RelatedPhotosPanel({
  photo,
  client,
  onClose,
  onOpenRelated,
}: {
  photo: ReadonlySignal<PhotoSummary>;
  client: PhotoLibraryClient;
  onClose(): void;
  onOpenRelated(photo: PhotoSummary): void;
}) {
  const scope = getScope();
  const state = signal<RelatedListState>(loadingState);
  const caption = signal<CaptionState>({ status: "loading" });
  const panelRef: Ref<HTMLElement> = { current: null };
  // Signals suppress equal writes; a computed ID still invalidates on tag updates.
  const photoId = signal(photo.value.id);
  scope.effect(() => {
    photoId.value = photo.value.id;
  });

  // Declared before the focus effect below so it captures the opener while it
  // is still the active element. Closing the panel only unmounts the focused
  // node, which drops focus to <body>; in the stacked layout the panel sits
  // after the entire gallery, so that strands a keyboard user at the gallery
  // bottom, far from the card they opened. Focus without `preventScroll` also
  // brings the originating card back into view.
  scope.onActivate(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  });

  scope.effect(() => {
    const id = photoId.value;
    const controller = new AbortController();
    // Request token as well as the abort: a superseded response must be
    // discarded even when the client ignores the signal.
    let current = true;
    state.value = loadingState;
    caption.value = { status: "loading" };

    void client.relatedPhotos(id, controller.signal).then(
      (response) => {
        if (current) state.value = listStateFor(response);
      },
      (error: unknown) => {
        if (current && !isAbort(error))
          state.value = { status: "error", items: [], message: errorMessageFor(error) };
      },
    );

    // No signal: `fetchPhotoDetail` shares one in-flight request across every
    // caller for this photo, so aborting here would cancel the gallery card's
    // read too. The `current` token above is what discards a superseded response.
    void fetchPhotoDetail(client, id).then(
      (photoDetail) => {
        if (current) caption.value = { status: "ready", caption: photoDetail.aiCaption };
      },
      (error: unknown) => {
        // The AI description is context, not the payload — a failure must leave
        // a terminal note rather than an endless placeholder, and must never
        // hide the neighbours that did load.
        if (current && !isAbort(error)) caption.value = { status: "unavailable" };
      },
    );

    return () => {
      current = false;
      controller.abort();
    };
  });

  // Focus only on open / photo change — not when the list settles below, which
  // would steal focus back from anywhere the user moved it while waiting.
  scope.effect(() => {
    void photoId.value;
    panelRef.current?.focus({ preventScroll: true });
  });

  // Below the `wide` breakpoint the panel stacks after the whole gallery, so
  // opening it without moving the viewport reads as a dead click.
  const listSettled = signal(false);
  scope.effect(() => {
    listSettled.value = state.value.status !== "loading";
  });
  scope.effect(() => {
    void photoId.value;
    void listSettled.value;
    // Only scroll in the stacked layout — at `wide` and up the panel is a
    // sticky aside already beside the gallery, so scrolling to it just yanks
    // the page. `block: "start"` rather than `"nearest"`: nearest is the
    // *minimum* scroll, and the minimum leaves the panel under the sticky
    // BulkTagBar, which is exactly the dead-click this effect exists to avoid.
    if (window.matchMedia?.(`(min-width: ${WIDE_BREAKPOINT})`).matches) return;
    // Re-run once the list settles. The mount-time scroll happens while the
    // panel is still a one-line "Finding photos…" box, so the document is
    // shorter than it will be and the browser clamps the scroll to the
    // then-current maximum. The list then arrives, the document grows, and the
    // clamped position is never revisited — leaving most of the list below the
    // fold. The panel is always the last flow content, so this clamp would
    // otherwise happen on essentially every open.
    panelRef.current?.scrollIntoView?.({ block: "start" });
  });

  return (
    <aside
      ref={panelRef}
      tabindex={-1}
      class="flex flex-col gap-md rounded-lg border border-line bg-surface p-md wide:sticky wide:top-md wide:max-h-panel-viewport wide:overflow-y-auto wide:overscroll-contain"
      aria-labelledby="related-heading"
      aria-busy={computed(() => state.value.status === "loading")}
      data-related-state={computed(() => state.value.status)}
    >
      <header class="flex items-start justify-between gap-xs">
        <div>
          <h2 id="related-heading" class="m-0 text-body font-semibold">
            Related by AI description
          </h2>
          <p class="mt-3xs mb-0 text-xs text-muted">
            Photos whose AI caption, AI words, and human tags read closest to this one. The library
            never compares the images themselves.
          </p>
        </div>
        <button
          type="button"
          class="grid min-h-control min-w-control shrink-0 cursor-pointer place-items-center rounded-md border border-line bg-surface text-muted icon-button"
          aria-label="Close the related photos panel"
          on:click={onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <div class="flex items-start gap-sm border-b border-line pb-md">
        <img
          class="aspect-square h-auto w-thumb-lg rounded-sm bg-sunken object-cover"
          src={computed(() => photo.value.mediaUrl)}
          alt=""
          width={computed(() => photo.value.width)}
          height={computed(() => photo.value.height)}
          decoding="async"
        />
        <p class="m-0 min-w-0 text-xs text-muted">
          <span class="block font-semibold text-ink">This photo&rsquo;s AI description</span>
          {computed(() => captionText(caption.value))}
        </p>
      </div>

      <div class="grid gap-sm" aria-live="polite">
        <Show when={computed(() => state.value.status === "loading")}>
          {() => (
            <p class="m-0 text-sm text-muted">Finding photos with related descriptions&hellip;</p>
          )}
        </Show>
        <Show when={computed(() => state.value.status === "not_indexed")}>
          {() => (
            <StatusBanner tone="info">
              <strong>Not indexed yet.</strong> This photo&rsquo;s AI description has not reached
              the search index. That normally takes a few seconds after processing — reopen this
              panel shortly.
            </StatusBanner>
          )}
        </Show>
        <Show when={computed(() => state.value.status === "provider_unavailable")}>
          {() => (
            <StatusBanner tone="warning">
              <strong>Related photos are unavailable right now.</strong> The vector index could not
              be reached, so this list is incomplete. Nothing is wrong with this photo.
            </StatusBanner>
          )}
        </Show>
        <Show when={computed(() => state.value.status === "error")}>
          {() => <StatusBanner tone="error">{computed(() => state.value.message)}</StatusBanner>}
        </Show>
        <Show
          when={computed(() => state.value.status === "ready" && state.value.items.length === 0)}
        >
          {() => (
            <p class="m-0 rounded-md border border-dashed border-line-strong bg-sunken p-md text-center text-sm text-muted">
              No related photos. Nothing else in the library has a close enough AI description.
            </p>
          )}
        </Show>
        <Show when={computed(() => state.value.items.length > 0)}>
          {() => (
            <ol class="m-0 flex list-none flex-col gap-xs p-0">
              <For each={computed(() => state.value.items)} by={(result) => result.photo.id}>
                {(result) => <RelatedRow result={result} onOpenRelated={onOpenRelated} />}
              </For>
            </ol>
          )}
        </Show>
      </div>
    </aside>
  );
}

function RelatedRow({
  result,
  onOpenRelated,
}: {
  result: ReadonlySignal<RelatedPhotoResult>;
  onOpenRelated(photo: PhotoSummary): void;
}) {
  const label = computed(() => photoLabel(result.value.photo));
  return (
    <li>
      <button
        type="button"
        class="grid-related-row grid min-h-control w-full cursor-pointer items-center gap-xs rounded-sm border-0 bg-transparent p-3xs text-start active:bg-sunken"
        aria-label={computed(() => `Show photos related to ${label.value}`)}
        on:click={() => onOpenRelated(result.value.photo)}
      >
        <img
          class="aspect-square h-auto w-thumb-sm rounded-sm bg-sunken object-cover"
          src={computed(() => result.value.photo.mediaUrl)}
          alt=""
          width={computed(() => result.value.photo.width)}
          height={computed(() => result.value.photo.height)}
          loading="lazy"
          decoding="async"
        />
        <span class="min-w-0 truncate text-xs">{label}</span>
        <span class="text-end text-xs text-muted tabular-nums" title="Description match score">
          {computed(() => result.value.reason.score.toFixed(2))}
        </span>
      </button>
    </li>
  );
}

function listStateFor(response: RelatedPhotosResponse): RelatedListState {
  // A degraded response with an unrecognised reason is treated as an outage,
  // never as the transient "not indexed yet" — overstating recoverability is
  // the worse failure.
  const status: RelatedListStatus = !response.degraded
    ? "ready"
    : response.degradedReason === "vector_pending"
      ? "not_indexed"
      : "provider_unavailable";
  return { status, items: response.items, message: null };
}

function captionText(caption: CaptionState): string {
  if (caption.status === "loading") return "Loading the AI description…";
  if (caption.status === "unavailable") return "The AI description could not be loaded.";
  return caption.caption ?? "No AI description stored yet.";
}

function photoLabel(photo: PhotoSummary): string {
  const words = photo.aiWords.slice(0, 3).map((word) => word.word);
  if (words.length > 0) return words.join(", ");
  const tags = photo.humanTags.slice(0, 3).map((tag) => tag.name);
  if (tags.length > 0) return tags.join(", ");
  return `photo ${photo.id}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessageFor(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 404)
    return "This photo is no longer available, so it has no related photos.";
  const detail = error instanceof Error ? error.message : "Unexpected request error";
  return `Related photos could not be loaded: ${detail}`;
}
