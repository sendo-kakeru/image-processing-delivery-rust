/**
 * キャッシュキーを生成する。
 * クエリパラメータをソートして正規化することで、
 * パラメータの順序が異なっても同じキャッシュにヒットするようにする。
 */
export function createCacheKey(url: URL): string {
	const params = new URLSearchParams(url.searchParams);
	// パラメータをソート（単純な文字列比較で高速化）
	const sortedParams = Array.from(params.entries()).sort(([a], [b]) => {
		if (a < b) return -1;
		if (a > b) return 1;
		return 0;
	});

	const normalized = new URL(url);
	normalized.search = "";
	for (const [key, value] of sortedParams) {
		normalized.searchParams.append(key, value);
	}

	return normalized.toString();
}

/**
 * Cache API からレスポンスを取得する。
 */
export async function matchCache(
	request: Request,
): Promise<Response | undefined> {
	const cache = caches.default;
	const cacheKey = createCacheKey(new URL(request.url));

	return await cache.match(cacheKey);
}

/**
 * Cache API にレスポンスを保存する。
 * Cache-Control ヘッダーがある場合のみキャッシュする。
 */
export async function putCache(
	request: Request,
	response: Response,
): Promise<void> {
	const cacheControl = response.headers.get("Cache-Control");
	if (!cacheControl) {
		return;
	}

	// Cache-Control によるキャッシュ禁止指示がある場合は保存しない
	const normalizedCacheControl = cacheControl.toLowerCase();
	if (
		normalizedCacheControl.includes("no-store") ||
		normalizedCacheControl.includes("private") ||
		/\bmax-age\s*=\s*0\b/.test(normalizedCacheControl)
	) {
		return;
	}

	const cache = caches.default;
	const cacheKey = createCacheKey(new URL(request.url));

	// レスポンスをクローンしてキャッシュに保存
	// （元のレスポンスは呼び出し元で使用される）
	await cache.put(cacheKey, response.clone());
}
