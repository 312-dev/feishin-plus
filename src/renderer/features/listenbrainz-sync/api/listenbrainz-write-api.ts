import { LB_API, RATE_LIMIT_RETRIES } from '/@/renderer/features/discover/api/listenbrainz-api';
import { lbRequest } from '/@/renderer/features/discover/api/listenbrainz-rate-limit';

/**
 * The playlist write endpoints, which need `Authorization: Token <token>` - unlike every other
 * call in `listenbrainz-api.ts`, which is an unauthenticated public GET. Kept as a sibling file
 * rather than added to that one: these are POST mutations behind their own auth concern, not
 * another read-only `queryOptions` factory.
 *
 * Endpoint shapes below are taken from the ListenBrainz server's own view functions
 * (`playlist_api.py`), not the prose docs, which don't document the response bodies.
 */

/** Thrown when ListenBrainz rejects the stored token outright, distinct from a transient failure. */
export class ListenBrainzAuthError extends Error {
    constructor() {
        super('ListenBrainz rejected the stored token');
        this.name = 'ListenBrainzAuthError';
    }
}

/** The server's own `MAX_RECORDINGS_PER_ADD` - a call over this is rejected outright, not partial. */
export const MAX_RECORDINGS_PER_ADD = 100;

const RECORDING_URI_PREFIX = 'https://musicbrainz.org/recording/';

/** Appends recordings to the end of the playlist. Callers chunk to `MAX_RECORDINGS_PER_ADD`. */
export async function addPlaylistItems(
    playlistMbid: string,
    recordingMbids: string[],
    token: string,
    signal?: AbortSignal,
): Promise<void> {
    if (recordingMbids.length === 0) {
        return;
    }

    await lbFetchAuthed(
        `/playlist/${playlistMbid}/item/add`,
        token,
        {
            body: JSON.stringify({
                playlist: {
                    track: recordingMbids.map((mbid) => ({
                        identifier: [`${RECORDING_URI_PREFIX}${mbid}`],
                    })),
                },
            }),
            method: 'POST',
        },
        signal,
    );
}

/** The JSPF-with-MusicBrainz-extensions namespace ListenBrainz reads `public` etc. under. */
const PLAYLIST_EXTENSION_URI = 'https://musicbrainz.org/doc/jspf#playlist';

/** Creates the empty playlist this feature will maintain, and returns its new mbid. */
export async function createUnlistenedPlaylist(
    username: string,
    title: string,
    token: string,
    signal?: AbortSignal,
): Promise<string> {
    const body = await lbFetchAuthed<{ playlist_mbid: string }>(
        '/playlist/create',
        token,
        {
            // `public` is required, not optional - its absence is a 400, not a default-false.
            // Private by default: this is a housekeeping playlist Feishin manages, not something
            // meant to show up on the user's public ListenBrainz profile.
            body: JSON.stringify({
                playlist: {
                    creator: username,
                    extension: { [PLAYLIST_EXTENSION_URI]: { public: false } },
                    title,
                },
            }),
            method: 'POST',
        },
        signal,
    );

    if (!body?.playlist_mbid) {
        throw new Error('ListenBrainz did not return a playlist mbid');
    }

    return body.playlist_mbid;
}

/** Deletes a contiguous run of `count` tracks starting at `index` in the playlist's current order. */
export async function deletePlaylistItems(
    playlistMbid: string,
    index: number,
    count: number,
    token: string,
    signal?: AbortSignal,
): Promise<void> {
    await lbFetchAuthed(
        `/playlist/${playlistMbid}/item/delete`,
        token,
        {
            body: JSON.stringify({ count, index }),
            method: 'POST',
        },
        signal,
    );
}

async function lbFetchAuthed<T>(
    path: string,
    token: string,
    init: RequestInit,
    signal?: AbortSignal,
): Promise<T | undefined> {
    const headers = {
        ...init.headers,
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
    };

    // Every call here is background sync work, never something a user is watching load - it
    // must never compete with an interactive Discover page for the gate's small reserve.
    let response = await lbRequest(
        `${LB_API}${path}`,
        { ...init, headers, signal },
        { isBackground: true },
    );

    for (let attempt = 0; response.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt += 1) {
        response = await lbRequest(
            `${LB_API}${path}`,
            { ...init, headers, signal },
            { isBackground: true },
        );
    }

    if (response.status === 401) {
        throw new ListenBrainzAuthError();
    }

    if (!response.ok) {
        throw new Error(`ListenBrainz ${response.status} for ${path}`);
    }

    if (response.status === 204) {
        return undefined;
    }

    return response.json() as Promise<T>;
}
