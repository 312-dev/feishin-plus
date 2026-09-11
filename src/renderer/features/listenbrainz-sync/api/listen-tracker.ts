import {
    LbListen,
    MAX_PAGES_PER_PASS,
    walkBack,
} from '/@/renderer/features/discover/api/listen-index-api';
import { artistVariants, normalizeName } from '/@/renderer/features/discover/utils/library-match';
import {
    getListenTrackCursor,
    recordListen,
    setListenTrackCursor,
} from '/@/renderer/features/listenbrainz-sync/listen-track-store';
import { EligibleTrack } from '/@/renderer/features/listenbrainz-sync/playlist-sync';
import { logger } from '/@/renderer/utils/logger';

/**
 * Walks ListenBrainz history for the tracks this feature can manage, independent of Discover's
 * own walk (`syncListenIndex`) and of whatever page is open.
 *
 * Structured the same way as `syncListenIndex`: a forward catch-up from the stored cursor first,
 * then - once that isn't yet complete - a bounded backward pass capped at `MAX_PAGES_PER_PASS`
 * for the same reason Discover's walk is capped (ListenBrainz drops the connection past about
 * thirty pages fetched back to back). The cursor is always written back, even after a pass that
 * stopped early, so a long first-run backfill resumes rather than restarts.
 */
export async function syncListenTracker(
    username: string,
    eligible: EligibleTrack[],
    signal?: AbortSignal,
): Promise<void> {
    const eligibleMbids = new Set(eligible.map((track) => track.recordingMbid));
    const trackKeyToMbids = buildTrackKeyIndex(eligible);

    const cursor = getListenTrackCursor();
    let { isComplete, oldestTs } = cursor;
    let latestTs = cursor.latestTs;

    const absorb = (listens: LbListen[]) => {
        for (const listen of listens) {
            const mbid = resolveEligibleMbid(listen, eligibleMbids, trackKeyToMbids);

            if (mbid) {
                recordListen(mbid, listen.listened_at);
            }
        }

        latestTs = Math.max(latestTs, listens[0]?.listened_at ?? 0);
    };

    try {
        if (latestTs > 0) {
            await walkBack(username, {
                fromTs: null,
                onPage: absorb,
                signal,
                stopAtTs: latestTs,
            });
        }

        if (!isComplete) {
            try {
                const result = await walkBack(username, {
                    fromTs: oldestTs,
                    maxPages: MAX_PAGES_PER_PASS,
                    onPage: (listens) => {
                        absorb(listens);
                        oldestTs = listens[listens.length - 1].listened_at;
                    },
                    signal,
                    stopAtTs: null,
                });

                isComplete = result.reachedEnd;
            } catch (error) {
                if (signal?.aborted || (error as Error).name === 'AbortError') {
                    throw error;
                }

                logger.warn(
                    `Unlistened-playlist listen backfill stopped early: ${(error as Error).message}`,
                );
            }
        }
    } finally {
        setListenTrackCursor({ isComplete, latestTs, oldestTs });
    }
}

/** Reverse of `EligibleTrack.trackKey -> recordingMbid[]`, rebuilt fresh from each tick's snapshot. */
function buildTrackKeyIndex(eligible: EligibleTrack[]): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const track of eligible) {
        const existing = index.get(track.trackKey);

        if (existing) {
            existing.push(track.recordingMbid);
        } else {
            index.set(track.trackKey, [track.recordingMbid]);
        }
    }

    return index;
}

/**
 * Resolves a listen to one of the eligible library's recording MBIDs, or null when it isn't one.
 *
 * `mbid_mapping` first, the same priority `listen-index-api.ts` gives it - it's the only field
 * reliably populated. A listen with no mapping falls back to the normalized `artist|title` key
 * the rest of Discover matches library tracks against.
 */
function resolveEligibleMbid(
    listen: LbListen,
    eligibleMbids: Set<string>,
    trackKeyToMbids: Map<string, string[]>,
): null | string {
    const meta = listen.track_metadata;
    const mapped =
        meta.mbid_mapping?.recording_mbid ?? meta.additional_info?.recording_mbid ?? null;

    if (mapped && eligibleMbids.has(mapped)) {
        return mapped;
    }

    const title = normalizeName(meta.track_name);

    for (const artist of artistVariants(meta.artist_name)) {
        const candidates = trackKeyToMbids.get(`${artist}|${title}`);

        // Ambiguous when several eligible recordings share a normalized key (a single and an
        // album cut of the same song, say); the first is as good a guess as any, and this path
        // only runs for the minority of listens that arrive with no MBID at all.
        if (candidates?.length) {
            return candidates[0];
        }
    }

    return null;
}
