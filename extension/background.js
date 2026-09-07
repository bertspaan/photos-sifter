import { isAllowedAppUrl } from './app-url.js';
import { googleRequest } from './google-client.js';
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!sender.url || sender.frameId !== 0 || !isAllowedAppUrl(sender.url)) return false;
	async function execute(tabId, action, payload) {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'MAIN',
			func: googleRequest,
			args: [action, payload]
		});
		const value = results[0]?.result;
		if (!value) throw new Error('No response from Google Photos. Reload the Google Photos tab.');
		if (value.error) throw new Error(value.error);
		return value;
	}
	(async () => {
		const tabs = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
		if (message.action === 'ping') {
			const accounts = [];
			for (const tab of tabs) {
				try {
					const account = await execute(tab.id, 'account', {});
					accounts.push({ tabId: tab.id, account: account.account });
				} catch {}
			}
			return { tabs: accounts };
		}
		if (!['page', 'trash', 'verify', 'refresh'].includes(message.action))
			throw new Error('Unsupported action.');
		const p = message.payload || {};
		if (!Number.isInteger(p.tabId) || typeof p.account !== 'string')
			throw new Error('Choose a Google Photos tab.');
		if (!tabs.some((t) => t.id === p.tabId))
			throw new Error('The chosen Google Photos tab is closed. Reconnect.');
		if (
			message.action === 'trash' &&
			(!p.confirmed || typeof p.batch !== 'string' || typeof p.item?.mediaKey !== 'string')
		)
			throw new Error('A confirmed deletion batch is required.');
		return execute(p.tabId, message.action, p);
	})()
		.then((result) => sendResponse({ result }))
		.catch((e) => sendResponse({ error: e.message || 'Google Photos request failed.' }));
	return true;
});
