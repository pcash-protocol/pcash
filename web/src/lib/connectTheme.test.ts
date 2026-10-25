import { cssObjectFromTheme, cssStringFromTheme } from "@rainbow-me/rainbowkit";
import { describe, expect, it } from "vitest";
import { connectTheme } from "./connectTheme.ts";

describe("connect dialog theme", () => {
  it("survives RainbowKit's serializer unchanged", () => {
    const css = cssStringFromTheme(connectTheme);
    for (const [name, value] of Object.entries(cssObjectFromTheme(connectTheme))) expect(css, name).toContain(`${name}:${value};`);
  });
});
