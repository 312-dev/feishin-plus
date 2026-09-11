import { createWithEqualityFn } from 'zustand/traditional';

export type UnlistenedSyncPhase = 'diffing' | 'error' | 'idle' | 'seeding';

/**
 * What the unlistened-playlist sync loop is doing right now, for the Settings status row.
 *
 * Kept outside the settings store and outside idb-keyval, same reasoning as
 * `discover-sync-store.ts`: none of it should survive a restart. A resumed run recomputes its
 * progress from the playlist's real contents rather than trusting a stale reading.
 */
export interface UnlistenedSyncState {
    added: number;
    /** How many of the "New to you" row's current items carry a usable recording MBID. */
    coverageCount: number;
    lastError: null | string;
    lastSyncedAt: null | number;
    phase: UnlistenedSyncPhase;
    removed: number;
    /** How many items the "New to you" row currently holds, trackable or not. */
    totalEligible: number;
}

const IDLE: UnlistenedSyncState = {
    added: 0,
    coverageCount: 0,
    lastError: null,
    lastSyncedAt: null,
    phase: 'idle',
    removed: 0,
    totalEligible: 0,
};

export const useUnlistenedSyncStore = createWithEqualityFn<UnlistenedSyncState>(() => IDLE);

export function setUnlistenedSyncState(patch: Partial<UnlistenedSyncState>): void {
    useUnlistenedSyncStore.setState(patch);
}

export const useUnlistenedSync = () => useUnlistenedSyncStore((state) => state);
