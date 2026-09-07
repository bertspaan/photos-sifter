<script lang="ts">
	import { readPhotoFile } from '$lib/browser/files';
	import type { Photo } from '$lib/types';
	let {
		photo,
		small = false,
		class: className = '',
		loading = 'eager',
		onready,
		onfailure
	}: {
		photo: Photo;
		small?: boolean;
		class?: string;
		loading?: 'eager' | 'lazy';
		onready?: () => void;
		onfailure?: (message: string) => void;
	} = $props();
	let src = $state('');
	$effect(() => {
		const p = photo,
			thumb = small;
		let alive = true,
			blobUrl = '';
		src = '';
		if (p.source === 'google') src = thumb ? p.thumb.replace(/=w\d+-h\d+$/, '=w320-h320') : p.thumb;
		else
			void readPhotoFile(p)
				.then((file) => {
					if (alive) {
						blobUrl = URL.createObjectURL(file);
						src = blobUrl;
					}
				})
				.catch((e) => {
					if (alive) onfailure?.(e instanceof Error ? e.message : 'Unable to read local photo.');
				});
		return () => {
			alive = false;
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	});
</script>

{#if src}<img
		{src}
		class={className}
		alt={photo.filename}
		{loading}
		onload={() => onready?.()}
		onerror={() =>
			onfailure?.('This preview is unavailable or the format is not supported by your browser.')}
	/>{:else}<div class={className} role="img" aria-label={'Loading ' + photo.filename}></div>{/if}
