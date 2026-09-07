import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { ReviewDatabase } from '../src/lib/browser/db';
import { ReviewStore } from '../src/lib/browser/store';
const db = new ReviewDatabase('review-test-' + crypto.randomUUID());
const store = new ReviewStore(db);
beforeAll(() => db.open());
beforeEach(() =>
	db.transaction('rw', db.tables, () => Promise.all(db.tables.map((t) => t.clear())))
);
afterAll(() => db.delete());
async function call(path: string, body: unknown) {
	try {
		return { status: 200, ...(await store.command(path, body)) };
	} catch (e) {
		return { status: 400, error: e instanceof Error ? e.message : String(e) };
	}
}
async function seed() {
	const job = await call('imports/create', { account: 'me', query: '"WA"' });
	await call('imports/page', {
		id: job.id,
		account: 'me',
		expectedCursor: null,
		cursor: null,
		items: [
			{
				mediaKey: 'media-a',
				dedupKey: 'dedup-a',
				filename: 'IMG-20260701-WA0001.jpg',
				thumb: 'https://lh3.googleusercontent.com/example=w1600-h1600',
				isOwned: true
			},
			{ mediaKey: 'media-b', dedupKey: 'dedup-b', filename: 'PXL-camera.jpg', isOwned: true }
		]
	});
	const result = await call('photos', { importId: job.id });
	return {
		job: job.id,
		a: result.photos.find((p: any) => p.mediaKey === 'media-a'),
		b: result.photos.find((p: any) => p.mediaKey === 'media-b')
	};
}
async function mark(id: string) {
	return call('decision', { id, decision: 'delete', revision: 0 });
}
describe('saved review and confirmed deletion', () => {
	it('marks without deleting, refuses stale writes and supports undo', async () => {
		const { a } = await seed();
		expect((await mark(a.id)).photo.decision).toBe('delete');
		expect(await db.deletions.count()).toBe(0);
		expect((await call('decision', { id: a.id, decision: 'keep', revision: 0 })).status).toBe(400);
		expect((await call('undo', {})).id).toBe(a.id);
		expect((await db.photos.get(a.id))!.decision).toBe('unreviewed');
	});
	it('rejects a stale preview and reusing a confirmed preview', async () => {
		const { a } = await seed();
		await mark(a.id);
		const preview = await call('delete-preview', { ids: [a.id] });
		await call('decision', { id: a.id, decision: 'keep', revision: 1 });
		expect((await call('delete-confirm', { token: preview.token })).status).toBe(400);
		await call('decision', { id: a.id, decision: 'delete', revision: 2 });
		const fresh = await call('delete-preview', { ids: [a.id] });
		expect((await call('delete-confirm', { token: fresh.token })).status).toBe(200);
		expect((await call('delete-confirm', { token: fresh.token })).status).toBe(400);
	});
	it('expires confirmations and rejects non-deleted or local selections', async () => {
		const { a, b } = await seed();
		await mark(a.id);
		expect((await call('delete-preview', { ids: [b.id] })).status).toBe(400);
		const p = await call('delete-preview', { ids: [a.id] });
		await db.previews.update(p.token, { expires: 0 });
		expect((await call('delete-confirm', { token: p.token })).status).toBe(400);
		await db.photos.update(a.id, { source: 'local' });
		expect((await call('delete-preview', { ids: [a.id] })).status).toBe(400);
	});
	it('rejects decisions changed after confirmation', async () => {
		const { a } = await seed();
		await mark(a.id);
		const p = await call('delete-preview', { ids: [a.id] });
		await call('delete-confirm', { token: p.token });
		await call('decision', { id: a.id, decision: 'keep', revision: 1 });
		await call('decision', { id: a.id, decision: 'delete', revision: 2 });
		expect((await call('delete-claim', { batch: p.token, id: a.id })).status).toBe(400);
	});
	it('never retries an uncertain deletion and locks it until verified', async () => {
		const { a } = await seed();
		await mark(a.id);
		const p = await call('delete-preview', { ids: [a.id] });
		await call('delete-confirm', { token: p.token });
		const attempt = { batch: p.token, id: a.id };
		expect((await call('delete-claim', attempt)).status).toBe(200);
		await call('delete-result', { ...attempt, verified: false, error: 'Connection dropped' });
		expect((await call('delete-claim', attempt)).status).toBe(400);
		expect((await call('decision', { id: a.id, decision: 'keep', revision: 1 })).status).toBe(400);
		expect((await call('delete-preview', { ids: [a.id] })).status).toBe(400);
		await call('delete-resolve', { ...attempt, trashed: false });
		expect((await call('decision', { id: a.id, decision: 'keep', revision: 1 })).status).toBe(200);
	});
	it('removes only verified trash from review and can undo earlier remaining decisions', async () => {
		const { a, b } = await seed();
		await call('decision', { id: b.id, decision: 'keep', revision: 0 });
		await mark(a.id);
		const p = await call('delete-preview', { ids: [a.id] });
		await call('delete-confirm', { token: p.token });
		await call('delete-claim', { batch: p.token, id: a.id });
		await call('delete-result', { batch: p.token, id: a.id, verified: true });
		const result = await call('photos', {});
		expect(result.photos.map((p: any) => p.id)).toEqual([b.id]);
		expect((await call('undo', {})).id).toBe(b.id);
	});
	it('blocks deletion keys shared by another imported photo', async () => {
		const { a, b } = await seed();
		await db.photos.update(b.id, { dedupKey: a.dedupKey });
		await mark(a.id);
		expect((await call('delete-preview', { ids: [a.id] })).status).toBe(400);
	});
	it('checks accounts and persists a cursor without duplicating pages', async () => {
		const j = await call('imports/create', { account: 'me', query: '' });
		const page = { id: j.id, account: 'me', expectedCursor: null, cursor: 'page2', items: [] };
		expect((await call('imports/page', { ...page, account: 'other' })).status).toBe(400);
		expect((await call('imports/page', page)).status).toBe(200);
		expect((await call('imports/page', page)).status).toBe(400);
		expect(
			(await call('imports/page', { ...page, expectedCursor: 'page2', cursor: null })).status
		).toBe(200);
	});
	it('indexes exact local filenames and prevents cloud deletion of local files', async () => {
		await db.folders.put({ id: 'folder-a', name: 'Photos', indexedAt: Date.now(), count: 1 });
		await db.settings.put({ key: 'activeFolder', value: 'folder-a' });
		await db.files.put({
			folderId: 'folder-a',
			path: 'IMG-20260701-WA0001.jpg',
			filename: 'IMG-20260701-WA0001.jpg',
			bytes: 1,
			mtime: 1
		});
		const { job, a } = await seed();
		const filtered = await call('photos', { importId: job, matchOnly: true });
		expect(filtered.photos.map((p: any) => p.id)).toEqual([a.id]);
		const local = await call('local-import', {});
		const rows = await call('photos', { importId: local.id });
		await mark(rows.photos[0].id);
		expect((await call('delete-preview', { ids: [rows.photos[0].id] })).status).toBe(400);
	});

	it('keeps decisions after reopening the database', async () => {
		const { a } = await seed();
		await mark(a.id);
		db.close();
		await db.open();
		expect((await store.getPhoto(a.id)).decision).toBe('delete');
	});
	it('serializes conflicting writes from two tabs', async () => {
		const { a } = await seed();
		const other = new ReviewDatabase(db.name);
		try {
			const second = new ReviewStore(other);
			const results = await Promise.allSettled([
				store.command('decision', { id: a.id, decision: 'keep', revision: 0 }),
				second.command('decision', { id: a.id, decision: 'delete', revision: 0 })
			]);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			expect((await store.getPhoto(a.id)).revision).toBe(1);
		} finally {
			other.close();
		}
	});
	it('allows only one tab to claim a confirmed deletion', async () => {
		const { a } = await seed();
		await mark(a.id);
		const p = await call('delete-preview', { ids: [a.id] });
		await call('delete-confirm', { token: p.token });
		const other = new ReviewDatabase(db.name);
		try {
			const second = new ReviewStore(other);
			const results = await Promise.allSettled([
				store.command('delete-claim', { batch: p.token, id: a.id }),
				second.command('delete-claim', { batch: p.token, id: a.id })
			]);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		} finally {
			other.close();
		}
	});
	it('rolls back a decision if its history cannot be saved', async () => {
		const { a } = await seed();
		const spy = vi
			.spyOn(db.history, 'add')
			.mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
		expect((await mark(a.id)).status).toBe(400);
		spy.mockRestore();
		expect((await store.getPhoto(a.id)).decision).toBe('unreviewed');
	});
});
