import isElectron from 'is-electron';

/**
 * The ListenBrainz user token, OS-encrypted via `safeStorage` in the main process.
 *
 * Never held in the settings store: that store persists through plain localStorage, which would
 * put a bearer token on disk unencrypted. This is Electron-only by construction - there is no
 * main process on the web/Docker build to hold `safeStorage` for it.
 */
const localSettings = isElectron() ? window.api.localSettings : null;

let cachedToken: null | string | undefined;

export async function getListenBrainzToken(): Promise<null | string> {
    if (!localSettings) {
        return null;
    }

    if (cachedToken === undefined) {
        cachedToken = await localSettings.listenBrainzTokenGet();
    }

    return cachedToken;
}

export async function removeListenBrainzToken(): Promise<void> {
    if (!localSettings) {
        return;
    }

    localSettings.listenBrainzTokenRemove();
    cachedToken = null;
}

export async function setListenBrainzToken(token: string): Promise<boolean> {
    if (!localSettings) {
        return false;
    }

    const saved = await localSettings.listenBrainzTokenSet(token);

    if (saved) {
        cachedToken = token;
    }

    return saved;
}
