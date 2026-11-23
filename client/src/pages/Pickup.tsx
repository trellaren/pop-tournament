/**
 * Pickup (`/pickup`): the open lobby, or the button that opens one. A player
 * already in a lobby is sent straight to it.
 */
import React from 'react';
import { Box, Button, Container, Typography } from '@mui/material';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TopNavBar } from '../components/layout/TopNavBar';
import { EmptyPanel, PageHead, Panel } from '../components/common/ui';
import { useTopic } from '../hooks/useTopic';
import { pickupLobbyPath } from '../paths';
import { apiErrorMessage } from '../utils/api';
import { pageTitle } from '../utils/pageTitle';
import {
  PICKUP_TOPIC,
  listPickupLobbies,
  openPickupLobby,
  type PickupSummary,
} from '../components/pickup/pickupApi';
import type { Untrusted } from '../utils/untrusted';

export default function Pickup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lobbies, setLobbies] = React.useState<PickupSummary[] | null>(null);
  const [mine, setMine] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const reload = React.useCallback(() => {
    listPickupLobbies()
      .then((answer) => {
        setLobbies(answer.lobbies);
        setMine(answer.mine);
      })
      .catch((err: Untrusted) => setError(apiErrorMessage(err, t('pickup.error'))));
  }, [t]);

  React.useEffect(reload, [reload]);
  useTopic(PICKUP_TOPIC, reload);

  React.useEffect(() => {
    document.title = pageTitle(t('pickup.title'));
  }, [t]);

  if (mine) return <Navigate to={pickupLobbyPath(mine)} replace />;

  const open = () => {
    setBusy(true);
    setError('');
    openPickupLobby()
      .then((id) => navigate(pickupLobbyPath(id)))
      .catch((err: Untrusted) => {
        setError(apiErrorMessage(err, t('pickup.error')));
        reload();
      })
      .finally(() => setBusy(false));
  };

  return (
    <Box minHeight="100vh" data-testid="pickup-page">
      <TopNavBar />
      <Container maxWidth="md" sx={{ py: { xs: 3, md: 6 } }}>
        <PageHead title={t('pickup.title')} />
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {t('pickup.intro')}
        </Typography>
        {error && (
          <Typography color="error" sx={{ mb: 2 }} role="alert">
            {error}
          </Typography>
        )}
        {lobbies !== null && lobbies.length === 0 && (
          <EmptyPanel title={t('pickup.none')} description={t('pickup.noneHint')} />
        )}
        {(lobbies ?? []).map((lobby) => (
          <Panel
            key={lobby.id}
            sx={{ p: 2, mb: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
          >
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>
                {t('pickup.lobbyOf', { host: lobby.hostName })}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {lobby.format === 'wingman' && `${t('pickup.settings.formatName.wingman')} · `}
                {t('pickup.summary', {
                  seated: lobby.seated,
                  seats: lobby.teamSize * 2,
                  waiting: lobby.waiting,
                })}
              </Typography>
            </Box>
            <Button
              variant="contained"
              data-testid="pickup-view"
              onClick={() => navigate(pickupLobbyPath(lobby.id))}
            >
              {t('pickup.view')}
            </Button>
          </Panel>
        ))}
        {lobbies !== null && lobbies.length === 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Button variant="contained" disabled={busy} data-testid="pickup-open" onClick={open}>
              {t('pickup.open')}
            </Button>
          </Box>
        )}
      </Container>
    </Box>
  );
}
