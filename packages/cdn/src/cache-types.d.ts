/**
 * Cloudflare Workers の caches.default の型定義
 */
declare global {
	interface CacheStorage {
		default: Cache;
	}
}

export {};
