import { HTTPException } from "hono/http-exception";

// タイムアウト時間（ミリ秒）
const ORIGIN_TIMEOUT_MS = 30000; // 30秒

/**
 * Cloud Run (オリジンサーバー) にリクエストを転送する。
 */
export async function fetchFromOrigin(
	originUrl: string,
	key: string,
	params: URLSearchParams,
): Promise<Response> {
	// key をエンコード（URL セーフに）し、スラッシュは維持
	const encodedKey = encodeURIComponent(key).replace(/%2F/g, "/");

	const transformUrl = new URL(`/transform/${encodedKey}`, originUrl);
	transformUrl.search = params.toString();

	// 最終的な URL が期待されるオリジンと一致するか検証（SSRF対策）
	const expectedOrigin = new URL(originUrl).origin;
	if (transformUrl.origin !== expectedOrigin) {
		throw new HTTPException(400, { message: "Invalid origin URL" });
	}

	try {
		const response = await fetch(transformUrl.toString(), {
			method: "GET",
			// Cloud Run のタイムアウトは最大60秒だが、
			// Workers 側は30秒でタイムアウトさせる
			signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
		});

		// オリジンサーバーからのレスポンスをそのまま返す
		return response;
	} catch (error) {
		// タイムアウトやネットワークエラーの場合
		if (error instanceof Error) {
			if (error.name === "TimeoutError") {
				throw new HTTPException(504, { message: "Gateway Timeout" });
			}
		}

		// その他のエラー
		throw new HTTPException(502, { message: "Bad Gateway" });
	}
}
