# Browser smoke test

Open `browser-smoke.html` in a browser or run it headlessly. A successful run adds `data-smoke="passed"` to the `<body>` element.

The test replaces network requests with deterministic in-browser responses. It verifies pre-login request blocking, operator-attributed session authentication, authenticated request headers, HTML and handler-value escaping, transactional stock RPC parameters, version-protected manual low-stock updates, quoted CSV parsing, CSV formula protection, validation, and stable-ID enforcement without accessing live inventory data.
