import dayjs from 'dayjs';

import { LbPlaylistTrack } from '/@/renderer/features/discover/api/listenbrainz-types';
import { recordingMbidFromIdentifier } from '/@/renderer/features/discover/utils/lb-adapters';
import { artistVariants, normalizeName } from '/@/renderer/features/discover/utils/library-match';
import {
    addPlaylistItems,
    deletePlaylistItems,
    ListenBrainzAuthError,
    MAX_RECORDINGS_PER_ADD,
} from '/@/renderer/features/listenbrainz-sync/api/listenbrainz-write-api';
import { logger } from '/@/renderer/utils/logger';

/**
 * One Discover "New to you" suggestion this feature can place on a ListenBrainz playlist.
 *
 * Deliberately not every item the row showed: ListenBrainz's `item/add` endpoint only accepts a
 * recording MBID as a track's identifier (there's no title/creator-only add path), so a
 * suggestion the row couldn't map to MusicBrainz can never be represented here, whatever else is
 * true about it.
 */
export interface EligibleTrack {
    recordingMbid: string;
    trackKey: string;
}

export interface PlaylistDiff {
    toAdd: string[];
    toRemoveRanges: RemovalRange[];
}

export interface RemovalRange {
    count: number;
    index: number;
}

interface ApplyDiffResult {
    addedOk: number;
    removedOk: number;
}

/**
 * Applies a diff through the shared rate-limited client.
 *
 * Removals first and in descending-index order (guaranteed by `diffPlaylist`): `item/delete`
 * addresses the playlist's *current* order, so deleting a low index before a higher one would
 * shift everything after it and delete the wrong tracks. A 401 stops the whole pass immediately
 * rather than burning the rest of a seed against a token that will never succeed; any other
 * per-chunk failure is logged and left for the next tick's diff to retry.
 */
export async function applyPlaylistDiff(
    playlistMbid: string,
    diff: PlaylistDiff,
    token: string,
    signal?: AbortSignal,
): Promise<ApplyDiffResult> {
    let addedOk = 0;
    let removedOk = 0;

    for (const range of diff.toRemoveRanges) {
        try {
            await deletePlaylistItems(playlistMbid, range.index, range.count, token, signal);
            removedOk += range.count;
        } catch (error) {
            if (error instanceof ListenBrainzAuthError) {
                throw error;
            }

            logger.warn(
                `Unlistened playlist: failed to remove a range: ${(error as Error).message}`,
            );
        }
    }

    for (let i = 0; i < diff.toAdd.length; i += MAX_RECORDINGS_PER_ADD) {
        const chunk = diff.toAdd.slice(i, i + MAX_RECORDINGS_PER_ADD);

        try {
            await addPlaylistItems(playlistMbid, chunk, token, signal);
            addedOk += chunk.length;
        } catch (error) {
            if (error instanceof ListenBrainzAuthError) {
                throw error;
            }

            logger.warn(`Unlistened playlist: failed to add a chunk: ${(error as Error).message}`);
        }
    }

    return { addedOk, removedOk };
}

/**
 * Every eligible recording that should be on the playlist right now: never listened to, or
 * listened to but not yet past its calendar-day rollover. Pure and evaluated fresh every tick,
 * rather than scheduling a timer per track.
 */
export function computeDesiredUnlistened(
    eligible: EligibleTrack[],
    listenedAt: Record<string, number>,
    now: Date,
): Set<string> {
    const desired = new Set<string>();

    for (const track of eligible) {
        const listened = listenedAt[track.recordingMbid];

        if (listened === undefined || !hasRolledOver(listened, now)) {
            desired.add(track.recordingMbid);
        }
    }

    return desired;
}

/**
 * What has to change to take the playlist's actual current contents to `desired`.
 *
 * `current` should always be read fresh for this call - the read query's own cache is tuned for
 * a weekly-generated playlist and is wrong for one this feature mutates continuously, so a
 * stale copy here would just re-derive last tick's diff.
 */
export function diffPlaylist(desired: Set<string>, current: LbPlaylistTrack[]): PlaylistDiff {
    const currentMbids = current.map((track) => recordingMbidFromIdentifier(track.identifier));
    const presentMbids = new Set(currentMbids.filter((mbid): mbid is string => mbid !== null));

    const toAdd = [...desired].filter((mbid) => !presentMbids.has(mbid));

    // Anything currently on the playlist that either never resolved to a recording MBID (this
    // feature could not have added it) or has since rolled over leaves the playlist.
    const removeIndices: number[] = [];

    currentMbids.forEach((mbid, index) => {
        if (mbid === null || !desired.has(mbid)) {
            removeIndices.push(index);
        }
    });

    return { toAdd, toRemoveRanges: coalesceDescending(removeIndices) };
}

/**
 * Reduces the "New to you" row's items to the ones this feature can act on.
 *
 * Every adapter in `lb-adapters.ts` already resolves `DiscoverItem.recordingMbid` to either a
 * genuine MusicBrainz UUID or null - a synthesised fallback id, when one exists, lives in `id`
 * instead - so nothing further needs validating here beyond the null check. `trackKey` variants
 * (from `artistVariants`) are what let a listen with no `mbid_mapping` still resolve back to one
 * of these recordings in `listen-tracker.ts`.
 */
export function eligibleTracksFromRow(
    items: Array<{ artistName: string; recordingMbid: null | string; title: string }>,
): EligibleTrack[] {
    const seen = new Set<string>();
    const tracks: EligibleTrack[] = [];

    for (const item of items) {
        if (!item.recordingMbid) {
            continue;
        }

        const title = normalizeName(item.title);

        for (const artist of artistVariants(item.artistName)) {
            if (!artist) {
                continue;
            }

            const trackKey = `${artist}|${title}`;
            const dedupeKey = `${item.recordingMbid}|${trackKey}`;

            if (seen.has(dedupeKey)) {
                continue;
            }

            seen.add(dedupeKey);
            tracks.push({ recordingMbid: item.recordingMbid, trackKey });
        }
    }

    return tracks;
}

/**
 * True once a full calendar day (local time) has passed since the day `listenedAtMs` fell on.
 *
 * Local rather than UTC, unlike `use-app-tracker`'s once-per-day gate: that one dedupes an
 * analytics ping across timezones, this one means "the next day" the way a person living in one
 * timezone means it.
 */
export function hasRolledOver(listenedAtMs: number, now: Date): boolean {
    const rolloverAt = dayjs(listenedAtMs).startOf('day').add(1, 'day').valueOf();

    return now.getTime() >= rolloverAt;
}

/** Ascending indices collapsed into contiguous `{index, count}` ranges, highest range first. */
function coalesceDescending(indices: number[]): RemovalRange[] {
    const ranges: RemovalRange[] = [];

    for (let i = 0; i < indices.length; ) {
        const start = indices[i];
        let end = start;
        let j = i + 1;

        while (j < indices.length && indices[j] === end + 1) {
            end = indices[j];
            j += 1;
        }

        ranges.push({ count: end - start + 1, index: start });
        i = j;
    }

    return ranges.reverse();
}
