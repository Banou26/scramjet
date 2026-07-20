import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";
import {
	flagEnabled,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import { _TextDecoder } from "@/shared/snapshot";
import { rewriteUrl } from "@rewriters/url";

const DASH_MIME = "application/dash+xml";

/**
 * Rewrite DASH MPD manifests so media segment requests route back through the
 * proxy.
 *
 * Segment URLs are usually relative to <BaseURL>, often a different CDN origin
 * than the page. Rewriting <BaseURL> to a proxied URL breaks relative
 * resolution because the proxied URL carries the upstream URL as an opaque
 * encoded path segment that `new URL()` cannot resolve against: the player
 * would chop the encoded path and produce a broken URL.
 *
 * Instead we resolve each segment template against the *upstream* BaseURL to
 * form an absolute upstream URL (keeping $RepresentationID$ / $Number$ /
 * $Time$ template variables intact), then rewrite that absolute URL to its
 * proxied form. The player substitutes variables into the already-absolute
 * proxied template, yielding a ready-to-use proxied segment URL. BaseURL
 * elements are rewritten to the proxied base as well so any URL the player
 * resolves against them stays on the proxied CDN origin.
 */
function rewriteMpd(
	mpd: string,
	context: ScramjetFetchHandler["context"],
	meta: ScramjetFetchParsed["meta"]
): string {
	// The first <BaseURL> is the document base for relative resolution.
	const baseMatch = mpd.match(/<BaseURL>([\s\S]*?)<\/BaseURL>/);
	const upstreamBase = baseMatch ? baseMatch[1].trim() : meta.base.href;

	// Rewrite a URL or template that may contain $...$ variables. Resolve the
	// whole template against the upstream base (treating $vars as literal path
	// characters) to form an absolute upstream URL, then proxy it. The proxied
	// codec percent-encodes `$` to `%24` and `%` to `%25`, which would corrupt
	// DASH template variables ($Number%05d$ -> %24Number%2505d%24) so the player
	// could no longer recognize or substitute them. Restore both `%24` -> `$`
	// and `%25` -> `%` so the template syntax survives intact. The Crunchyroll
	// signed-token query (exp=...~acl=...~hmac=...) contains no `%` or `$`, so
	// this restore is safe here.
	const rewriteTemplate = (raw: string): string => {
		if (!raw || /^(blob|data|urn):/.test(raw)) return raw;
		try {
			const absolute = new URL(raw, upstreamBase).href;
			return rewriteUrl(absolute, context, meta)
				.replace(/%24/g, "$")
				.replace(/%25/g, "%");
		} catch {
			return raw;
		}
	};

	let out = mpd;

	// <BaseURL>...</BaseURL> -> proxied CDN base (absolute, no variables)
	out = out.replace(
		/(<BaseURL>)([\s\S]*?)(<\/BaseURL>)/g,
		(match, open, url, close) => {
			const trimmed = url.trim();
			if (!trimmed) return match;
			try {
				const absolute = new URL(trimmed, meta.base.href).href;
				return open + rewriteUrl(absolute, context, meta) + close;
			} catch {
				return match;
			}
		}
	);

	// initialization="..." and media="..." segment templates -> proxied absolute
	out = out.replace(
		/((?:initialization|media)=")([^"]+)(")/g,
		(match, pre, url, post) => pre + rewriteTemplate(url) + post
	);

	return out;
}

export async function rewriteBody(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	// DASH MPD manifests need their segment URLs rewritten regardless of how the
	// player fetched them (xhr/fetch have an empty destination).
	const contentType = response.headers.get("content-type") ?? "";
	if (
		contentType.toLowerCase().includes(DASH_MIME) ||
		parsed.url.pathname.endsWith(".mpd")
	) {
		return rewriteMpd(await response.text(), handler.context, parsed.meta);
	}

	switch (parsed.destination) {
		case "iframe":
		case "document":
			if (isHtmlMimeType(response.headers.get("content-type") ?? "")) {
				const buf = await response.arrayBuffer();
				const bytes = new Uint8Array(buf);
				const encoding = sniffEncoding(
					bytes,
					response.headers.get("content-type")
				);
				const htmlContent = new _TextDecoder(encoding).decode(bytes);

				return rewriteHtml(htmlContent, handler.context, parsed.meta, {
					loadScripts: true,
					inline: true,
					source: parsed.url.href,
					headers: response.rawHeaders,
					// reasonably confident that a document fetch is impossible without a client
					history: parsed.trackedClient!.history,
				});
			} else {
				return response.body;
			}
		case "script": {
			// do not attempt to rewrite a 404 response
			if (response.ok) {
				const ct = response.headers.get("content-type");
				// don't rewrite invalid module scripts when the server declares a non-JS type
				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}

				let rewritten = rewriteJs(
					new Uint8Array(await response.arrayBuffer()),
					response.url,
					handler.context,
					parsed.meta,
					parsed.isModule
				);

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (rewritten instanceof Uint8Array) {
						rewritten = new TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style":
			return rewriteCss(await response.text(), handler.context, parsed.meta);
		case "sharedworker":
		case "worker":
			return rewriteWorkers(
				new Uint8Array(await response.arrayBuffer()),
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
		default:
			return response.body;
	}
}
