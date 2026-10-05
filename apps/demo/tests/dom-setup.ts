/// <reference lib="dom" />

import { beforeEach, vi } from "vitest";

/** Happy DOM does not calculate viewport intersections. Tests deliver them explicitly. */
class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  readonly disconnect = vi.fn(() => this.targets.clear());
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.scrollMargin = options?.scrollMargin ?? "0px";
    intersectionObservers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect() {
    const entries = [...this.targets].map((target): IntersectionObserverEntry => ({
      target,
      isIntersecting: true,
      intersectionRatio: 1,
      time: performance.now(),
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
    }));
    if (entries.length) this.callback(entries, this);
  }
}
export const intersectionObservers: TestIntersectionObserver[] = [];
export function intersectObservedElements() {
  for (const observer of intersectionObservers) observer.intersect();
}
beforeEach(() => {
  intersectionObservers.length = 0;
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});
