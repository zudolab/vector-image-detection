import {
  computed,
  For,
  getScope,
  Show,
  signal,
  type ReadonlySignal,
  type Ref,
} from "@takazudo/zfb/zudo-react";
import { fetchPhotoDetail, type PhotoLibraryClient } from "../lib/photo-library-client";
import type { PhotoSummary } from "../worker/contracts/domain";

export function PhotoCard({
  photo,
  selected,
  disabled,
  client,
  onSelect,
  onRemoveTag,
  onShowRelated,
}: {
  photo: ReadonlySignal<PhotoSummary>;
  selected: ReadonlySignal<boolean>;
  disabled: ReadonlySignal<boolean>;
  client: PhotoLibraryClient;
  onSelect(photoId: string): void;
  onRemoveTag(photoId: string, tag: string): void;
  onShowRelated(photo: PhotoSummary): void;
}) {
  const scope = getScope();
  const caption = signal<string | null>(null);
  const articleRef: Ref<HTMLElement> = { current: null };
  // Signals suppress equal writes; a computed ID still invalidates on tag updates.
  const photoId = signal(photo.value.id);
  scope.effect(() => {
    photoId.value = photo.value.id;
  });
  const checked = signal(selected.value);
  scope.effect(() => {
    checked.value = selected.value;
  });

  scope.effect(() => {
    const id = photoId.value;
    let active = true;
    caption.value = null;

    const loadCaption = () => {
      fetchPhotoDetail(client, id)
        .then((detail) => {
          if (active) caption.value = detail.aiCaption;
        })
        .catch(() => {
          // Caption is an enhancement, not core gallery functionality — a
          // failed detail fetch just leaves the card without one.
        });
    };

    // A gallery page can render up to 100 cards at once; fetching every
    // card's detail on mount would turn one page load into 100 detail
    // requests. Defer off-screen cards until they approach the viewport.
    // Environments without IntersectionObserver load captions immediately.
    if (typeof IntersectionObserver === "undefined" || !articleRef.current) {
      loadCaption();
      return () => {
        active = false;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadCaption();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(articleRef.current);

    return () => {
      active = false;
      observer.disconnect();
    };
  });

  return (
    <article
      ref={articleRef}
      class={computed(
        () =>
          `min-w-0 overflow-hidden rounded-lg border bg-surface ${selected.value ? "border-accent shadow-selected" : "border-line"}`,
      )}
    >
      <div class="relative aspect-[4/3] bg-sunken">
        <img
          class="h-full w-full object-cover"
          src={computed(() => photo.value.mediaUrl)}
          alt="Uploaded library photo"
          width={computed(() => photo.value.width)}
          height={computed(() => photo.value.height)}
          loading="lazy"
        />
        <label class="absolute top-xs left-xs flex min-h-control min-w-control cursor-pointer items-center justify-center rounded-md bg-surface/95 px-sm font-semibold">
          <input
            class="mr-xs size-md accent-accent"
            type="checkbox"
            modelChecked={checked}
            on:change={() => onSelect(photo.value.id)}
            aria-label={computed(() => `Select photo ${photo.value.id}`)}
          />
          Select
        </label>
      </div>
      <div class="grid gap-md p-md">
        <Show when={computed(() => Boolean(caption.value))}>
          {() => (
            <div>
              <h3 class="m-0 text-sm font-semibold">AI description</h3>
              <p class="mt-xs mb-0 text-sm text-ink">{caption}</p>
            </div>
          )}
        </Show>
        <button
          type="button"
          class="min-h-control photo-related-button rounded-md border border-line-strong px-sm text-sm font-semibold"
          aria-label={computed(
            () => `Show photos related to photo ${photo.value.id} by AI description`,
          )}
          on:click={() => onShowRelated(photo.value)}
        >
          Related by AI description
        </button>
        <div>
          <h3 class="m-0 text-sm font-semibold">AI suggested words</h3>
          <div class="mt-xs flex flex-wrap gap-xs" aria-label="AI suggested words">
            <Show
              when={computed(() => photo.value.aiWords.length > 0)}
              fallback={() => <span class="text-sm text-muted">No AI words yet</span>}
            >
              {() => (
                <For
                  each={computed(() => photo.value.aiWords)}
                  by={(word) => `${word.modelRunId}:${word.normalizedWord}`}
                >
                  {(word) => (
                    <span class="rounded-pill border border-ai-line bg-ai-soft px-sm py-3xs text-xs text-ai-ink">
                      AI · {computed(() => word.value.word)}
                    </span>
                  )}
                </For>
              )}
            </Show>
          </div>
        </div>
        <div>
          <h3 class="m-0 text-sm font-semibold">Human tags</h3>
          <div class="mt-xs flex flex-wrap gap-xs" aria-label="Human tags">
            <Show
              when={computed(() => photo.value.humanTags.length > 0)}
              fallback={() => <span class="text-sm text-muted">No human tags</span>}
            >
              {() => (
                <For each={computed(() => photo.value.humanTags)} by={(tag) => tag.id}>
                  {(tag) => (
                    <span class="inline-flex min-h-control items-center rounded-pill border border-human-line bg-human-soft pl-sm text-xs text-human-ink">
                      Human · {computed(() => tag.value.name)}
                      <button
                        type="button"
                        class="ml-3xs min-h-control min-w-control rounded-pill font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2"
                        disabled={disabled}
                        on:click={() => onRemoveTag(photo.value.id, tag.value.name)}
                        aria-label={computed(
                          () => `Remove human tag ${tag.value.name} from photo ${photo.value.id}`,
                        )}
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
              )}
            </Show>
          </div>
        </div>
        <Show when={computed(() => Boolean(photo.value.attribution))}>
          {() => (
            <p class="m-0 text-xs text-muted">
              Source:{" "}
              <Show
                when={computed(() => Boolean(photo.value.attribution?.sourceUrl))}
                fallback={() =>
                  computed(() => photo.value.attribution?.authorName ?? "seed collection")
                }
              >
                {() => (
                  <a
                    class="underline"
                    href={computed(() => photo.value.attribution?.sourceUrl ?? "")}
                  >
                    {computed(() => photo.value.attribution?.authorName ?? "original source")}
                  </a>
                )}
              </Show>
              <Show when={computed(() => Boolean(photo.value.attribution?.licenseName))}>
                {() => (
                  <>
                    {" "}
                    ·{" "}
                    <Show
                      when={computed(() => Boolean(photo.value.attribution?.licenseUrl))}
                      fallback={() => computed(() => photo.value.attribution?.licenseName)}
                    >
                      {() => (
                        <a
                          class="underline"
                          href={computed(() => photo.value.attribution?.licenseUrl ?? "")}
                        >
                          {computed(() => photo.value.attribution?.licenseName)}
                        </a>
                      )}
                    </Show>
                  </>
                )}
              </Show>
            </p>
          )}
        </Show>
      </div>
    </article>
  );
}
