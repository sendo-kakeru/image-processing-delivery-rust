import { Hono } from "hono";
import { matchCache, putCache } from "./cache";
import { fetchFromOrigin } from "./origin";

type Bindings = {
	ORIGIN_URL: string;
	IMAGE_STORE: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

// 最大ファイルサイズ: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * パスから key を抽出する。
 */
function extractKeyFromPath(path: string): string | null {
	const key = path.replace(/^\/images\//, "");
	return key || null;
}

/**
 * key の妥当性を検証する（パストラバーサル対策）。
 */
function validateKey(key: string): boolean {
	// 空文字、パストラバーサルパターンを拒否
	if (!key || key.includes("..") || key.startsWith("/") || key.includes("//")) {
		return false;
	}
	// 許可する文字セットのみ（英数字、ハイフン、アンダースコア、スラッシュ、ピリオド）
	const safePattern = /^[a-zA-Z0-9\-_\/.]+$/;
	return safePattern.test(key);
}

/**
 * ファイル内容から実際の MIME タイプを検証する。
 */
function detectMimeType(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer.slice(0, 16));

	// JPEG
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	// PNG
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return "image/png";
	}
	// GIF
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return "image/gif";
	}
	// WebP
	if (
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return "image/webp";
	}
	// AVIF (ISO Base Media File Format)
	// ftyp box (bytes 4-7) + major brand "avif" or "avis" (bytes 8-11)
	if (
		bytes[4] === 0x66 && // 'f'
		bytes[5] === 0x74 && // 't'
		bytes[6] === 0x79 && // 'y'
		bytes[7] === 0x70 && // 'p'
		((bytes[8] === 0x61 && // 'a'
			bytes[9] === 0x76 && // 'v'
			bytes[10] === 0x69 && // 'i'
			bytes[11] === 0x66) || // 'f' (avif)
			(bytes[8] === 0x61 && // 'a'
				bytes[9] === 0x76 && // 'v'
				bytes[10] === 0x69 && // 'i'
				bytes[11] === 0x73)) // 's' (avis)
	) {
		return "image/avif";
	}

	// 許可されていない形式は拒否
	throw new Error("Unsupported file type");
}

/**
 * GET /images/:key
 * 画像を取得する（キャッシュ → オリジン → キャッシュ保存）
 */
app.get("/images/*", async (c) => {
	// パスから key を取得（/images/ 以降）
	const key = extractKeyFromPath(c.req.path);

	if (!key || !validateKey(key)) {
		return c.json({ error: "Invalid key format" }, 400);
	}

	// クエリパラメータを取得
	const url = new URL(c.req.url);
	const params = url.searchParams;

	// キャッシュチェック
	const cached = await matchCache(c.req.raw);
	if (cached) {
		const headers = new Headers(cached.headers);
		headers.set("X-Cache", "HIT");
		return new Response(cached.body, {
			status: cached.status,
			statusText: cached.statusText,
			headers,
		});
	}

	// オリジンから取得
	const originUrl = c.env.ORIGIN_URL;
	const originResponse = await fetchFromOrigin(originUrl, key, params);

	// レスポンスをクローンしてキャッシュ用と返却用に分ける
	const cacheableResponse = originResponse.clone();

	// X-Cache ヘッダーを追加した新しいレスポンスを作成
	const response = new Response(originResponse.body, {
		status: originResponse.status,
		statusText: originResponse.statusText,
		headers: new Headers(originResponse.headers),
	});
	response.headers.set("X-Cache", "MISS");

	// キャッシュに保存（非同期、待たない）
	if (originResponse.ok) {
		c.executionCtx.waitUntil(putCache(c.req.raw, cacheableResponse));
	}

	return response;
});

/**
 * PUT /images/:key
 * R2 に画像を直接アップロード（動作確認用）
 */
app.put("/images/*", async (c) => {
	const key = extractKeyFromPath(c.req.path);

	if (!key || !validateKey(key)) {
		return c.json({ error: "Invalid key format" }, 400);
	}

	// ファイルサイズ制限チェック（Content-Length ヘッダー）
	const contentLength = c.req.header("Content-Length");
	if (contentLength && Number.parseInt(contentLength, 10) > MAX_FILE_SIZE) {
		return c.json(
			{
				error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
			},
			413,
		);
	}

	try {
		const body = await c.req.arrayBuffer();

		// 実際のサイズも検証
		if (body.byteLength > MAX_FILE_SIZE) {
			return c.json(
				{
					error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
				},
				413,
			);
		}

		// ファイル内容から MIME タイプを検証
		const contentType = detectMimeType(body);

		await c.env.IMAGE_STORE.put(key, body, {
			httpMetadata: { contentType },
		});

		return c.json({ success: true, key }, 201);
	} catch (error) {
		// クライアント起因のエラーとサーバーエラーを判別し、適切なステータスコードを返す
		if (
			error instanceof Error &&
			error.message &&
			error.message.includes("Unsupported file type")
		) {
			return c.json({ error: "Unsupported media type" }, 415);
		}

		// それ以外の予期しないエラーは 500 とし、内部情報は返さない
		return c.json({ error: "Internal server error" }, 500);
	}
});

/**
 * ヘルスチェック
 */
app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

export default app;
