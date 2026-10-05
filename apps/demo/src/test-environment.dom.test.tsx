import { signal } from "@takazudo/zfb/zudo-react";
import { createIslandTest, type IslandTest } from "@takazudo/zfb/zudo-react/testing";
import { screen } from "@testing-library/dom";
import { afterEach, expect, it } from "vitest";

let island: IslandTest | undefined;
afterEach(() => island?.dispose());

it("hydrates the installed runtime and updates live DOM bindings", async () => {
  const readiness = signal("DOM ready");
  function TestReadiness() {
    return <output aria-label="test readiness">{readiness}</output>;
  }
  island = createIslandTest(TestReadiness, {}, { document });
  const serverOutput = screen.getByLabelText("test readiness");
  expect(serverOutput.textContent).toBe("DOM ready");
  expect(island.hydrate()).not.toBeNull();
  expect(island.diagnostics).toEqual([]);
  expect(screen.getByLabelText("test readiness")).toBe(serverOutput);
  readiness.value = "DOM hydrated";
  await island.flush();
  expect(serverOutput.textContent).toBe("DOM hydrated");
});

it("disposes listeners and reactive bindings across repeated island lifetimes", async () => {
  const label = signal("ready");
  let clicks = 0;
  function TestButton() {
    return (
      <button
        on:click={() => {
          clicks += 1;
        }}
      >
        {label}
      </button>
    );
  }
  for (let cycle = 0; cycle < 3; cycle += 1) {
    island = createIslandTest(TestButton, {}, { document });
    expect(island.hydrate()).not.toBeNull();
    const button = screen.getByRole("button");
    button.click();
    expect(clicks).toBe(cycle + 1);
    island.dispose();
    button.click();
    expect(clicks).toBe(cycle + 1);
    const oldText = button.textContent;
    label.value = `disposed ${cycle}`;
    await island.flush();
    expect(button.textContent).toBe(oldText);
    expect(screen.queryByRole("button")).toBeNull();
    expect(island.diagnostics).toEqual([]);
  }
});
