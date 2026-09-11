import { del, get, set } from 'idb-keyval';
import { persist } from 'zustand/middleware';
import { createWithEqualityFn } from 'zustand/traditional';

/**
 * When each eligible library track was first seen listened to, plus this loop's own walk
 * position and the playlist it maintains.
 *
 * Not `ListenIndexData` (`listen-index-api.ts`): that struct only keeps two flat `Set`s and two
 * global cursors for "has this ever been heard", with no per-recording timestamp and no notion
 * of a calendar-day rollover. It's also Discover's own cache, walked only while Discover is
 * open, where this loop runs regardless of the open page and needs its own walk position.
 *
 * Idb-keyval backed rather than the settings store: this is machine-generated state, unbounded
 * in the number of keys it can hold, and has no business in a blob that's covered by
 * settings export/import.
 */
interface ListenTrackPersisted {
    /** True once this loop's own backward walk has reached the beginning of history. */
    isComplete: boolean;
    /** Newest listen this loop has absorbed. The stop line for its own forward catch-up. */
    latestTs: number;
    /**
     * Recording MBID to the first `listened_at` this loop ever saw for it, epoch ms.
     *
     * Insert-only: a track already present keeps its original timestamp. That's what makes the
     * value mean "when the rollover clock started" rather than "the most recent listen" - and
     * it's also why entries are never overwritten, only pruned (see `pruneListenedAt`) once a
     * track leaves the eligible set entirely.
     */
    listenedAt: Record<string, number>;
    /** Oldest listen this loop has absorbed. Where an interrupted first walk resumes from. */
    oldestTs: null | number;
    /** The ListenBrainz playlist this loop created and maintains, once one exists. */
    playlistMbid: null | string;
}

interface ListenTrackState extends ListenTrackPersisted {
    pruneListenedAt: (validMbids: Set<string>) => void;
    recordListen: (recordingMbid: string, listenedAt: number) => void;
    setCursor: (cursor: Pick<ListenTrackPersisted, 'isComplete' | 'latestTs' | 'oldestTs'>) => void;
    setPlaylistMbid: (playlistMbid: null | string) => void;
}

const INITIAL: ListenTrackPersisted = {
    isComplete: false,
    latestTs: 0,
    listenedAt: {},
    oldestTs: null,
    playlistMbid: null,
};

const listenTrackStorage = {
    getItem: async (name: string) => {
        const value = await get<ListenTrackPersisted>(name);

        if (value === undefined) {
            return null;
        }

        return { state: value, version: 1 } as const;
    },
    removeItem: async (name: string) => {
        await del(name);
    },
    setItem: async (name: string, value: { state: ListenTrackPersisted }) => {
        const { isComplete, latestTs, listenedAt, oldestTs, playlistMbid } = value.state;

        await set(name, { isComplete, latestTs, listenedAt, oldestTs, playlistMbid });
    },
};

export const useListenTrackStoreBase = createWithEqualityFn<ListenTrackState>()(
    persist(
        (set) => ({
            ...INITIAL,
            pruneListenedAt: (validMbids) => {
                set((state) => ({
                    listenedAt: Object.fromEntries(
                        Object.entries(state.listenedAt).filter(([mbid]) => validMbids.has(mbid)),
                    ),
                }));
            },
            recordListen: (recordingMbid, listenedAt) => {
                set((state) =>
                    recordingMbid in state.listenedAt
                        ? state
                        : { listenedAt: { ...state.listenedAt, [recordingMbid]: listenedAt } },
                );
            },
            setCursor: (cursor) => set(cursor),
            setPlaylistMbid: (playlistMbid) => set({ playlistMbid }),
        }),
        {
            name: 'unlistened-playlist-listen-track',
            storage: listenTrackStorage,
            version: 1,
        },
    ),
);

export function getListenedAt(): Record<string, number> {
    return useListenTrackStoreBase.getState().listenedAt;
}

export function getListenTrackCursor(): Pick<
    ListenTrackPersisted,
    'isComplete' | 'latestTs' | 'oldestTs'
> {
    const { isComplete, latestTs, oldestTs } = useListenTrackStoreBase.getState();

    return { isComplete, latestTs, oldestTs };
}

export function getUnlistenedPlaylistMbid(): null | string {
    return useListenTrackStoreBase.getState().playlistMbid;
}

export function pruneListenedAt(validMbids: Set<string>): void {
    useListenTrackStoreBase.getState().pruneListenedAt(validMbids);
}

export function recordListen(recordingMbid: string, listenedAt: number): void {
    useListenTrackStoreBase.getState().recordListen(recordingMbid, listenedAt);
}

export function setListenTrackCursor(
    cursor: Pick<ListenTrackPersisted, 'isComplete' | 'latestTs' | 'oldestTs'>,
): void {
    useListenTrackStoreBase.getState().setCursor(cursor);
}

export function setUnlistenedPlaylistMbid(playlistMbid: null | string): void {
    useListenTrackStoreBase.getState().setPlaylistMbid(playlistMbid);
}

/** Reactive form of `getUnlistenedPlaylistMbid`, for a component that needs to re-render once the first sync creates the playlist. */
export function useUnlistenedPlaylistMbid(): null | string {
    return useListenTrackStoreBase((state) => state.playlistMbid);
}

/**
 * Resolves once the idb-keyval-backed store has loaded its persisted state.
 *
 * `persist` hydrates asynchronously, so a read taken right after the store is created (e.g. the
 * sync loop's first tick, which fires on mount) can see the pre-hydration default instead of a
 * previously-stored playlist mbid - the loop mistakes "not loaded yet" for "never created one"
 * and makes a duplicate playlist every app launch. Callers that read `getUnlistenedPlaylistMbid`
 * before doing anything else must await this first.
 */
export function whenListenTrackHydrated(): Promise<void> {
    if (useListenTrackStoreBase.persist.hasHydrated()) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const unsubscribe = useListenTrackStoreBase.persist.onFinishHydration(() => {
            unsubscribe();
            resolve();
        });
    });
}
