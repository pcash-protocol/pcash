import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hash } from "./ui.tsx";
import styles from "./ExplorerRoute.module.css";

const HASH = `0x${"ab".repeat(32)}`;
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("Hash", () => {
  it("shows a full hash in one piece with its exact value and a copy button", () => {
    const html = renderToStaticMarkup(<Hash value={HASH} />);
    expect(text(html)).toContain(HASH);
    expect(html).toContain(`title="${HASH}"`);
    expect(html).toContain('aria-label="Copy hash"');
    expect(html).not.toContain(styles.mono);
  });

  it("sets raw data such as public inputs in mono", () => {
    const html = renderToStaticMarkup(<Hash value={HASH} short mono />);
    expect(html).toContain(`class="${styles.hash} ${styles.mono}"`);
    expect(text(html)).not.toContain(HASH);
  });
});
