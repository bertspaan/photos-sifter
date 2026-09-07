/** Undocumented RPC formats derived from Google Photos Toolkit (MIT). See THIRD_PARTY_NOTICES.md.
 * This function runs in Google's page world. It must remain self-contained.
 * Credentials remain in that page. Only sanitized photo metadata returns to the app.
 */
/** @param {string} action @param {any} payload */
export async function googleRequest(action, payload) {
	try {
		const g = /** @type {any} */ (window).WIZ_global_data;
		if (!g || typeof g.oPEP7c !== 'string' || !g.oPEP7c || !g.SNlM0e)
			throw new Error('Sign in to Google Photos and reload its tab.');
		const account = g.oPEP7c;
		if (action === 'account') return { account };
		if (payload.account !== account)
			throw new Error('Google account changed. Reconnect before continuing.');
		/** @param {number} ms */
		const pause = (ms) => new Promise((r) => setTimeout(r, ms));
		/** @param {string} method @param {unknown} data @returns {Promise<any>} */
		async function rpc(method, data) {
			const path = g.eptZe;
			if (typeof path !== 'string' || !path.startsWith('/') || !path.includes('/PhotosUi/'))
				throw new Error('Google Photos changed its API path.');
			const url = new URL(path + 'data/batchexecute', location.origin);
			if (url.origin !== location.origin) throw new Error('Unexpected API origin.');
			url.search = new URLSearchParams({
				rpcids: method,
				'source-path': location.pathname,
				'f.sid': String(g.FdrFJe),
				bl: String(g.cfb2h),
				pageId: 'none',
				rt: 'c'
			}).toString();
			const response = await fetch(url, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
				body: new URLSearchParams({
					'f.req': JSON.stringify([[[method, JSON.stringify(data), null, 'generic']]]),
					at: g.SNlM0e
				}),
				signal: AbortSignal.timeout(45000)
			});
			if (!response.ok)
				throw new Error(
					'Google Photos returned HTTP ' + response.status + '. The operation was not retried.'
				);
			const text = await response.text();
			let found;
			for (const line of text.split('\n')) {
				if (!line.includes('wrb.fr')) continue;
				try {
					const parts = JSON.parse(line);
					for (const part of parts) {
						if (part[0] === 'wrb.fr' && part[1] === method) found = part[2];
					}
				} catch {}
			}
			if (typeof found !== 'string')
				throw new Error('Google Photos returned an unexpected response.');
			return JSON.parse(found);
		}
		/** @param {string[]} keys */
		async function metadata(keys) {
			const fields = Array(36).fill(null);
			fields[24] = [];
			fields[35] = [];
			const result = await rpc('EWgK9e', [[[keys.map((k) => [k])], [fields]]]);
			const rows = result?.[0]?.[1];
			if (!Array.isArray(rows)) throw new Error('Google Photos metadata format changed.');
			return new Map(
				rows.map((row) => [row[0], { filename: row?.[1]?.[3], bytes: row?.[1]?.[9] || 0 }])
			);
		}
		/** @param {any[]} row @param {{filename:string,bytes:number}|undefined} info */
		function parseRow(row, info) {
			if (typeof row?.[0] !== 'string' || !row[0] || typeof info?.filename !== 'string')
				throw new Error('A photo is missing its ID or filename; import paused.');
			const thumb = row?.[1]?.[0] || '';
			if (thumb && !/^https:\/\/lh\d+\.googleusercontent\.com\//.test(thumb))
				throw new Error('Unexpected preview address.');
			const flags = row.at(-1);
			return {
				mediaKey: row[0],
				dedupKey: row[3] || '',
				filename: info.filename,
				bytes: Number(info.bytes) || 0,
				thumb: thumb ? thumb + '=w1600-h1600' : '',
				timestamp: Number(row[2]) || 0,
				width: Number(row?.[1]?.[1]) || 0,
				height: Number(row?.[1]?.[2]) || 0,
				isOwned: Array.isArray(row[7]) && !row[7].some((a) => Array.isArray(a) && a.includes(27)),
				isVideo: !!flags?.[76647426]
			};
		}
		/** @param {string} key */
		async function detail(key) {
			const d = await rpc('VrseUb', [key, null, null, null, null]);
			if (d?.[0]?.[0] !== key) throw new Error('Photo identity could not be verified.');
			return d;
		}
		/** @param {any[][]} d */
		function isTrashed(d) {
			return d[0].some(
				(x) => x && typeof x === 'object' && !Array.isArray(x) && !!x[225032867]?.[0]
			);
		}
		if (action === 'page') {
			const query = typeof payload.query === 'string' ? payload.query : '';
			const result = query
				? await rpc('EzkLib', [query, null, payload.cursor || null])
				: await rpc('lcxiM', [payload.cursor || null, null, 100, null, 1, 3]);
			if (!Array.isArray(result) || (!Array.isArray(result[0]) && result[0] != null))
				throw new Error('Google Photos list format changed.');
			/** @type {any[][]} */
			const rows = result[0] || [];
			if (rows.length > 1000) throw new Error('Unexpectedly large page.');
			const info = rows.length ? await metadata(rows.map((r) => r[0])) : new Map();
			const items = rows.map((r) => parseRow(r, info.get(r[0]))).filter((p) => !p.isVideo);
			const cursor = result[1] ?? null;
			if (cursor !== null && typeof cursor !== 'string')
				throw new Error('Unexpected pagination cursor.');
			return { account, items, cursor, skippedVideos: rows.length - items.length };
		}
		if (action === 'refresh') {
			const key = payload.mediaKey;
			const d = await detail(key);
			const info = await metadata([key]);
			const p = parseRow(d[0], info.get(key));
			return { account, ...p };
		}
		if (action === 'verify') return { account, trashed: isTrashed(await detail(payload.mediaKey)) };
		if (action === 'trash') {
			const item = payload.item;
			if (
				!payload.confirmed ||
				typeof payload.batch !== 'string' ||
				!item?.mediaKey ||
				!item?.dedupKey ||
				!item?.filename
			)
				throw new Error('Missing confirmed photo selection.');
			const d = await detail(item.mediaKey);
			const info = (await metadata([item.mediaKey])).get(item.mediaKey);
			if (d[0][3] !== item.dedupKey || info?.filename !== item.filename)
				throw new Error('Photo identity changed; nothing was deleted.');
			if (isTrashed(d)) return { account, verified: true };
			// Never retry a mutation: a dropped response may mean it already succeeded.
			await rpc('XwAOJf', [null, 1, [item.dedupKey], 3]);
			for (let attempt = 0; attempt < 3; attempt++) {
				await pause(800);
				if (isTrashed(await detail(item.mediaKey))) return { account, verified: true };
			}
			throw new Error(
				'Could not verify that the photo reached trash. Check its status before trying again.'
			);
		}
		throw new Error('Unsupported Google Photos operation.');
	} catch (e) {
		return { error: e instanceof Error ? e.message : 'Google Photos connection failed.' };
	}
}
