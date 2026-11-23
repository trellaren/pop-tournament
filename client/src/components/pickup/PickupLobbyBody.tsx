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
import { PickupBanDialog } from './PickupBanDialog';
import { PickupControls } from './PickupControls';
import { PickupDraftBanner, PickupDraftPool } from './PickupDraft';
import { PickupInvites } from './PickupInvites';
import { PickupLog } from './PickupLog';
import { PickupStatus } from './PickupStatus';
import { PickupSubstitute } from './PickupSubstitute';
import { PickupTeamPanel } from './PickupTeamPanel';
import {
  pickupBanUntil,
  pickupRefusalCode,
  sendPickupCommand,
  usePickupLobby,
  type PickupCommand,
  type PickupPlayer,
} from './pickupApi';
import type { Untrusted } from '../../utils/untrusted';

interface PickupLobbyBodyProps {
  lobbyId: string | undefined;
  viewerId: string | null;
  /** Shown under "this lobby is closed" and "does not exist": the way back. */
  whenGone: React.ReactNode;
  /** The token of the invite link the viewer came by, if any. */
  inviteToken?: string | null;
}

export function PickupLobbyBody({
  lobbyId,
  viewerId,
  whenGone,
  inviteToken = null,
}: PickupLobbyBodyProps) {
  const { t } = useTranslation();
  const { lobby: read, ready, missing, reload } = usePickupLobby(lobbyId);
  // Someone holding an invite link may join a lobby the server says they cannot: the link is
  // checked when they do.
  const byLink = Boolean(inviteToken) && read?.me === null && read.state !== 'closed';
  const lobby = read && byLink ? { ...read, can: { ...read.can, join: true } } : read;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [banning, setBanning] = React.useState<PickupPlayer | null>(null);

  const onCommand = (asked: PickupCommand) => {
    if (!lobbyId) return;
    const command =
      asked.type === 'join' && byLink && inviteToken ? { ...asked, invite: inviteToken } : asked;
    setBusy(true);
    setError('');
    sendPickupCommand(lobbyId, command)
      .catch((err: Untrusted) => {
        const code = pickupRefusalCode(err);
        if (code === 'banned') {
          const until = pickupBanUntil(err);
          setError(
            until === null
              ? t('pickup.refusal.banned')
              : t('pickup.refusal.bannedUntil', { when: new Date(until * 1000).toLocaleString() })
          );
          return;
        }
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
          {lobby.settings.visibility === 'invite' && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 2 }}
              data-testid="pickup-invite-only"
            >
              {lobby.me === null && !lobby.can.join
                ? t('pickup.invites.notInvited')
                : t('pickup.invites.inviteOnly')}
            </Typography>
          )}
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
              onBan={setBanning}
            />
            <PickupControls lobby={lobby} busy={busy} onCommand={onCommand} />
            <PickupTeamPanel
              lobby={lobby}
              side="b"
              viewerId={viewerId}
              busy={busy}
              onCommand={onCommand}
              onBan={setBanning}
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
            <PickupSubstitute lobby={lobby} busy={busy} onCommand={onCommand} />
            <PickupTeamPanel
              lobby={lobby}
              side={null}
              viewerId={viewerId}
              busy={busy}
              onCommand={onCommand}
              onBan={setBanning}
            />
            <PickupInvites lobby={lobby} busy={busy} onCommand={onCommand} />
            <PickupLog lines={lobby.log} />
          </Box>
          <PickupBanDialog
            player={banning}
            onClose={() => setBanning(null)}
            onBanned={() => {
              setBanning(null);
              reload();
            }}
          />
        </>
      )}
    </>
  );
}
