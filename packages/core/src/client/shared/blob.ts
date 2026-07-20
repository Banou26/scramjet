import { rewriteBlob, unrewriteBlob } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	// hide the origin from object urls from the page
	client.Proxy("URL.createObjectURL", {
		apply(ctx) {
			const url = ctx.call();
			if (url.startsWith("blob:")) {
				// MediaSource object urls must stay on the real creating origin.
				// The media engine resolves them natively and a service worker
				// cannot intercept MSE, so rewriting the origin would detach the
				// MediaSource from the video element and stall playback.
				if (client.box.instanceof(ctx.args[0], "MediaSource")) {
					ctx.return(url);
				} else {
					ctx.return(rewriteBlob(url, client.context, client.meta));
				}
			} else {
				ctx.return(url);
			}
		},
	});

	client.Proxy("URL.revokeObjectURL", {
		apply(ctx) {
			setTimeout(() => {
				// scramjet rewrites blob urls to pass through the service worker first
				// this is neccesary if rewrites need to be applied to the blob
				// the issue is that if you call revokeObjectURL immediately after using the blob
				// the service worker will not have had time to download the blob
				// for some reason this is not an issue natively
				// simple delay is enough
				// TODO: find a way to make this not necessary
				const url = String(ctx.args[0]);
				// Only unrewrite urls that were actually rewritten onto the
				// page origin. MediaSource object urls are left untouched by
				// createObjectURL and must be revoked as-is.
				if (url.startsWith("blob:" + client.meta.origin.origin)) {
					ctx.args[0] = unrewriteBlob(url, client.context, client.meta);
				}
				ctx.call();
			}, 1000);
			ctx.return(undefined);
		},
	});
}
