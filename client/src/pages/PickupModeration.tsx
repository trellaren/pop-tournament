/**
 * Pickup moderation (`/pickup/moderation`): bans from pickup for moderators
 * and admins; moderators, balance multipliers and display names for site
 * admins only.
 */
import React from 'react';
import { Box, Button, Container, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { TopNavBar } from '../components/layout/TopNavBar';
import { EmptyPanel, PageHead } from '../components/common/ui';
import { paths } from '../paths';
import { apiErrorMessage } from '../utils/api';
import { pageTitle } from '../utils/pageTitle';
import type { Untrusted } from '../utils/untrusted';
import { BansCard } from '../components/pickup/moderation/BansCard';
import { ModeratorsCard } from '../components/pickup/moderation/ModeratorsCard';
import { PlayersCard } from '../components/pickup/moderation/PlayersCard';
import {
  liftPickupBan,
  readPickupModeration,
  setPickupModerator,
  setPickupPlayer,
  type PickupModerationView,
} from '../components/pickup/moderation/moderationApi';

export default function PickupModeration() {
  const { t } = useTranslation();
  const [view, setView] = React.useState<PickupModerationView | null>(null);
  const [refused, setRefused] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const reload = React.useCallback(() => {
    readPickupModeration()
      .then(setView)
      .catch(() => setRefused(true));
  }, []);

  React.useEffect(reload, [reload]);
  React.useEffect(() => {
    document.title = pageTitle(t('pickup.moderation.title'));
  }, [t]);

  const run = (work: Promise<void>) => {
    setBusy(true);
    setError('');
    work
      .catch((err: Untrusted) => setError(apiErrorMessage(err, t('pickup.error'))))
      .finally(() => {
        setBusy(false);
        reload();
      });
  };

  return (
    <Box minHeight="100vh" data-testid="pickup-moderation-page">
      <TopNavBar />
      <Container maxWidth="md" sx={{ py: { xs: 3, md: 6 } }}>
        <PageHead title={t('pickup.moderation.title')} />
        <Button component={RouterLink} to={paths.pickup} size="small" sx={{ mb: 2 }}>
          {t('pickup.moderation.back')}
        </Button>
        {error && (
          <Typography color="error" sx={{ mb: 2 }} role="alert">
            {error}
          </Typography>
        )}
        {refused && !view && (
          <EmptyPanel
            title={t('pickup.moderation.refused')}
            description={t('pickup.moderation.refusedHint')}
          />
        )}
        {view && (
          <>
            <BansCard
              bans={view.bans}
              busy={busy}
              onLift={(playerId) => run(liftPickupBan(playerId))}
              onChanged={reload}
            />
            {view.moderators && (
              <ModeratorsCard
                moderators={view.moderators}
                busy={busy}
                onSet={(playerId, on) => run(setPickupModerator(playerId, on))}
              />
            )}
            {view.players && (
              <PlayersCard
                players={view.players}
                busy={busy}
                onSave={(playerId, change) => run(setPickupPlayer(playerId, change))}
              />
            )}
          </>
        )}
      </Container>
    </Box>
  );
}
