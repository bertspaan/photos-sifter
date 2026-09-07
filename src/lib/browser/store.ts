import { z } from 'zod';
import { db, type ReviewDatabase, type DeletionItem } from './db';
import { matchesFilters, previewFingerprint, validateDeletion } from '../domain';
import type { Photo, Filters, AppState, ImportJob } from '../types';
export const idSchema = z.string().min(1).max(5000);
export const decisionSchema = z.enum(['unreviewed', 'keep', 'delete', 'unsure']);
export const importedSchema = z.object({
	mediaKey: idSchema,
	dedupKey: z.string().max(500).default(''),
	filename: z.string().min(1).max(500),
	thumb: z.string().max(3000).default(''),
	timestamp: z.number().finite().default(0),
	width: z.number().nonnegative().default(0),
	height: z.number().nonnegative().default(0),
	bytes: z.number().nonnegative().default(0),
	isOwned: z.boolean().default(false)
});
const filtersSchema = z.object({
	importId: z.string().default(''),
	decision: z.string().default('all'),
	matchOnly: z.boolean().default(false),
	filenames: z.array(z.string().max(500)).max(100000).default([])
});
export function validateThumbnail(thumb: string) {
	if (!thumb) return;
	const u = new URL(thumb);
	if (u.protocol !== 'https:' || !/^lh\d+\.googleusercontent\.com$/.test(u.hostname))
		throw new Error('Unexpected image host.');
}
export function localPhotoId(folderId: string, path: string) {
	return 'local:' + folderId + ':' + path;
}
const googlePhotoId = (account: string, key: string) => 'google:' + JSON.stringify([account, key]);
export function blankPhoto(id: string): Photo {
	return {
		id,
		account: '',
		mediaKey: '',
		dedupKey: '',
		filename: '',
		thumb: '',
		timestamp: 0,
		width: 0,
		height: 0,
		bytes: 0,
		localPath: '',
		localMatches: 0,
		decision: 'unreviewed',
		revision: 0,
		trashed: 0,
		source: 'google',
		importId: '',
		isOwned: false,
		folderId: '',
		localModified: 0
	};
}
export class ReviewStore {
	constructor(public db: ReviewDatabase) {}
	private write<T>(fn: () => Promise<T>) {
		return this.db.transaction('rw', this.db.tables, fn);
	}
	async getPhoto(id: string) {
		const p = await this.db.photos.get(id);
		if (!p || p.trashed) throw new Error('Photo no longer available.');
		return p;
	}
	async assertUnlocked(id: string) {
		if (
			await this.db.deletions
				.where('photoId')
				.equals(id)
				.filter((d) => d.state === 'executing' || d.state === 'uncertain')
				.count()
		)
			throw new Error('Verify the previous deletion attempt before changing this photo.');
	}
	async validateSelection(rows: Photo[]) {
		validateDeletion(rows);
		const ids = new Set(rows.map((p) => p.id));
		for (const p of rows) {
			await this.assertUnlocked(p.id);
			const copies = await this.db.photos
				.where('[account+dedupKey]')
				.equals([p.account, p.dedupKey])
				.toArray();
			if (copies.some((c) => !c.trashed && !ids.has(c.id)))
				throw new Error(
					'Another imported photo shares this deletion key. Review its copies before deleting.'
				);
		}
	}
	async photos(f: Filters) {
		const folderId = await this.db.setting('activeFolder', '');
		const names = new Set(f.filenames),
			rest = { ...f, filenames: [] };
		const files = folderId ? await this.db.files.where('folderId').equals(folderId).toArray() : [];
		const counts = new Map<string, number>();
		for (const file of files) counts.set(file.filename, (counts.get(file.filename) || 0) + 1);
		const rows = f.importId
			? await this.db.photos.bulkGet(
					(await this.db.memberships.where('importId').equals(f.importId).toArray()).map(
						(l) => l.photoId
					)
				)
			: await this.db.photos.toArray();
		return rows
			.filter((p): p is Photo => !!p && !p.trashed)
			.map((p) => ({ ...p, importId: f.importId, localMatches: counts.get(p.filename) || 0 }))
			.filter((p) => matchesFilters(p, rest) && (!names.size || names.has(p.filename)))
			.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
	}
	async state(): Promise<AppState> {
		const folderId = await this.db.setting('activeFolder', '');
		const folder = folderId ? await this.db.folders.get(folderId) : undefined;
		return {
			imports: await this.db.imports.orderBy('created').reverse().toArray(),
			localCount: folder?.count || 0,
			root: folder?.name || '',
			folderId: folder?.id || '',
			undoCount: await this.db.history.where('undone').equals(0).count()
		};
	}
	async unresolved() {
		const rows = await this.db.deletions.where('state').anyOf('executing', 'uncertain').toArray();
		const photos = await this.db.photos.bulkGet(rows.map((r) => r.photoId));
		return rows.map((r, i) => ({
			...r,
			filename: photos[i]?.filename || '',
			account: photos[i]?.account || '',
			mediaKey: photos[i]?.mediaKey || ''
		}));
	}
	async command<T = any>(action: string, body: unknown = {}): Promise<T> {
		return this.execute(action, body) as Promise<T>;
	}
	private async execute(action: string, body: unknown): Promise<unknown> {
		switch (action) {
			case 'state':
				return this.state();
			case 'deletions':
				return this.unresolved();
			case 'photos':
				return { photos: await this.photos(filtersSchema.parse(body)) };
			case 'export': {
				const { importId } = z.object({ importId: z.string() }).parse(body);
				return {
					exportedAt: new Date().toISOString(),
					photos: (
						await this.photos({ importId, decision: 'all', matchOnly: false, filenames: [] })
					).map(({ id, account, mediaKey, filename, decision, source }) => ({
						id,
						account,
						mediaKey,
						filename,
						decision,
						source,
						url: source === 'google' ? 'https://photos.google.com/photo/' + mediaKey : undefined
					}))
				};
			}
			case 'local-import':
				return this.write(async () => {
					const folderId = await this.db.setting('activeFolder', '');
					const folder = await this.db.folders.get(folderId);
					if (!folder?.indexedAt) throw new Error('Choose and index a photo folder first.');
					const id = crypto.randomUUID(),
						files = await this.db.files.where('folderId').equals(folderId).toArray();
					const ids = files.map((f) => localPhotoId(folderId, f.path)),
						existing = await this.db.photos.bulkGet(ids);
					const photos = files.map((f, i) => {
						const previous = existing[i];
						const changed =
							previous && (previous.bytes !== f.bytes || previous.localModified !== f.mtime);
						const match = f.filename.match(/(?:IMG|VID)-(\d{4})(\d{2})(\d{2})-/);
						return {
							...(previous || blankPhoto(ids[i])),
							account: 'local',
							filename: f.filename,
							timestamp: match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) : f.mtime,
							bytes: f.bytes,
							source: 'local' as const,
							folderId,
							localModified: f.mtime,
							localPath: f.path,
							decision: changed ? ('unreviewed' as const) : previous?.decision || 'unreviewed',
							revision: (previous?.revision || 0) + (changed ? 1 : 0)
						};
					});
					await this.db.photos.bulkPut(photos);
					await this.db.memberships.bulkPut(ids.map((photoId) => ({ importId: id, photoId })));
					await this.db.imports.add({
						id,
						source: 'local',
						query: folder.name,
						account: 'local',
						cursor: null,
						status: 'complete',
						count: files.length,
						error: '',
						created: Date.now()
					});
					return { id };
				});
			case 'imports/create': {
				const v = z.object({ query: z.string().max(2000), account: idSchema }).parse(body);
				const id = crypto.randomUUID();
				await this.db.imports.add({
					id,
					source: 'google',
					...v,
					cursor: null,
					status: 'paused',
					count: 0,
					error: '',
					created: Date.now()
				});
				return { id };
			}
			case 'imports/page': {
				const v = z
					.object({
						id: idSchema,
						account: idSchema,
						expectedCursor: z.string().nullable(),
						cursor: z.string().nullable(),
						items: z.array(importedSchema).max(1000)
					})
					.parse(body);
				v.items.forEach((p) => validateThumbnail(p.thumb));
				await this.write(async () => {
					const job = await this.db.imports.get(v.id);
					if (!job || job.account !== v.account || job.source !== 'google')
						throw new Error('Import account mismatch.');
					if (job.status === 'complete' || job.cursor !== v.expectedCursor)
						throw new Error('Import cursor changed. Reload before continuing.');
					if (v.cursor && v.cursor === v.expectedCursor)
						throw new Error('Google returned the same page twice. Import paused.');
					const ids = v.items.map((p) => googlePhotoId(v.account, p.mediaKey)),
						existing = await this.db.photos.bulkGet(ids);
					await this.db.photos.bulkPut(
						v.items.map((p, i) => {
							const old = existing[i];
							const identityChanged =
								old && (old.filename !== p.filename || old.dedupKey !== p.dedupKey);
							return {
								...(old || blankPhoto(ids[i])),
								...p,
								account: v.account,
								source: 'google',
								revision: (old?.revision || 0) + (identityChanged ? 1 : 0)
							} as Photo;
						})
					);
					await this.db.memberships.bulkPut(ids.map((photoId) => ({ importId: v.id, photoId })));
					await this.db.imports.update(v.id, {
						cursor: v.cursor,
						status: v.cursor ? 'paused' : 'complete',
						error: '',
						count: await this.db.memberships.where('importId').equals(v.id).count()
					});
				});
				return this.state();
			}
			case 'photo-refresh': {
				const v = z.object({ id: idSchema, account: idSchema, photo: importedSchema }).parse(body);
				validateThumbnail(v.photo.thumb);
				return this.write(async () => {
					const p = await this.getPhoto(v.id);
					if (
						p.source !== 'google' ||
						p.account !== v.account ||
						p.mediaKey !== v.photo.mediaKey ||
						p.dedupKey !== v.photo.dedupKey ||
						p.filename !== v.photo.filename
					)
						throw new Error('Photo identity changed. Import it again before reviewing.');
					await this.db.photos.update(p.id, { thumb: v.photo.thumb });
					return { photo: await this.getPhoto(p.id) };
				});
			}
			case 'imports/error': {
				const v = z.object({ id: idSchema, error: z.string().max(2000) }).parse(body);
				await this.write(async () => {
					const job = await this.db.imports.get(v.id);
					if (job && job.status !== 'complete')
						await this.db.imports.update(v.id, { error: v.error, status: 'paused' });
				});
				return { ok: true };
			}
			case 'decision': {
				const v = z
					.object({ id: idSchema, decision: decisionSchema, revision: z.number().int() })
					.parse(body);
				return this.write(async () => {
					await this.assertUnlocked(v.id);
					const p = await this.getPhoto(v.id);
					if (p.revision !== v.revision)
						throw new Error('This photo changed in another tab. Reload and try again.');
					await this.db.photos.update(v.id, { decision: v.decision, revision: p.revision + 1 });
					await this.db.history.add({
						photoId: v.id,
						previous: p.decision,
						next: v.decision,
						revision: p.revision + 1,
						undone: 0
					});
					return { photo: await this.getPhoto(v.id) };
				});
			}
			case 'undo':
				return this.write(async () => {
					const history = await this.db.history.where('undone').equals(0).reverse().toArray();
					for (const h of history) {
						const p = await this.db.photos.get(h.photoId);
						if (!p || p.trashed) continue;
						await this.assertUnlocked(p.id);
						if (p.decision !== h.next)
							throw new Error('This decision has changed; it cannot be undone.');
						await this.db.photos.update(p.id, { decision: h.previous, revision: p.revision + 1 });
						await this.db.history.update(h.seq!, { undone: 1 });
						return { id: p.id };
					}
					throw new Error('Nothing to undo.');
				});
			case 'delete-preview': {
				const { ids } = z.object({ ids: z.array(idSchema).min(1).max(500) }).parse(body);
				if (new Set(ids).size !== ids.length) throw new Error('Duplicate photo selection.');
				return this.write(async () => {
					const rows = await Promise.all(ids.map((id) => this.getPhoto(id)));
					await this.validateSelection(rows);
					const token = crypto.randomUUID(),
						expires = Date.now() + 15 * 60 * 1000;
					await this.db.previews.add({
						token,
						ids,
						fingerprint: previewFingerprint(rows),
						expires,
						consumed: false
					});
					return { token, photos: rows, expires };
				});
			}
			case 'delete-confirm': {
				const { token } = z.object({ token: idSchema }).parse(body);
				return this.write(async () => {
					const preview = await this.db.previews.get(token);
					if (!preview || preview.consumed || preview.expires < Date.now())
						throw new Error('Preview expired. Open a new preview.');
					const rows = await Promise.all(preview.ids.map((id) => this.getPhoto(id)));
					await this.validateSelection(rows);
					if (previewFingerprint(rows) !== preview.fingerprint)
						throw new Error('The selection changed. Open a fresh preview.');
					await this.db.previews.update(token, { consumed: true });
					await this.db.deletions.bulkAdd(
						rows.map((p) => ({ batch: token, photoId: p.id, state: 'pending', error: '' }))
					);
					return { batch: token, photos: rows };
				});
			}
			case 'delete-claim': {
				const v = z.object({ batch: idSchema, id: idSchema }).parse(body);
				return this.write(async () => {
					const row = await this.db.deletions.get([v.batch, v.id]);
					if (!row || row.state !== 'pending')
						throw new Error('This deletion has already been attempted.');
					const p = await this.getPhoto(v.id);
					validateDeletion([p]);
					const preview = await this.db.previews.get(v.batch);
					const expected = preview?.consumed
						? JSON.parse(preview.fingerprint).find((r: unknown[]) => r[0] === p.id)
						: null;
					if (!expected || JSON.stringify(expected) !== previewFingerprint([p]).slice(1, -1))
						throw new Error('This decision changed after confirmation. Open a new preview.');
					await this.assertUnlocked(p.id);
					await this.db.deletions.update([v.batch, v.id], { state: 'executing' });
					return { photo: p };
				});
			}
			case 'delete-result': {
				const v = z
					.object({
						batch: idSchema,
						id: idSchema,
						verified: z.boolean(),
						error: z.string().max(2000).default('')
					})
					.parse(body);
				return this.write(async () => {
					const item = await this.db.deletions.get([v.batch, v.id]);
					if (!item || !['executing', 'uncertain'].includes(item.state))
						throw new Error('No matching deletion attempt.');
					await this.db.deletions.update([v.batch, v.id], {
						state: v.verified ? 'trashed' : 'uncertain',
						error: v.error
					});
					if (v.verified) {
						const p = await this.getPhoto(v.id);
						await this.db.photos.update(v.id, { trashed: 1, revision: p.revision + 1 });
						await this.db.history.where('photoId').equals(v.id).modify({ undone: 1 });
					}
					return { ok: true };
				});
			}
			case 'delete-resolve': {
				const v = z.object({ batch: idSchema, id: idSchema, trashed: z.boolean() }).parse(body);
				return this.write(async () => {
					const item = await this.db.deletions.get([v.batch, v.id]);
					if (!item || !['executing', 'uncertain'].includes(item.state))
						throw new Error('No unresolved attempt.');
					await this.db.deletions.update([v.batch, v.id], {
						state: v.trashed ? 'trashed' : 'not-trashed',
						error: ''
					});
					if (v.trashed) {
						const p = await this.getPhoto(v.id);
						await this.db.photos.update(v.id, { trashed: 1, revision: p.revision + 1 });
						await this.db.history.where('photoId').equals(v.id).modify({ undone: 1 });
					}
					return { ok: true };
				});
			}
			default:
				throw new Error('Unknown review action.');
		}
	}
}
export const reviewStore = new ReviewStore(db);
export const review = <T = any>(action: string, body?: unknown) =>
	reviewStore.command<T>(action, body);
