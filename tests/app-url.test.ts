import { it, expect } from 'vitest';
import { isAllowedAppUrl } from '../extension/app-url.js';
it('allows only the exact published app path and the configured localhost port', () => {
	for (const url of [
		'https://bertspaan.nl/photos-sifter',
		'https://bertspaan.nl/photos-sifter/',
		'https://bertspaan.nl/photos-sifter/?query=WA',
		'http://127.0.0.1:5178/',
		'http://localhost:5178/'
	])
		expect(isAllowedAppUrl(url)).toBe(true);
	for (const url of [
		'https://bertspaan.nl/',
		'https://bertspaan.nl/other-app/',
		'https://bertspaan.nl/photos-sifter-other/',
		'https://bertspaan.nl.evil.example/photos-sifter/',
		'https://evil.example/',
		'http://bertspaan.nl/photos-sifter/',
		'https://photos.google.com/',
		'http://localhost:1234/',
		'https://user:pass@bertspaan.nl/photos-sifter/'
	])
		expect(isAllowedAppUrl(url)).toBe(false);
});
