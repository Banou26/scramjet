import { basicTest, serverTest } from "../testcommon.ts";
// historical regressions

export default [
	// scramjet/core
	// introduced by: ?
	// fixed by: https://github.com/HeyPuter/browser.js/commit/1715a6aeb072284b58ce38f807f1b14f5151dd7a
	basicTest({
		name: "regression-1715-for-body-walk",
		js: `
            const a = {top: 1, parent: 2, location: 3, eval: 4};
            for (let x in a) {
                checkglobal(window[x]);
            }
            for (let x in a) checkglobal(window[x]);

            const b = ["top", "parent", "location", "eval"];
            for (const x of b) {
                checkglobal(window[x]);
            }
            for (const x of b) checkglobal(window[x]);
    `,
	}),

	// scramjet/core
	// introduced by: ?
	// fixed by: https://github.com/HeyPuter/browser.js/commit/ae35b473dd2cbb0b76d3098e9a748e296cedf425
	basicTest({
		name: "regression-ae35-optional-postmessage",
		js: `
        const messages = [];
        const fakeTarget = {
          postMessage: (msg) => messages.push(msg)
        };
        fakeTarget?.postMessage("test");
        assertEqual(messages.length, 1, "optional postMessage should work");

        const nullTarget = null;
        nullTarget?.postMessage("test");
        assertEqual(messages.length, 1, "null optional should not call");
      `,
	}),

	// scramjet/rewriter
	// tree would be culled if destructure_rewrites was off and a destructure happened
	// introduced by: ?
	// fixed by https://github.com/HeyPuter/browser.js/commit/09f823c9573f9cdd09bc94663a384ace9816fd4c
	// related issue: https://discord.com/channels/1259284248129437726/1457141828557078592
	basicTest({
		name: "regression-09f823c-rewriter-culled",
		js: `
			let [a, b] = (checkglobal(top), [0,1]);
			([b, c] = (checkglobal(top), [0,1]));
			let { d } = (checkglobal(top), ({a: 2}));
			({ d } = (checkglobal(top), ({a:1})));
		`,
	}),

	// scramjet/rewriter
	// crash on overlapping CleanFunction and importfn
	// TODO: this only happens when destructure_rewrites is on. harness does not let you set flags
	// introduced by: ?
	// fixed by https://github.com/HeyPuter/browser.js/commit/09f823c9573f9cdd09bc94663a384ace9816fd4c
	// related issue: https://discord.com/channels/1259284248129437726/1457141828557078592
	basicTest({
		name: "regression-09f823c-rewriter-crash",
		js: `
			()=>import("data:text/javascript,checkglobal(top)")
		`,
	}),

	// scramjet/html
	// module script metadata must stay in scramjet's reserved query params.
	// Leaking it as an upstream type=module query can make module graphs load twice.
	serverTest({
		name: "regression-module-script-query-does-not-leak",
		scramjetOnly: true,
		async start(server) {
			let depRequests = 0;
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<script type="importmap">
							{
								"imports": {
									"#dep": "/dep.js?real=1"
								}
							}
						</script>
						<link rel="modulepreload" crossorigin href="/dep.js?real=1">
						<script type="module" src="/mod.js?real=1"></script>
					`);
					return;
				}

				if (req.url?.startsWith("/mod.js")) {
					const url = new URL(req.url, "http://test.invalid");
					res.writeHead(200, { "Content-Type": "application/javascript" });
					if (url.searchParams.get("real") !== "1") {
						res.end(
							`window.fail("original module script query was not preserved")`
						);
					} else if (url.searchParams.has("type")) {
						res.end(
							`window.fail("scramjet module marker leaked upstream", { search: ${JSON.stringify(url.search)} })`
						);
					} else {
						res.end(`
							import "#dep";
							setTimeout(async () => {
								const depRequests = await fetch("/dep-count").then((res) => res.text());
								if (depRequests === "1") window.pass("module URLs canonicalized without leaking proxy metadata");
								else window.fail("modulepreload and import produced duplicate upstream requests", { depRequests });
							});
						`);
					}
					return;
				}

				if (req.url?.startsWith("/dep.js")) {
					depRequests++;
					const url = new URL(req.url, "http://test.invalid");
					res.writeHead(200, { "Content-Type": "application/javascript" });
					if (url.searchParams.get("real") !== "1") {
						res.end(
							`window.fail("original module dependency query was not preserved")`
						);
					} else if (url.searchParams.has("type")) {
						res.end(
							`window.fail("scramjet module marker leaked upstream from dependency", { search: ${JSON.stringify(url.search)} })`
						);
					} else {
						res.end(`export default 1;`);
					}
					return;
				}

				if (req.url === "/dep-count") {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end(String(depRequests));
					return;
				}

				res.writeHead(404);
				res.end("not found");
			});
		},
	}),

	serverTest({
		name: "regression-dash-xml-url-entities",
		scramjetOnly: true,
		async start(server, port) {
			server.on("request", (req, res) => {
				const url = new URL(req.url ?? "/", `http://localhost:${port}`);
				if (url.pathname === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<script>
							runTest(async () => {
								const source = await fetch("/manifest.mpd").then((response) => response.text());
								assert(!source.includes("%26amp%3B"), "XML entities leaked into the proxy URL");

								const xml = new DOMParser().parseFromString(source, "application/xml");
								assert(!xml.querySelector("parsererror"), "rewritten MPD is not valid XML");
								const bases = xml.querySelectorAll("BaseURL");
								assertEqual(
									bases[0].textContent,
									"http://localhost:${port}/cdn/?Policy=base&Key-Pair-Id=base-key&Signature=base-signature"
								);
								assertEqual(
									bases[1].textContent,
									"https://cdn.example/?token=custom-value"
								);

								const templates = xml.querySelectorAll("SegmentTemplate");
								const media = templates[0].getAttribute("media");
								const initialization = templates[0].getAttribute("initialization");
								assert(media.includes("/~/sj/"), "media template was not rewritten through Scramjet");
								assert(initialization.includes("/~/sj/"), "initialization URL was not rewritten through Scramjet");
								assert(media.includes("$Number%05d$"), "DASH number template was changed");
								const controlMedia = templates[1].getAttribute("media");
								assertEqual(controlMedia.charCodeAt(controlMedia.indexOf(",") + 2), 0xd);
								assertEqual(
									templates[2].getAttribute("media"),
									"data:text/plain,custom-value"
								);

								const requests = [
									[
										media.replace("$Number%05d$", "00001"),
										"/cdn/segment-00001.m4s",
										{ Policy: "media", "Key-Pair-Id": "media-key", Signature: "media-signature" },
									],
									[
										initialization,
										"/cdn/init.mp4",
										{ Policy: "init", "Key-Pair-Id": "init-key", Signature: "init-signature" },
									],
								];
								for (const [requestUrl, expectedPath, expectedQuery] of requests) {
									const observed = await fetch(requestUrl).then((response) =>
										response.json()
									);
									assertEqual(observed.path, expectedPath);
									assertDeepEqual(observed.keys, ["Policy", "Key-Pair-Id", "Signature"]);
									assertDeepEqual(observed.query, expectedQuery);
									assert(
										!observed.keys.some((key) => key.startsWith("amp;")),
										"XML entity prefix reached the server"
									);
								}

								pass("DASH XML URL entities decoded before rewriting");
							});
						</script>
					`);
					return;
				}

				if (url.pathname === "/manifest.mpd") {
					res.writeHead(200, { "Content-Type": "application/dash+xml" });
					res.end(`<!DOCTYPE MPD [<!ENTITY é "custom-value">]><MPD><BaseURL>http://localhost:${port}/cdn/?Policy=base&amp;Key-Pair-Id=base-key&amp;Signature=base-signature</BaseURL><Period><AdaptationSet><Representation><SegmentTemplate media="segment-$Number%05d$.m4s?Policy=media&amp;Key-Pair-Id=media-key&amp;Signature=media-signature" initialization="init.mp4?Policy=init&#38;Key-Pair-Id=init-key&#x26;Signature=init-signature"/></Representation><Representation><SegmentTemplate media="data:text/plain,a&#xD;b"/></Representation><Representation><BaseURL>https://cdn.example/?token=&é;</BaseURL><SegmentTemplate media="data:text/plain,&é;"/></Representation></AdaptationSet></Period></MPD>`);
					return;
				}

				if (
					url.pathname.startsWith("/cdn/segment-") ||
					url.pathname === "/cdn/init.mp4"
				) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						path: url.pathname,
						keys: [...url.searchParams.keys()],
						query: Object.fromEntries(url.searchParams.entries()),
					}));
					return;
				}

				res.writeHead(404);
				res.end("not found");
			});
		},
	}),

	// scramjet/core/rewriter
	// non-computed keys of a destructured objects were wrapped with $scramjet$prop, causing invalid syntax
	// fixed by https://github.com/HeyPuter/browser.js/commit/7d4be594f2c49a447252e0a520ff0e144bef28b2
	basicTest({
		name: "regression-09f823c-rewriter-destructure-invalid-syntax",
		autoPass: false,
		js: `
			({
				'0': a,
				1: b,
				2n: c,
				false: d,
			} = {
				'0': 1,
				1: 2,
				2n: 3,
				false: 4,
			});

			assertEqual(a, 1);
			assertEqual(b, 2);
			assertEqual(c, 3);
			assertEqual(d, 4);

			({ '0': location } = { '0': "javascript:checkglobal(top)" });
			({ 0: location } = { 0: "javascript:checkglobal(top)" });
			({ 0n: location } = { 0n: "javascript:checkglobal(top)" });
			({ false: location } = { false: "javascript:checkglobal(top)" });

			const {
				'0': e,
				1: f,
				2n: h,
				false: g,
			} = {
				'0': 1,
				1: 2,
				2n: 3,
				false: 4,
			};
			assertEqual(e, 1);
			assertEqual(f, 2);
			assertEqual(h, 3);
			assertEqual(g, 4);

			pass();
		`,
	}),

	// scramjet/core
	// History.prototype.pushState / replaceState used the proxy's closure `client`
	// instead of the client owning `ctx.this`, so a displaced call resolved the
	// relative URL against the wrong frame.
	// lead to youtube.com search breaking in chrome
	// fixed by https://github.com/HeyPuter/browser.js/commit/1b988b4b53fac31c6627fd011d13028b9daff78c
	serverTest({
		name: "regression-1b988b4-displaced-history-pushstate",
		scramjetOnly: true,
		async start(server) {
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<html>
						<head></head>
						<body>
							<script>
								runTest(async () => {
									const iframe = document.createElement('iframe');
									iframe.src = '/sub/page.html';
									document.body.appendChild(iframe);
									await new Promise((r) => iframe.addEventListener('load', r, { once: true }));

									// displaced call: parent's pushState proxy with iframe.history as \`this\`.
									// the relative URL must resolve against the iframe's URL (/sub/page.html),
									// not the parent's URL (/).
									history.pushState.call(iframe.contentWindow.history, {}, '', 'pushed');
									assertEqual(
										iframe.contentWindow.location.pathname,
										'/sub/pushed',
										"displaced pushState must resolve url against the target history's owning client"
									);

									history.replaceState.call(iframe.contentWindow.history, {}, '', 'replaced');
									assertEqual(
										iframe.contentWindow.location.pathname,
										'/sub/replaced',
										"displaced replaceState must resolve url against the target history's owning client"
									);

									pass();
								}, false);
							</script>
						</body>
						</html>
					`);
					return;
				}
				if (req.url === "/sub/page.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<!doctype html><html><head></head><body><p>iframe page</p></body></html>");
					return;
				}
				res.writeHead(404);
				res.end("not found");
			});
		},
	}),
];
