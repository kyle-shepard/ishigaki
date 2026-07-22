// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// Set by hooks.server.ts for /api/* requests only — see the note there.
		interface Locals {
			playerId: number;
			// True for the one request on which a returning visitor's realm turned out to be gone.
			worldReset: boolean;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
