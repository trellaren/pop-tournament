/** One pickup lobby (`/pickup/:id`); the lobby itself is components/pickup/PickupLobbyBody. */
import React from 'react';
import { Box, Button, Container } from '@mui/material';
import { Link as RouterLink, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TopNavBar } from '../components/layout/TopNavBar';
import { PageHead } from '../components/common/ui';
import { useAuth } from '../contexts/AuthContext';
import { paths } from '../paths';
import { pageTitle } from '../utils/pageTitle';
import { PickupLobbyBody } from '../components/pickup/PickupLobbyBody';

const INVITE_PARAM = 'invite';
const storageKey = (lobbyId: string) => `pickup-invite:${lobbyId}`;

/**
 * The invite link's token: read from the address once, kept for this tab (so
 * it survives signing in) and taken out of the address bar.
 */
function useInviteToken(lobbyId: string | undefined): string | null {
  const [params, setParams] = useSearchParams();
  const fromAddress = params.get(INVITE_PARAM);
  const [token, setToken] = React.useState<string | null>(() => {
    if (!lobbyId) return fromAddress;
    try {
      return fromAddress ?? window.sessionStorage.getItem(storageKey(lobbyId));
    } catch {
      return fromAddress;
    }
  });

  React.useEffect(() => {
    if (!fromAddress || !lobbyId) return;
    setToken(fromAddress);
    try {
      window.sessionStorage.setItem(storageKey(lobbyId), fromAddress);
    } catch {
      // Storage is blocked: the token still works until the page is left.
    }
    const next = new URLSearchParams(params);
    next.delete(INVITE_PARAM);
    setParams(next, { replace: true });
  }, [fromAddress, lobbyId, params, setParams]);

  return token;
}

export default function PickupLobby() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { playerSteamId } = useAuth();

  const inviteToken = useInviteToken(id);

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
          inviteToken={inviteToken}
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
