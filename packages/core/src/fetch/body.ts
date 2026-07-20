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
 * Rewrite <BaseURL> contents inside a DASH MPD manifest so media segments route
 * back through the proxy. Without this the player reads the raw <BaseURL>
 * (often a different CDN origin) and fetches segments directly, bypassing the
 * proxy and stalling on cross-origin requests. BaseURL may be relative or
 * absolute; relative ones resolve against the (already proxied) manifest URL.
 */
function rewriteMpd(
	mpd: string,
	context: ScramjetFetchHandler["context"],
	meta: ScramjetFetchParsed["meta"]
): string {
	return mpd.replace(
		/(<BaseURL>)([\s\S]*?)(<\/BaseURL>)/g,
		(match, open, url, close) => {
			const trimmed = url.trim();
			// leave protocol-relative-free schemes and empty entries alone
			if (!trimmed || /^(blob|data|urn):/.test(trimmed)) return match;
			return open + rewriteUrl(trimmed, context, meta) + close;
		}
	);
}

export async function rewriteBody(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	// DASH MPD manifests need their <BaseURL> rewritten regardless of how the
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
