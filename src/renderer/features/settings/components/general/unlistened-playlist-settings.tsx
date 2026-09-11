import isElectron from 'is-electron';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { triggerUnlistenedSync } from '/@/renderer/features/listenbrainz-sync/hooks/use-unlistened-sync';
import {
    getListenBrainzToken,
    setListenBrainzToken,
} from '/@/renderer/features/listenbrainz-sync/listenbrainz-token';
import { useUnlistenedSync } from '/@/renderer/features/listenbrainz-sync/unlistened-sync-store';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useGeneralSettings, useSettingsStoreActions } from '/@/renderer/store';
import { formatDateRelative } from '/@/renderer/utils/format';
import { Button } from '/@/shared/components/button/button';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { useDebouncedCallback } from '/@/shared/hooks/use-debounced-callback';

const localSettings = isElectron() ? window.api.localSettings : null;

export const UnlistenedPlaylistSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useGeneralSettings();
    const { setSettings } = useSettingsStoreActions();
    const sync = useUnlistenedSync();

    const [localToken, setLocalToken] = useState('');

    useEffect(() => {
        getListenBrainzToken().then((token) => setLocalToken(token ?? ''));
    }, []);

    const debouncedSetToken = useDebouncedCallback((value: string) => {
        setListenBrainzToken(value.trim());
    }, 500);

    // This feature has no meaning on the web/Docker build: there's no main process to hold a
    // safeStorage-encrypted token for it. Same treatment other window.api-dependent settings get.
    if (!localSettings) {
        return null;
    }

    const hasUsername = Boolean(settings.listenBrainzUsername);

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    defaultChecked={settings.unlistenedPlaylistEnabled}
                    disabled={!hasUsername}
                    onChange={(e) => {
                        setSettings({
                            general: { unlistenedPlaylistEnabled: e.currentTarget.checked },
                        });
                    }}
                />
            ),
            description: hasUsername
                ? t('setting.unlistenedPlaylist', { context: 'description' })
                : t('setting.unlistenedPlaylistNeedsUsername'),
            title: t('setting.unlistenedPlaylist'),
        },
        {
            control: (
                <PasswordInput
                    onChange={(e) => {
                        const value = e.currentTarget.value;
                        setLocalToken(value);
                        debouncedSetToken(value);
                    }}
                    value={localToken}
                    width={280}
                />
            ),
            description: t('setting.unlistenedPlaylistToken', { context: 'description' }),
            isHidden: !settings.unlistenedPlaylistEnabled,
            title: t('setting.unlistenedPlaylistToken'),
        },
        {
            control: (
                <Button onClick={() => triggerUnlistenedSync()} size="compact-md" variant="filled">
                    {t('setting.unlistenedPlaylistSyncNow')}
                </Button>
            ),
            description: (
                <Text isMuted size="sm">
                    {t('setting.unlistenedPlaylistCoverage', {
                        count: sync.coverageCount,
                        total: sync.totalEligible,
                    })}
                    {' · '}
                    {sync.lastSyncedAt
                        ? t('setting.unlistenedPlaylistLastSync', {
                              time: formatDateRelative(new Date(sync.lastSyncedAt).toISOString()),
                          })
                        : t('setting.unlistenedPlaylistLastSyncNever')}
                    {sync.lastError && (
                        <>
                            {' · '}
                            {t('setting.unlistenedPlaylistError', { message: sync.lastError })}
                        </>
                    )}
                </Text>
            ),
            isHidden: !settings.unlistenedPlaylistEnabled,
            title: t('setting.unlistenedPlaylistStatus'),
        },
    ];

    return <SettingsSection options={options} title={t('setting.unlistenedPlaylist')} />;
});
