import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { listenbrainzQueries } from '/@/renderer/features/discover/api/listenbrainz-api';
import { LbPlaylistTrack } from '/@/renderer/features/discover/api/listenbrainz-types';
import {
    NEW_TO_YOU_ROW_KEY,
    useDiscoverData,
} from '/@/renderer/features/discover/hooks/use-discover-data';
import { syncListenTracker } from '/@/renderer/features/listenbrainz-sync/api/listen-tracker';
import {
    createUnlistenedPlaylist,
    ListenBrainzAuthError,
} from '/@/renderer/features/listenbrainz-sync/api/listenbrainz-write-api';
import {
    getListenedAt,
    getUnlistenedPlaylistMbid,
    pruneListenedAt,
    setUnlistenedPlaylistMbid,
    whenListenTrackHydrated,
} from '/@/renderer/features/listenbrainz-sync/listen-track-store';
import { getListenBrainzToken } from '/@/renderer/features/listenbrainz-sync/listenbrainz-token';
import {
    applyPlaylistDiff,
    computeDesiredUnlistened,
    diffPlaylist,
    EligibleTrack,
    eligibleTracksFromRow,
} from '/@/renderer/features/listenbrainz-sync/playlist-sync';
import { setUnlistenedSyncState } from '/@/renderer/features/listenbrainz-sync/unlistened-sync-store';
import { useGeneralSettings } from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';

/**
 * How often the loop checks in.
 *
 * The only thing it needs to notice promptly is a calendar-day rollover, not sub-hour listening
 * activity, so this is far looser than Discover's own 20-second backfill cadence - it just needs
 * to run somewhere close to local midnight on most days.
 */
const SYNC_INTERVAL_MS = 1000 * 60 * 20;

const PLAYLIST_TITLE = 'Feishin: Unlistened';

let syncInFlight = false;

/**
 * The latest sync-ready context, refreshed every render of `useUnlistenedSync` (the one instance
 * mounted at `ResponsiveLayout`). The interval below reads this instead of capturing `eligible`
 * in its own closure, so a "New to you" recompute never has to tear down and restart the
 * interval - only the toggle or the signed-in user changes that.
 *
 * Also what the Settings page's "Sync now" button and the dev console helper reach for, since
 * neither has a `useDiscoverData` result of its own to draw from.
 */
let latestContext: null | { client: QueryClient; eligible: EligibleTrack[]; username: string } =
    null;

/**
 * Dev-only clock skew for testing the calendar-day rollover without waiting for real midnight.
 * See the `__unlistenedSync` console helper below. Always zero outside development.
 */
let debugClockOffsetMs = 0;

if (process.env.NODE_ENV === 'development') {
    Object.assign(window, {
        __unlistenedSync: {
            setClockOffsetDays(days: number) {
                debugClockOffsetMs = days * 24 * 60 * 60 * 1000;
                console.info(`[unlistened-sync] clock offset set to ${days} day(s)`);
            },
            async syncNow() {
                if (!latestContext) {
                    console.warn('[unlistened-sync] not ready - enable the feature first');
                    return;
                }

                await runSync(latestContext.username, latestContext.eligible, latestContext.client);
                console.info('[unlistened-sync] manual sync complete');
            },
        },
    });
}

async function ensurePlaylist(
    username: string,
    token: string,
    signal?: AbortSignal,
): Promise<string> {
    const existing = getUnlistenedPlaylistMbid();

    if (existing) {
        return existing;
    }

    const created = await createUnlistenedPlaylist(username, PLAYLIST_TITLE, token, signal);
    setUnlistenedPlaylistMbid(created);

    return created;
}

