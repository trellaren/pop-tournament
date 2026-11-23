/**
 * The pickup lobby itself: Team A, the settings and the host's controls,
 * Team B; the waiting room and the log below. Shown by the lobby page and by
 * the Discord Activity.
 */
import React from 'react';
import { Box, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { EmptyPanel } from '../common/ui';
import { apiErrorMessage } from '../../utils/api';
import { PickupControls } from './PickupControls';
import { PickupDraftBanner, PickupDraftPool } from './PickupDraft';
import { PickupLog } from './PickupLog';
import { PickupStatus } from './PickupStatus';
import { PickupTeamPanel } from './PickupTeamPanel';
import {
  pickupRefusalCode,
  sendPickupCommand,
  usePickupLobby,
  type PickupCommand,
} from './pickupApi';
import type { Untrusted } from '../../utils/untrusted';

interface PickupLobbyBodyProps {
  lobbyId: string | undefined;
  viewerId: string | null;
  /** Shown under "this lobby is closed" and "does not exist": the way back. */
  whenGone: React.ReactNode;
}

export function PickupLobbyBody({ lobbyId, viewerId, whenGone }: PickupLobbyBodyProps) {
  const { t } = useTranslation();
  const { lobby, ready, missing, reload } = usePickupLobby(lobbyId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const onCommand = (command: PickupCommand) => {
    if (!lobbyId) return;
    setBusy(true);
    setError('');
    sendPickupCommand(lobbyId, command)
      .catch((err: Untrusted) => {
        const code = pickupRefusalCode(err);
        setError(
          code
            ? t(`pickup.refusal.${code}`, apiErrorMessage(err, t('pickup.error')))
            : apiErrorMessage(err, t('pickup.error'))
        );
      })
      .finally(() => {
        setBusy(false);
        reload();
      });
  };

  return (
    <>
      {error && (
        <Typography color="error" sx={{ mb: 2 }} role="alert" data-testid="pickup-error">
          {error}
        </Typography>
      )}
      {ready && (missing || !lobby) && (
        <>
          <EmptyPanel title={t('pickup.missing')} description={t('pickup.missingHint')} />
          {whenGone}
        </>
      )}
      {lobby && lobby.state === 'closed' && (
        <>
          <EmptyPanel title={t('pickup.closed')} description={t('pickup.closedHint')} />
          {whenGone}
        </>
      )}
      {lobby && lobby.state !== 'closed' && (
        <>
          <PickupStatus lobby={lobby} busy={busy} onCommand={onCommand} onDeadline={reload} />
          <PickupDraftBanner lobby={lobby} busy={busy} onCommand={onCommand} onDeadline={reload} />
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', md: '1fr minmax(220px, 280px) 1fr' },
              alignItems: 'start',
            }}
          >
            <PickupTeamPanel
              lobby={lobby}
              side="a"
              viewerId={viewerId}
              busy={busy}
              onCommand={onCommand}
            />
            <PickupControls lobby={lobby} busy={busy} onCommand={onCommand} />
            <PickupTeamPanel
              lobby={lobby}
              side="b"
              viewerId={viewerId}
              busy={busy}
              onCommand={onCommand}
            />
          </Box>
          <Box sx={{ display: 'grid', gap: 2, mt: 2 }}>
            {lobby.draft ? (
              <PickupDraftPool
                lobby={lobby}
                busy={busy}
                onCommand={onCommand}
                onDeadline={reload}
              />
            ) : null}
            <PickupTeamPanel
              lobby={lobby}
              side={null}
              viewerId={viewerId}
              busy={busy}
              onCommand={onCommand}
            />
            <PickupLog lines={lobby.log} />
          </Box>
        </>
      )}
    </>
  );
}
