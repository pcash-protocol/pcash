import type { useNativeActivity } from "../lib/useNativeActivity.ts";

type History = Pick<ReturnType<typeof useNativeActivity>, "activity" | "failed" | "checking" | "retry">;

export function NativeActivityNotice({ history }: { history: History }) {
  if (!history.failed) return null;
  return <p role="status">
    {history.activity?.state === "ready"
      ? "Payment history couldn’t refresh. Showing last known payment history. "
      : "Payment history is unavailable. "}
    <button type="button" disabled={history.checking} onClick={history.retry}>Retry history</button>
  </p>;
}
