import { computed, type Child, type ReadonlySignal } from "@takazudo/zfb/zudo-react";

type Tone = "info" | "warning" | "error" | "success";

export function StatusBanner({
  tone,
  children,
}: {
  tone: Tone | ReadonlySignal<Tone>;
  children: Child;
}) {
  const tones = {
    info: "border-line bg-sunken text-ink",
    warning: "border-warning-line bg-warning-soft text-warning-ink",
    error: "border-danger-line bg-danger-soft text-danger-ink",
    success: "border-positive-line bg-positive-soft text-positive-ink",
  };
  const currentTone = computed(() => (typeof tone === "string" ? tone : tone.value));
  return (
    <div
      class={computed(() => `rounded-lg border px-md py-sm text-sm ${tones[currentTone.value]}`)}
      role={computed(() => (currentTone.value === "error" ? "alert" : "status"))}
    >
      {children}
    </div>
  );
}
