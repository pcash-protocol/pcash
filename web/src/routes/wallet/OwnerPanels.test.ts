import { describe, expect, it, vi } from "vitest";
import { invalidatePaymentReview } from "./OwnerPanels.tsx";

describe("payment review dismissal", () => {
  it("invalidates deferred review work before canceling an unsubmitted payment", () => {
    const reviewRequest = { current: 7 };
    const deferredRequest = reviewRequest.current;
    let continued = false;
    const continueDeferredPreflight = () => {
      if (reviewRequest.current === deferredRequest) continued = true;
    };
    const discardPaymentReview = vi.fn();
    const cancelPrivateSend = vi.fn(() => {
      expect(reviewRequest.current).toBe(8);
      expect(discardPaymentReview).toHaveBeenCalledOnce();
    });

    invalidatePaymentReview(reviewRequest, discardPaymentReview, cancelPrivateSend);
    continueDeferredPreflight();

    expect(cancelPrivateSend).toHaveBeenCalledOnce();
    expect(continued).toBe(false);
  });
});
