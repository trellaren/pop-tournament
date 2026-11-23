/**
 * One pickup lobby (`/pickup/:id`): Team A, the settings and the host's
 * controls, Team B; the waiting room and the log below.
 */
import React from 'react';
import { Box, Button, Container, Typography } from '@mui/material';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TopNavBar } from '../components/layout/TopNavBar';
import { EmptyPanel, PageHead } from '../components/common/ui';
import { useAuth } from '../contexts/AuthContext';
import { paths } from '../paths';
import { apiErrorMessage } from '../utils/api';
import { pageTitle } from '../utils/pageTitle';
import { PickupControls } from '../components/pickup/PickupControls';
import { PickupDraftBanner, PickupDraftPool } from '../components/pickup/PickupDraft';
import { PickupLog } from '../components/pickup/PickupLog';
import { PickupStatus } from '../components/pickup/PickupStatus';
import { PickupTeamPanel } from '../components/pickup/PickupTeamPanel';
import {
  pickupRefusalCode,
  sendPickupCommand,
  usePickupLobby,
  type PickupCommand,
} from '../components/pickup/pickupApi';
import type { Untrusted } from '../utils/untrusted';

export default function PickupLobby() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { playerSteamId } = useAuth();
  const { lobby, ready, missing, reload } = usePickupLobby(id);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    document.title = pageTitle(t('pickup.title'));
  }, [t]);

  const onCommand = (command: PickupCommand) => {
    if (!id) return;
    setBusy(true);
    setError('');
    sendPickupCommand(id, command)
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

  const backToList = (
    <Button component={RouterLink} to={paths.pickup} variant="outlined" sx={{ mt: 2 }}>
      {t('pickup.back')}
    </Button>
  );

  return (
    <Box minHeight="100vh" data-testid="pickup-lobby-page">
      <TopNavBar />
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 6 } }}>
        <PageHead title={t('pickup.title')} />
        {error && (
          <Typography color="error" sx={{ mb: 2 }} role="alert" data-testid="pickup-error">
            {error}
          </Typography>
        )}
        {ready && (missing || !lobby) && (
          <>
            <EmptyPanel title={t('pickup.missing')} description={t('pickup.missingHint')} />
            {backToList}
          </>
        )}
        {lobby && lobby.state === 'closed' && (
          <>
            <EmptyPanel title={t('pickup.closed')} description={t('pickup.closedHint')} />
            {backToList}
          </>
        )}
        {lobby && lobby.state !== 'closed' && (
          <>
            <PickupStatus lobby={lobby} busy={busy} onCommand={onCommand} onDeadline={reload} />
            <PickupDraftBanner
              lobby={lobby}
              busy={busy}
              onCommand={onCommand}
              onDeadline={reload}
            />
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
                viewerId={playerSteamId ?? null}
                busy={busy}
                onCommand={onCommand}
              />
              <PickupControls lobby={lobby} busy={busy} onCommand={onCommand} />
              <PickupTeamPanel
                lobby={lobby}
                side="b"
                viewerId={playerSteamId ?? null}
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
                viewerId={playerSteamId ?? null}
                busy={busy}
                onCommand={onCommand}
              />
              <PickupLog lines={lobby.log} />
            </Box>
          </>
        )}
      </Container>
    </Box>
  );
}
