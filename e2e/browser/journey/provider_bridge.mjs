import { createServer } from "node:http";

const REQUEST_PATH = "/request";
const MAX_BODY_BYTES = 1_048_576;

function errorPayload(error) {
  if (typeof error !== "object" || error === null) {
    return { code: -32603, message: String(error) };
  }
  return {
    code: Number.isInteger(error.code) ? error.code : -32603,
    message: typeof error.message === "string" && error.message.length > 0
      ? error.message
      : "Injected provider request failed.",
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

function sendJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

async function requestBody(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("provider bridge request is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) throw new Error("provider bridge request body is empty");
  return JSON.parse(text);
}

/** Start the localhost bridge used by the page-side injected provider proxy. */
export async function startInjectedProviderBridge(provider, { host = "127.0.0.1" } = {}) {
  if (typeof provider?.request !== "function") {
    throw new TypeError("provider must expose request(args)");
  }
  if (typeof host !== "string" || host.length === 0) throw new TypeError("host must be a non-empty string");

  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== REQUEST_PATH) {
      sendJson(response, 404, { error: { code: -32601, message: "Provider bridge route not found." } });
      return;
    }

    let input;
    try {
      input = await requestBody(request);
    } catch (error) {
      sendJson(response, 400, { error: { code: -32700, message: errorPayload(error).message } });
      return;
    }

    try {
      sendJson(response, 200, { result: await provider.request(input) });
    } catch (error) {
      sendJson(response, 200, { error: errorPayload(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("injected provider bridge did not bind to a TCP port");
  }
  const urlHost = host.includes(":") ? `[${host}]` : host;
  let closed = false;
  return {
    url: `http://${urlHost}:${address.port}${REQUEST_PATH}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

