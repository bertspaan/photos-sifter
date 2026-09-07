import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReviewDatabase } from '../src/lib/browser/db';
import { ReviewStore } from '../src/lib/browser/store';
import type { Photo } from '../src/lib/types';

const db = new ReviewDatabase('deletion-safety-test-' + crypto.randomUUID());
const store = new ReviewStore(db);
const first = {
	mediaKey: 'photo-a',
	dedupKey: 'dedup-a',
	filename: 'a.jpg',
	thumb: 'https://lh3.googleusercontent.com/a',
	isOwned: true
};
beforeAll(() => db.open());
beforeEach(() =>
	db.transaction('rw', db.tables, () => Promise.all(db.tables.map((t) => t.clear())))
);
afterAll(() => db.delete());

async function importPhotos(items = [first]) {
	const job = await store.command('imports/create', { account: 'test-account', query: '' });
	await store.command('imports/page', {
		id: job.id,
		account: 'test-account',
		expectedCursor: null,
		cursor: null,
		items
	});
	return (await store.command('photos', {})).photos as Photo[];
}
async function selected() {
	const [photo] = await importPhotos();
	await store.command('decision', { id: photo.id, decision: 'delete', revision: photo.revision });
	const preview = await store.command('delete-preview', { ids: [photo.id] });
	return { photo, preview };
}

describe('deletion must remain bound to the reviewed photos', () => {
	it.each(['filename', 'dedupKey'] as const)(
		'requires a fresh review after a re-import changes %s',
		async (field) => {
			const { photo, preview } = await selected();
			await importPhotos([{ ...first, [field]: 'changed' }]);
			expect((await store.getPhoto(photo.id)).decision).toBe('unreviewed');
			await expect(store.command('delete-confirm', { token: preview.token })).rejects.toThrow();
			await expect(store.command('delete-preview', { ids: [photo.id] })).rejects.toThrow();
			expect(await db.deletions.count()).toBe(0);
		}
	);
	it('preserves a decision when the same photo is re-imported unchanged', async () => {
		const { photo } = await selected();
		await importPhotos();
		expect((await store.getPhoto(photo.id)).decision).toBe('delete');
	});
	it('rejects a duplicate deletion key that appears after confirmation', async () => {
		const { photo, preview } = await selected();
		await store.command('delete-confirm', { token: preview.token });
		await importPhotos([{ ...first, mediaKey: 'photo-b', filename: 'b.jpg' }]);
		await expect(
			store.command('delete-claim', { batch: preview.token, id: photo.id })
		).rejects.toThrow('shares this deletion key');
		expect((await db.deletions.get([preview.token, photo.id]))?.state).toBe('pending');
	});
	it('rejects ambiguous deletion keys even when both copies are selected', async () => {
		const photos = await importPhotos([
			first,
			{ ...first, mediaKey: 'photo-b', filename: 'b.jpg' }
		]);
		for (const photo of photos) {
			await store.command('decision', {
				id: photo.id,
				decision: 'delete',
				revision: photo.revision
			});
		}
		await expect(store.command('delete-preview', { ids: photos.map((p) => p.id) })).rejects.toThrow(
			'share a deletion key'
		);
		expect(await db.deletions.count()).toBe(0);
	});
	it.each(['account', 'mediaKey', 'filename', 'thumb'] as const)(
		'rejects changed %s even if the decision revision is unchanged',
		async (field) => {
			const { photo, preview } = await selected();
			await db.photos.update(photo.id, { [field]: 'changed' });
			await expect(store.command('delete-confirm', { token: preview.token })).rejects.toThrow();
			expect(await db.deletions.count()).toBe(0);
		}
	);
	it('rejects a different preview image loaded after confirmation', async () => {
		const { photo, preview } = await selected();
		await store.command('delete-confirm', { token: preview.token });
		await importPhotos([{ ...first, thumb: 'https://lh3.googleusercontent.com/replacement' }]);
		await expect(
			store.command('delete-claim', { batch: preview.token, id: photo.id })
		).rejects.toThrow('changed after confirmation');
	});
});
