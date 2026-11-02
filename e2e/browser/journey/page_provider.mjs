export const PAGE_PROVIDER_CONTROL = "__pcashJourney";

/**
 * Return a self-contained script for Playwright context initialization.
 * Requests cross to Node through the bridge; the test key never enters the page.
 */
export function createInjectedProviderSource({ bridgeUrl }) {
  let normalizedUrl;
  try {
    const url = new URL(bridgeUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    normalizedUrl = url.href;
  } catch {
    throw new TypeError("bridgeUrl must be an absolute HTTP(S) URL");
  }

  return `(() => {
    "use strict";
    const bridgeUrl = ${JSON.stringify(normalizedUrl)};
    const supportedEvents = new Set(["accountsChanged", "chainChanged", "connect", "disconnect", "message"]);
    const listeners = new Map();

    function providerError(payload, fallbackMessage) {
      const error = new Error(
        payload && typeof payload.message === "string" ? payload.message : fallbackMessage
      );
      error.name = "ProviderRpcError";
      error.code = payload && Number.isInteger(payload.code) ? payload.code : -32603;
      if (payload && Object.prototype.hasOwnProperty.call(payload, "data")) error.data = payload.data;
      return error;
    }

    const provider = {
      isMetaMask: true,
      async request(args) {
        if (!args || typeof args !== "object" || typeof args.method !== "string") {
          throw providerError({ code: -32600, message: "invalid provider request" });
        }
        let response;
        try {
          response = await fetch(bridgeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(args),
          });
        } catch {
          throw providerError(undefined, "Injected provider bridge is unavailable.");
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw providerError(undefined, "Injected provider bridge returned invalid JSON.");
        }
        if (!response.ok || payload.error) {
          throw providerError(payload.error, "Injected provider bridge rejected the request.");
        }
        return payload.result;
      },
      on(event, listener) {
        if (!supportedEvents.has(event)) throw new TypeError("unsupported provider event " + event);
        if (typeof listener !== "function") throw new TypeError("listener must be a function");
        const eventListeners = listeners.get(event) || new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
        return provider;
      },
      removeListener(event, listener) {
        const eventListeners = listeners.get(event);
        if (eventListeners) eventListeners.delete(listener);
        return provider;
      },
    };

    Object.defineProperty(provider, ${JSON.stringify(PAGE_PROVIDER_CONTROL)}, {
      enumerable: false,
      configurable: false,
      writable: false,
      value: Object.freeze({
        emit(event, value) {
          if (!supportedEvents.has(event)) throw new TypeError("unsupported provider event " + event);
          const eventListeners = listeners.get(event);
          if (!eventListeners) return 0;
          const snapshot = Array.from(eventListeners);
          for (const listener of snapshot) listener(value);
          return snapshot.length;
        },
      }),
    });
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      enumerable: true,
      writable: false,
      value: provider,
    });

    // Announce over EIP-6963, the way every current wallet extension does. The
    // app discovers wallets this way and deliberately does not read
    // window.ethereum, so a double that only sets that property would be less
    // capable than any real wallet and would never appear in the picker.
    // RainbowKit additionally requires the icon to be a data: image URI.
    const info = Object.freeze({
      uuid: "11111111-2222-3333-4444-555555555555",
      name: "Journey Wallet",
      rdns: "dev.pcash.journey",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjNmVlN2I3Ii8+PC9zdmc+",
    });
    const announce = () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
      }));
    };
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  })();`;
}