async function runSync(
    username: string,
    eligible: EligibleTrack[],
    client: QueryClient,
    signal?: AbortSignal,
): Promise<void> {
    const token = await getListenBrainzToken();

    if (!token) {
        return;
    }

    // Must happen before the first read of `getUnlistenedPlaylistMbid` (inside `ensurePlaylist`
    // below) - otherwise a sync that runs right on mount can race the store's async idb-keyval
    // hydration and mistake "not loaded yet" for "never created one".
    await whenListenTrackHydrated();

    pruneListenedAt(new Set(eligible.map((track) => track.recordingMbid)));

    await syncListenTracker(username, eligible, signal);

    let playlistMbid = await ensurePlaylist(username, token, signal);

    setUnlistenedSyncState({ phase: 'seeding' });

    const now = new Date(Date.now() + debugClockOffsetMs);
    const desired = computeDesiredUnlistened(eligible, getListenedAt(), now);

    let current: LbPlaylistTrack[] | undefined;

    try {
        current = await client.fetchQuery({
            ...listenbrainzQueries.playlist(playlistMbid),
            staleTime: 0,
        });
    } catch (error) {
        // The stored playlist is gone - recreate and reseed on the same tick rather than
        // erroring forever. Only a genuine 404 means "deleted"; anything else (a transient
        // read failure, an outage) is left for the next tick to retry.
        if (!(error as Error).message.includes('404')) {
            throw error;
        }

        logger.warn('Unlistened playlist: stored playlist is gone, recreating');
        setUnlistenedPlaylistMbid(null);
        playlistMbid = await ensurePlaylist(username, token, signal);
        current = [];
    }

    setUnlistenedSyncState({ phase: 'diffing' });

    const diff = diffPlaylist(desired, current ?? []);

    try {
        const result = await applyPlaylistDiff(playlistMbid, diff, token, signal);

        setUnlistenedSyncState({
            added: result.addedOk,
            lastError: null,
            lastSyncedAt: Date.now(),
            phase: 'idle',
            removed: result.removedOk,
        });
    } catch (error) {
        if (error instanceof ListenBrainzAuthError) {
            setUnlistenedSyncState({
                lastError: 'ListenBrainz token was rejected',
                phase: 'error',
            });
            return;
        }

        throw error;
    }
}

/**
 * Mounted once at `ResponsiveLayout`, so it keeps running regardless of what page is open.
 *
 * Deliberately keeps Discover's own suggestion pipeline (`useDiscoverData`) mounted here too,
 * rather than only reading whatever the Discover route last computed while it happened to be
 * open - the playlist is meant to track "New to you" continuously. React Query dedupes this
 * against the same hook running inside `DiscoverRoute` when that's also mounted (identical query
 * keys share one cache entry), so this doesn't double the network traffic; it just means the
 * pipeline now runs whenever this toggle is on, not only while Discover is the active page. An
 * empty username disables every query inside `useDiscoverData` (its own `Boolean(username)`
 * gate), which is what keeps this fully inert while the toggle is off.
 */
export const useUnlistenedSync = () => {
    const client = useQueryClient();
    const settings = useGeneralSettings();

    const enabled = settings.unlistenedPlaylistEnabled;
    const username = settings.listenBrainzUsername;

    const { rows } = useDiscoverData(enabled ? username : '');
    const newToYouRow = rows.find((row) => row.key === NEW_TO_YOU_ROW_KEY && !row.isPending);
    const rowItems = newToYouRow?.items;

    const eligible = useMemo(() => (rowItems ? eligibleTracksFromRow(rowItems) : []), [rowItems]);

    useEffect(() => {
        latestContext = enabled && username ? { client, eligible, username } : null;

        setUnlistenedSyncState({
            coverageCount: eligible.length,
            totalEligible: rowItems?.length ?? 0,
        });
    }, [client, enabled, eligible, rowItems, username]);

    useEffect(() => {
        if (!enabled || !username) {
            return;
        }

        const controller = new AbortController();

        const tick = async () => {
            if (syncInFlight || !latestContext) {
                return;
            }

            syncInFlight = true;

            try {
                await runSync(
                    latestContext.username,
                    latestContext.eligible,
                    latestContext.client,
                    controller.signal,
                );
            } catch (error) {
                if (!controller.signal.aborted) {
                    logger.warn(`Unlistened playlist sync failed: ${(error as Error).message}`);
                    setUnlistenedSyncState({ lastError: (error as Error).message, phase: 'error' });
                }
            } finally {
                syncInFlight = false;
            }
        };

        tick();

        const interval = setInterval(tick, SYNC_INTERVAL_MS);

        return () => {
            clearInterval(interval);
            controller.abort();
        };
    }, [enabled, username]);
};

/**
 * Manual trigger behind the Settings page's "Sync now" button.
 *
 * Takes no arguments and reads `latestContext` instead: the caller is a Settings component with
 * no `useDiscoverData` result of its own, and this hook's single always-mounted instance is
 * already keeping that context current.
 */
export function triggerUnlistenedSync(): void {
    if (syncInFlight || !latestContext) {
        return;
    }

    syncInFlight = true;

    runSync(latestContext.username, latestContext.eligible, latestContext.client)
        .catch((error) => {
            logger.warn(`Unlistened playlist manual sync failed: ${(error as Error).message}`);
            setUnlistenedSyncState({ lastError: (error as Error).message, phase: 'error' });
        })
        .finally(() => {
            syncInFlight = false;
        });
}
