import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleRequest } from '../extension/google-client.js';
import { validateThumbnail } from '../src/lib/browser/store';
const account = 'me@example.com';
let calls: { method: string; data: any }[];
function row(key = 'photo-a', trash = false) {
	const r: any[] = [
		key,
		['https://lh3.googleusercontent.com/preview', 1200, 800],
		123,
		'dedup-a',
		null,
		null,
		null,
		[]
	];
	r.push(trash ? { '225032867': [123] } : {});
	return r;
}
function mockRpc(handler: (method: string, data: any) => unknown) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url, options) => {
			const req = JSON.parse(options.body.get('f.req'))[0][0];
			const method = req[0],
				data = JSON.parse(req[1]);
			calls.push({ method, data });
			const value = handler(method, data);
			return new Response(")]}'\n\n" + JSON.stringify([['wrb.fr', method, JSON.stringify(value)]]));
		})
	);
}
beforeEach(() => {
	calls = [];
	vi.stubGlobal('window', {
		WIZ_global_data: {
			oPEP7c: account,
			SNlM0e: 'fixture-token',
			eptZe: '/_/PhotosUi/',
			FdrFJe: 'fixture-session',
			cfb2h: 'fixture-build'
		}
	});
	vi.stubGlobal('location', { origin: 'https://photos.google.com', pathname: '/' });
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
describe('Chrome companion RPC boundary (mock Google responses)', () => {
	it('returns filenames and pagination without exposing login tokens', async () => {
		mockRpc((method, data) => {
			if (method === 'EzkLib') {
				expect(data).toEqual(['"WA"', null, null]);
				return [[row()], 'next'];
			}
			if (method === 'EWgK9e') {
				expect(data[0][0][0]).toEqual([['photo-a']]);
				return [
					[null, [['photo-a', [null, null, null, 'IMG-WA.jpg', null, null, null, null, null, 125]]]]
				];
			}
			throw Error(method);
		});
		const result: any = await googleRequest('page', { account, query: '"WA"' });
		expect(result.error).toBeUndefined();
		expect(result.items[0]).toMatchObject({ filename: 'IMG-WA.jpg', isOwned: true, bytes: 125 });
		expect(result.cursor).toBe('next');
		expect(JSON.stringify(result)).not.toContain('fixture-token');
	});
	it('uses the all-photos source including archived items', async () => {
		mockRpc((method, data) => {
			expect(method).toBe('lcxiM');
			expect(data).toEqual(['page2', null, 100, null, 1, 3]);
			return [[], null];
		});
		expect(await googleRequest('page', { account, query: '', cursor: 'page2' })).toMatchObject({
			items: [],
			cursor: null
		});
	});
	it('refuses a changed account before any network request', async () => {
		mockRpc(() => null);
		expect(await googleRequest('page', { account: 'other' })).toHaveProperty('error');
		expect(calls).toHaveLength(0);
	});
	it('refuses a trash mutation if the filename does not match', async () => {
		mockRpc((method) =>
			method === 'VrseUb' ? [row()] : [[null, [['photo-a', [null, null, null, 'different.jpg']]]]]
		);
		const result = await googleRequest('trash', {
			account,
			confirmed: true,
			batch: 'batch',
			item: { mediaKey: 'photo-a', dedupKey: 'dedup-a', filename: 'IMG-WA.jpg' }
		});
		expect(result).toHaveProperty('error');
		expect(calls.some((c) => c.method === 'XwAOJf')).toBe(false);
	});
	it('does not retry a mutation whose response was lost', async () => {
		mockRpc((method) => {
			if (method === 'VrseUb') return [row()];
			if (method === 'EWgK9e') return [[null, [['photo-a', [null, null, null, 'IMG-WA.jpg']]]]];
			throw Error('connection lost');
		});
		expect(
			await googleRequest('trash', {
				account,
				confirmed: true,
				batch: 'batch',
				item: { mediaKey: 'photo-a', dedupKey: 'dedup-a', filename: 'IMG-WA.jpg' }
			})
		).toHaveProperty('error');
		expect(calls.filter((c) => c.method === 'XwAOJf')).toHaveLength(1);
	});
	it('requires read-back verification after a trash response', async () => {
		vi.useFakeTimers();
		let trashed = false;
		mockRpc((method) => {
			if (method === 'VrseUb') return [row('photo-a', trashed)];
			if (method === 'EWgK9e') return [[null, [['photo-a', [null, null, null, 'IMG-WA.jpg']]]]];
			if (method === 'XwAOJf') {
				trashed = true;
				return [];
			}
			throw Error(method);
		});
		const result = googleRequest('trash', {
			account,
			confirmed: true,
			batch: 'batch',
			item: { mediaKey: 'photo-a', dedupKey: 'dedup-a', filename: 'IMG-WA.jpg' }
		});
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ verified: true });
		expect(calls.filter((c) => c.method === 'XwAOJf')).toHaveLength(1);
		expect(calls.filter((c) => c.method === 'VrseUb')).toHaveLength(2);
	});
	it('pauses on malformed server responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('unexpected response'))
		);
		expect(await googleRequest('page', { account, query: 'WA' })).toHaveProperty('error');
	});
});

// Exercise both boundaries: Google RPC parsing and browser import/backup validation.
describe('Google Photos preview hosts', () => {
	it.each([
		['https://lh3.googleusercontent.com/preview', true],
		['https://photos.fife.usercontent.google.com/preview', true],
		['http://photos.fife.usercontent.google.com/preview', false],
		['https://photos.fife.usercontent.google.com.evil.example/preview', false],
		['https://evil.example/preview', false],
		['https://other.usercontent.google.com/preview', false],
		['https://user:secret@photos.fife.usercontent.google.com/preview', false],
		['https://photos.fife.usercontent.google.com:8443/preview', false],
		['https://lh3.googleusercontent.com@evil.example/preview', false]
	])('validates %s at both boundaries', async (thumb, accepted) => {
		mockRpc((method) => {
			if (method === 'lcxiM') {
				const photo = row();
				photo[1][0] = thumb;
				return [[photo], null];
			}
			if (method === 'EWgK9e') return [[null, [['photo-a', [null, null, null, 'IMG-WA.jpg']]]]];
			throw Error(method);
		});
		const result: any = await googleRequest('page', { account });
		if (accepted) {
			expect(result.error).toBeUndefined();
			expect(result.items[0].thumb).toBe(thumb + '=w1600-h1600');
			expect(() => validateThumbnail(result.items[0].thumb)).not.toThrow();
		} else {
			expect(result.error).toBe('Unexpected preview address.');
			expect(() => validateThumbnail(thumb)).toThrow();
		}
	});
});
