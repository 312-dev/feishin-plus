import { app, BrowserWindow } from 'electron';
import { writeFile } from 'fs/promises';
import { join } from 'path';

import log from '../../../logger';
import { store } from '../settings';

// Set once the copy below has run, so a later launch never overwrites settings the user has
// since changed with the frozen legacy snapshot.
const MIGRATED_FLAG = 'legacy_renderer_storage_migrated';

// Chromium partitions localStorage and IndexedDB by origin. The renderer used to be loaded with
// `loadFile`, giving it a `file://` origin; it is now served over loopback HTTP so it is
// same-origin with the music-video files. That switch left every renderer-side setting - theme,
// layout, hotkeys, the server list - stranded in the old bucket, present on disk but invisible to
// the app. This copies it across once.
const READER_PAGE_FILENAME = 'legacy-storage-reader.html';

/**
 * Served by `startRendererServer` as a near-empty document. Reaching the target origin's storage
 * only needs *a* page on it, and this one avoids booting a second copy of the whole renderer the
 * way navigating to `/index.html` would.
 */
export const STORAGE_MIGRATION_PATH = '/__storage-migration';

interface LegacyStorage {
    idb: Record<string, unknown>;
    localStorage: Record<string, string>;
}

// idb-keyval's defaults, which is what every renderer store using it relies on
// (`music-video-store.ts`, `listen-track-store.ts`, the Discover query cache).
const IDB_NAME = 'keyval-store';
const IDB_STORE = 'keyval';

const READ_SCRIPT = `
(async () => {
    const result = { idb: {}, localStorage: {} };

    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key !== null) result.localStorage[key] = localStorage.getItem(key);
    }

    result.idb = await new Promise((resolve) => {
        const request = indexedDB.open(${JSON.stringify(IDB_NAME)});
        request.onerror = () => resolve({});
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(${JSON.stringify(IDB_STORE)})) {
                db.close();
                resolve({});
                return;
            }
            const tx = db.transaction(${JSON.stringify(IDB_STORE)}, 'readonly');
            const objectStore = tx.objectStore(${JSON.stringify(IDB_STORE)});
            const keys = objectStore.getAllKeys();
            const values = objectStore.getAll();
            tx.oncomplete = () => {
                const entries = {};
                keys.result.forEach((key, index) => {
                    if (typeof key === 'string') entries[key] = values.result[index];
                });
                db.close();
                resolve(entries);
            };
            tx.onerror = () => {
                db.close();
                resolve({});
            };
        };
    });

    return result;
})()
`;

const writeScript = (payload: LegacyStorage) => `
(async () => {
    const payload = ${JSON.stringify(payload)};

    for (const [key, value] of Object.entries(payload.localStorage)) {
        localStorage.setItem(key, value);
    }

    const entries = Object.entries(payload.idb);
    if (entries.length === 0) return;

    await new Promise((resolve) => {
        const request = indexedDB.open(${JSON.stringify(IDB_NAME)}, 1);
        request.onerror = () => resolve();
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(${JSON.stringify(IDB_STORE)})) {
                request.result.createObjectStore(${JSON.stringify(IDB_STORE)});
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(${JSON.stringify(IDB_STORE)})) {
                db.close();
                resolve();
                return;
            }
            const tx = db.transaction(${JSON.stringify(IDB_STORE)}, 'readwrite');
            const objectStore = tx.objectStore(${JSON.stringify(IDB_STORE)});
            for (const [key, value] of entries) objectStore.put(value, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                resolve();
            };
        };
    });
})()
`;

/**
 * Copies the renderer's pre-loopback-HTTP `file://` storage into the current origin, once. Call
 * before pointing the main window at its URL, so the settings are already in place by the time the
 * renderer's stores hydrate rather than needing a reload to pick them up.
 *
 * Failure is never fatal: the old bucket is only ever read, so the worst case is that the app
 * starts with the settings it already had.
 */
export async function migrateLegacyRendererStorage(targetOrigin: string): Promise<void> {
    if (store.get(MIGRATED_FLAG) === true) return;

    try {
        const legacy = await readLegacyStorage();

        if (Object.keys(legacy.localStorage).length === 0) {
            log.info({
                message: 'No legacy renderer storage to migrate',
                name: 'StorageMigration',
            });
            store.set(MIGRATED_FLAG, true);
            return;
        }

        await writeCurrentStorage(targetOrigin, legacy);

        log.info({
            message: `Migrated legacy renderer storage: ${Object.keys(legacy.localStorage).length} localStorage keys, ${Object.keys(legacy.idb).length} IndexedDB entries`,
            name: 'StorageMigration',
        });
        store.set(MIGRATED_FLAG, true);
    } catch (error) {
        // Left unflagged so the next launch tries again rather than silently giving up on
        // settings the user can otherwise only recover by hand.
        log.error({
            message: `Failed to migrate legacy renderer storage: ${error instanceof Error ? error.message : String(error)}`,
            name: 'StorageMigration',
        });
    }
}

function createHiddenWindow(): BrowserWindow {
    return new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
}

async function readLegacyStorage(): Promise<LegacyStorage> {
    // Every `file://` page shares one storage partition regardless of path, so an otherwise empty
    // local page reaches the old bucket without loading the real renderer entry point.
    const readerPath = join(app.getPath('userData'), READER_PAGE_FILENAME);
    await writeFile(readerPath, '<!doctype html><title>legacy storage</title>');

    const reader = createHiddenWindow();

    try {
        await reader.loadFile(readerPath);
        return (await reader.webContents.executeJavaScript(READ_SCRIPT)) as LegacyStorage;
    } finally {
        reader.destroy();
    }
}

async function writeCurrentStorage(targetOrigin: string, legacy: LegacyStorage): Promise<void> {
    const writer = createHiddenWindow();

    try {
        await writer.loadURL(`${targetOrigin}${STORAGE_MIGRATION_PATH}`);
        await writer.webContents.executeJavaScript(writeScript(legacy));
    } finally {
        writer.destroy();
    }
}
