import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLDER_HOST_MODE_FOLDER, FOLDER_HOST_MODE_GLOBAL } from "@wendoo/bridge-protocol";
import { buildAppHostHtml, buildAppLoadFailureHtml } from "./app-host-html";

const FAVICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2318181b'/%3E%3C/svg%3E";

const APP_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}" />
    <title>Target App</title>
    <script type="module" crossorigin src="./assets/index-abc123.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-def456.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const BASE_URI = "https://file%2B.vscode-resource.vscode-cdn.net/apps/dist";
const NONCE = "0123456789abcdef";

const options = {
  appIndexHtml: APP_INDEX_HTML,
  appBaseUri: BASE_URI,
  cspSource: "https://*.vscode-cdn.net",
  nonce: NONCE,
};

describe("buildAppHostHtml", () => {
  it("injects csp, trailing-slash base, and bootstrap at the start of head, ahead of the first asset reference", () => {
    const html = buildAppHostHtml(options);
    const cspAt = html.indexOf('<meta http-equiv="Content-Security-Policy"');
    const baseAt = html.indexOf(`<base href="${BASE_URI}/">`);
    const bootstrapAt = html.indexOf(`<script nonce="${NONCE}">`);
    assert.notStrictEqual(cspAt, -1);
    assert.notStrictEqual(baseAt, -1);
    assert.notStrictEqual(bootstrapAt, -1);
    assert.ok(html.indexOf("<head>") < cspAt);
    assert.ok(cspAt < baseAt);
    assert.ok(baseAt < bootstrapAt);
    assert.ok(bootstrapAt < html.indexOf('<script type="module"'));
    assert.ok(baseAt < html.indexOf("./assets/"));
  });

  it("injects its base ahead of a base the app document declares, leaving the app's own base inert", () => {
    const appIndexHtml = APP_INDEX_HTML.replace("<head>", '<head>\n    <base href="/" />');
    const html = buildAppHostHtml({ ...options, appIndexHtml });
    const injectedAt = html.indexOf(`<base href="${BASE_URI}/">`);
    const declaredAt = html.indexOf('<base href="/" />');
    assert.notStrictEqual(injectedAt, -1);
    assert.notStrictEqual(declaredAt, -1);
    assert.ok(injectedAt < declaredAt);
  });

  it("keeps a base uri that already ends with a slash", () => {
    const html = buildAppHostHtml({ ...options, appBaseUri: `${BASE_URI}/` });
    assert.notStrictEqual(html.indexOf(`<base href="${BASE_URI}/">`), -1);
    assert.strictEqual(html.indexOf(`${BASE_URI}//`), -1);
  });

  it("defines the folder host-mode global in the nonce'd bootstrap", () => {
    const html = buildAppHostHtml(options);
    const bootstrap = html.slice(html.indexOf(`<script nonce="${NONCE}">`), html.indexOf("</script>"));
    assert.notStrictEqual(
      bootstrap.indexOf(
        `globalThis[${JSON.stringify(FOLDER_HOST_MODE_GLOBAL)}] = ${JSON.stringify(FOLDER_HOST_MODE_FOLDER)}`
      ),
      -1
    );
    assert.notStrictEqual(bootstrap.indexOf("acquireVsCodeApi()"), -1);
  });

  it("leaves the app document's content untouched, including the data-uri favicon", () => {
    const html = buildAppHostHtml(options);
    assert.notStrictEqual(html.indexOf(FAVICON_DATA_URI), -1);
    const injectionStart = html.indexOf('<meta http-equiv="Content-Security-Policy"');
    const injectionEnd = html.indexOf("</script>") + "</script>".length;
    assert.strictEqual(html.slice(0, injectionStart) + html.slice(injectionEnd), APP_INDEX_HTML);
  });

  it("prepends the injection when the document has no head", () => {
    const html = buildAppHostHtml({ ...options, appIndexHtml: "<body>bare</body>" });
    assert.ok(html.startsWith('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(html.endsWith("<body>bare</body>"));
  });

  it("authorizes the bootstrap by nonce and app subresources by source", () => {
    const html = buildAppHostHtml(options);
    const csp = html.match(/Content-Security-Policy" content="([^"]*)"/);
    assert.ok(csp);
    const directives = csp[1].split("; ");
    assert.ok(directives.includes("default-src 'none'"));
    assert.ok(directives.includes(`script-src 'nonce-${NONCE}' ${options.cspSource} https://cloud.umami.is`));
    assert.ok(directives.includes(`style-src ${options.cspSource} 'unsafe-inline'`));
    assert.ok(directives.includes(`img-src ${options.cspSource} blob: data:`));
    assert.ok(directives.includes(`font-src ${options.cspSource}`));
    assert.ok(directives.includes(`connect-src ${options.cspSource} https:`));
  });

  it("hosts the app without a nested frame or document navigation", () => {
    const html = buildAppHostHtml(options);
    assert.strictEqual(html.indexOf("<iframe"), -1);
    assert.strictEqual(html.indexOf("srcdoc"), -1);
    assert.strictEqual(html.indexOf("index.html"), -1);
  });
});

describe("buildAppLoadFailureHtml", () => {
  it("renders the failure message with markup escaped", () => {
    const page = buildAppLoadFailureHtml("Cannot read /tmp/<dist>&/index.html");
    assert.notStrictEqual(page.indexOf("Cannot read /tmp/&lt;dist&gt;&amp;/index.html"), -1);
    assert.strictEqual(page.indexOf("<dist>"), -1);
  });
});
