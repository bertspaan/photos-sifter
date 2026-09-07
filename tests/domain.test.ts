import { describe, it, expect } from 'vitest';
import {
	parseFilenames,
	matchesFilters,
	validateDeletion,
	previewFingerprint
} from '../src/lib/domain';
import type { Photo } from '../src/lib/types';
const photo = {
	id: 'a',
	account: 'me',
	mediaKey: 'key',
	dedupKey: 'dedup',
	filename: 'IMG-20260701-WA0001.jpg',
	source: 'google',
	decision: 'delete',
	revision: 1,
	isOwned: true,
	trashed: 0,
	localMatches: 1,
	importId: 'review'
} as Photo;
describe('filename filters and deletion eligibility', () => {
	it('parses exact names, keeps case, and removes blank and duplicate lines', () => {
		expect(parseFilenames(' A.jpg\r\nA.jpg\n\nb.jpg ')).toEqual(['A.jpg', 'b.jpg']);
		expect(parseFilenames('[" A.jpg ","b.jpg"]')).toEqual(['A.jpg', 'b.jpg']);
		expect(() => parseFilenames('[1]')).toThrow();
	});
	it('intersects list and backup filters without WA substring matching', () => {
		const f = { importId: 'review', decision: 'all', matchOnly: true, filenames: [photo.filename] };
		expect(matchesFilters(photo, f)).toBe(true);
		expect(matchesFilters({ ...photo, filename: 'PXL-camera.jpg' }, f)).toBe(false);
		expect(matchesFilters({ ...photo, localMatches: 0 }, f)).toBe(false);
		expect(matchesFilters({ ...photo, filename: photo.filename.toUpperCase() }, f)).toBe(false);
	});
	it('rejects local files, kept photos, shared photos, trash and mixed accounts', () => {
		for (const patch of [
			{ source: 'local' },
			{ decision: 'keep' },
			{ isOwned: false },
			{ trashed: 1 },
			{ dedupKey: '' }
		])
			expect(() => validateDeletion([{ ...photo, ...patch } as Photo])).toThrow();
		expect(() => validateDeletion([photo, { ...photo, account: 'other' }])).toThrow();
		expect(() => validateDeletion([photo])).not.toThrow();
	});
	it('binds confirmation to the current decision revision', () => {
		expect(previewFingerprint([photo])).not.toBe(previewFingerprint([{ ...photo, revision: 2 }]));
		expect(previewFingerprint([photo, { ...photo, id: 'b' }])).toBe(
			previewFingerprint([{ ...photo, id: 'b' }, photo])
		);
	});
});
