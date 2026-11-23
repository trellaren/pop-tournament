/**
 * The pickup lobby inside Discord (`/activity`, the Discord Activity): signs
 * in through Discord's Embedded App SDK, then shows the open lobby. The site's
 * cookie does not reach Discord's frame, so requests carry the Activity's
 * token instead (utils/api setApiBearer).
 */
import React from 'react';
import { Box, Button, Container, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { EmptyPanel, PageHead } from '../components/common/ui';
import { apiErrorMessage, setApiBearer } from '../utils/api';
import { PickupLobbyBody } from '../components/pickup/PickupLobbyBody';
import {
  listPickupLobbies,
  openPickupLobby,
  pickupActivityClientId,
  pickupRefusalCode,
  signInToPickupActivity,
} from '../components/pickup/pickupApi';
import { PickupHostContext, type PickupHost } from '../components/pickup/pickupHost';
import type { ActivityHost } from '../components/pickup/activityHost';
import type { Untrusted } from '../utils/untrusted';

type Stage =
  | { name: 'starting' }
  | { name: 'outside' }
  | { name: 'not_configured' }
  | { name: 'not_linked' }
  | { name: 'failed'; message: string }
  | { name: 'ready'; playerId: string };

/** Re-read the lobby this often inside Discord, where the socket may not arrive. */
const POLL_MS = 4000;
/** Sign in again this long before the token runs out. */
const RENEW_EARLY_MS = 5 * 60 * 1000;

async function signIn(
  host: ActivityHost,
  clientId: string
): Promise<{ playerId: string; expiresAt: number }> {
  const code = await host.authorize(clientId);
  const signedIn = await signInToPickupActivity(code);
  setApiBearer(signedIn.token);
  await host.authenticate(signedIn.accessToken);
  return { playerId: signedIn.playerId, expiresAt: signedIn.expiresAt };
}

function useActivity(): { stage: Stage; host: ActivityHost | null } {
  const [stage, setStage] = React.useState<Stage>({ name: 'starting' });
  const [host, setHost] = React.useState<ActivityHost | null>(null);

  React.useEffect(() => {
    let stopped = false;
    let renew: number | undefined;
    const run = async () => {
      const clientId = await pickupActivityClientId();
      if (!clientId) return setStage({ name: 'not_configured' });
      let connected: ActivityHost;
      try {
        const { connectActivityHost } = await import('../components/pickup/activityHost');
        connected = await connectActivityHost(clientId);
      } catch {
        return setStage({ name: 'outside' });
      }
      if (stopped) return undefined;
      setHost(connected);
      const enter = async (): Promise<void> => {
        const { playerId, expiresAt } = await signIn(connected, clientId);
        if (stopped) return;
        setStage({ name: 'ready', playerId });
        const wait = Math.max(60_000, expiresAt * 1000 - Date.now() - RENEW_EARLY_MS);
        renew = window.setTimeout(() => void enter().catch(() => undefined), wait);
      };
      return enter();
    };
    run().catch((error: Untrusted) => {
      if (stopped) return;
      if (pickupRefusalCode(error) === 'not_linked') setStage({ name: 'not_linked' });
      else setStage({ name: 'failed', message: apiErrorMessage(error, '') });
    });
    return () => {
      stopped = true;
      window.clearTimeout(renew);
      setApiBearer(null);
    };
  }, []);

  return { stage, host };
}

/** The open lobby, or the button that opens one. */
function ActivityLobby({ playerId }: { playerId: string }) {
  const { t } = useTranslation();
  const [lobbyId, setLobbyId] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState('');

  const reload = React.useCallback(() => {
    listPickupLobbies()
      .then((answer) => setLobbyId(answer.mine ?? answer.lobbies[0]?.id ?? null))
      .catch((err: Untrusted) => setError(apiErrorMessage(err, t('pickup.error'))))
      .finally(() => setLoaded(true));
  }, [t]);

  React.useEffect(() => {
    if (lobbyId) return undefined;
    reload();
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [lobbyId, reload]);

  if (lobbyId) {
    return (
      <PickupLobbyBody
        lobbyId={lobbyId}
        viewerId={playerId}
        whenGone={
          <Button variant="outlined" sx={{ mt: 2 }} onClick={() => setLobbyId(null)}>
            {t('pickup.back')}
          </Button>
        }
      />
    );
  }
  if (!loaded) return null;
  return (
    <>
      {error && (
        <Typography color="error" sx={{ mb: 2 }} role="alert">
          {error}
        </Typography>
      )}
      <EmptyPanel title={t('pickup.none')} description={t('pickup.noneHint')} />
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
        <Button
          variant="contained"
          data-testid="pickup-open"
          onClick={() => {
            setError('');
            openPickupLobby()
              .then(setLobbyId)
              .catch((err: Untrusted) => setError(apiErrorMessage(err, t('pickup.error'))));
          }}
        >
          {t('pickup.open')}
        </Button>
      </Box>
    </>
  );
}

export default function PickupActivity() {
  const { t } = useTranslation();
  const { stage, host } = useActivity();
  const pickupHost = React.useMemo<PickupHost>(
    () => ({
      openOutside: (path) => host?.openExternal(`${window.location.origin}${path}`),
      pollMs: POLL_MS,
    }),
    [host]
  );

  return (
    <Box minHeight="100vh" data-testid="pickup-activity">
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <PageHead title={t('pickup.title')} />
        {stage.name === 'starting' && <Typography>{t('pickup.activity.starting')}</Typography>}
        {stage.name === 'outside' && (
          <EmptyPanel
            title={t('pickup.activity.outside')}
            description={t('pickup.activity.outsideHint')}
          />
        )}
        {stage.name === 'not_configured' && (
          <EmptyPanel
            title={t('pickup.activity.notConfigured')}
            description={t('pickup.activity.notConfiguredHint')}
          />
        )}
        {stage.name === 'not_linked' && (
          <>
            <EmptyPanel
              title={t('pickup.activity.notLinked')}
              description={t('pickup.activity.notLinkedHint')}
            />
            <Button
              variant="contained"
              sx={{ mt: 2 }}
              onClick={() => host?.openExternal(`${window.location.origin}/`)}
            >
              {t('pickup.activity.openSite')}
            </Button>
          </>
        )}
        {stage.name === 'failed' && (
          <EmptyPanel
            title={t('pickup.activity.failed')}
            description={stage.message || t('pickup.activity.failedHint')}
          />
        )}
        {stage.name === 'ready' && (
          <PickupHostContext.Provider value={pickupHost}>
            <ActivityLobby playerId={stage.playerId} />
          </PickupHostContext.Provider>
        )}
      </Container>
    </Box>
  );
}
