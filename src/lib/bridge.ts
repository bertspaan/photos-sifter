const channel = 'clean-google-photos-v1';
export function bridge<T = any>(action: string, payload: unknown = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		const id = crypto.randomUUID();
		const timer = setTimeout(
			() => {
				window.removeEventListener('message', listener);
				reject(
					new Error(
						action === 'ping'
							? 'Open this app in Chrome and load the companion extension.'
							: 'The Google Photos connection timed out. No automatic retry was made.'
					)
				);
			},
			action === 'ping' ? 2500 : 120000
		);
		function listener(e: MessageEvent) {
			if (
				e.source !== window ||
				e.origin !== location.origin ||
				e.data?.channel !== channel ||
				e.data?.direction !== 'response' ||
				e.data?.id !== id
			)
				return;
			clearTimeout(timer);
			window.removeEventListener('message', listener);
			e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
		}
		window.addEventListener('message', listener);
		window.postMessage({ channel, direction: 'request', id, action, payload }, location.origin);
	});
}
