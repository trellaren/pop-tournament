/** One pickup lobby (`/pickup/:id`); the lobby itself is components/pickup/PickupLobbyBody. */
import React from 'react';
import { Box, Button, Container } from '@mui/material';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TopNavBar } from '../components/layout/TopNavBar';
import { PageHead } from '../components/common/ui';
import { useAuth } from '../contexts/AuthContext';
import { paths } from '../paths';
import { pageTitle } from '../utils/pageTitle';
import { PickupLobbyBody } from '../components/pickup/PickupLobbyBody';

export default function PickupLobby() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { playerSteamId } = useAuth();

  React.useEffect(() => {
    document.title = pageTitle(t('pickup.title'));
  }, [t]);

  return (
    <Box minHeight="100vh" data-testid="pickup-lobby-page">
      <TopNavBar />
      <Container maxWidth="lg" sx={{ py: { xs: 3, md: 6 } }}>
        <PageHead title={t('pickup.title')} />
        <PickupLobbyBody
          lobbyId={id}
          viewerId={playerSteamId ?? null}
          whenGone={
            <Button component={RouterLink} to={paths.pickup} variant="outlined" sx={{ mt: 2 }}>
              {t('pickup.back')}
            </Button>
          }
        />
      </Container>
    </Box>
  );
}
